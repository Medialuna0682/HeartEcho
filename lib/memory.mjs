/**
 * 记忆服务（规划书 06、15.2、15.4）。
 *
 * 六种记忆：消息原文 / 短期窗口 / 情景经历 / 事实偏好 / 关系记忆 / 反思
 * 四类来源：observed（真实发生）/ inferred（模型推断）/ simulated（虚构日常）/ authored（用户手写）
 *
 * 硬约束：
 *   - 每条记忆必须带 owner_character_id、qq_account_id、scope_type、scope_id；群内个体关系还要带 subject_id
 *   - 所有检索先做数据库作用域强过滤，再谈相关度；scope_id 为空一律报错
 *   - 事实冲突不覆盖原文：用 supersedes / superseded_by 建立关系，保留历史时效
 */
import { all, one, run, tx } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { estimateTokens, tokenize, normalizeForMatch, clamp } from "./util.mjs";
import { assertScopeKey, parseScopeKey, ensureSession } from "./storage.mjs";

const log = createLogger("Memory");

export const MEMORY_CATEGORIES = [
  { id: "episodic", label: "经历", hint: "发生过的具体事件：时间、地点、参与者" },
  { id: "fact", label: "事实", hint: "关于对方的客观信息：职业、专业、所在地" },
  { id: "preference", label: "偏好", hint: "喜欢 / 不喜欢，会随时间变化" },
  { id: "agreement", label: "约定", hint: "说好的事、要跟进的事" },
  { id: "relation", label: "关系", hint: "彼此之间的熟悉程度与相处方式" },
  { id: "reflection", label: "反思", hint: "从多次经历里概括出的倾向，需要多条证据" },
];

export const SOURCE_TYPES = [
  { id: "observed", label: "真实发生", hint: "对话或事件里确实出现过的内容" },
  { id: "authored", label: "用户手写", hint: "用户亲手录入或确认的事实" },
  { id: "inferred", label: "模型推断", hint: "从上下文推导出来，必须带不确定性" },
  { id: "simulated", label: "虚构日常", hint: "角色设定内的模拟生活，不得冒充真实互动" },
];

const SENSITIVE_PATTERN = /(密码|口令|身份证|银行卡|信用卡|手机号|住址|家庭住址|api\s?key|token)/i;

/**
 * 「这句话没有话题」——纯对话应答，不含任何可检索内容。
 *
 * 为什么必须单独判：原来的检索是「有查询词就必须命中，命中不了就返回空」。
 * 于是用户说「你说吧」「接着说」「在吗」的时候，整块记忆会被清空，
 * 她连你们刚才在聊什么都想不起来——用户感受到的就是「记忆力很差」。
 * 这类句子本来就没有话题，应该按「重要度 + 新近度」正常取，而不是检索失败。
 */
const FILLER_ONLY =
  /^(嗯+|哦+|啊+|好+|好吧|行|可以|对|是的?|没事|没关系|继续|然后呢|接着说|你说吧|你说就行|你说|说吧|讲讲|讲吧|听着呢|我在听|在吗|在不在|你好|早|晚安|谢谢|辛苦了?|懂了|明白了?|知道啦?|哈哈哈*)$/;

export function isLowInformationQuery(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  const compact = raw.replace(/[\s，,。.…~～!！?？、；;：:「」“”"'（）()]/g, "");
  if (!compact) return true;
  // 「然后呢」「那你说吧」去掉句首连接词后也还是应答词，两种形态都试一遍
  const stripped = compact.replace(/^(那|那么|所以|然后|就|诶|欸|哎)+/g, "") || compact;
  // 只剩纯应答词（嗯 / 好 / 你说吧 / 接着说 …）才算没有话题；
  // 注意不能按「字数少」判——「食堂」「考研」「下雨」都只有两个字，却是实打实的话题。
  if (compact.length <= 8 && FILLER_ONLY.test(compact)) return true;
  if (stripped.length <= 8 && FILLER_ONLY.test(stripped)) return true;
  return false;
}

/* ------------------------------ 倒排索引维护 ------------------------------ */

function indexMemory(memoryId, scopeKey, content) {
  run("delete from memory_tokens where memory_id = ?", [memoryId]);
  for (const token of tokenize(content)) {
    run("insert or ignore into memory_tokens(token, memory_id, scope_key) values(?, ?, ?)", [token, memoryId, scopeKey]);
  }
}

function dedupeKeyOf(category, subjectId, content) {
  return `${category}:${subjectId || "-"}:${normalizeForMatch(content).replace(/\s+/g, "").slice(0, 120)}`;
}

/* -------------------------------- 写入 -------------------------------- */

/**
 * 写入一条记忆。
 * options.supersedes：显式声明它推翻哪条旧记忆。
 * 返回 { id, duplicated, superseded }
 */
export function addMemory({
  scopeKey,
  content,
  category = "episodic",
  sourceType = "observed",
  confidence = 0.7,
  importance = 0.5,
  subjectId = "",
  characterId = "",
  accountId = "",
  supersedesId = null,
  sourceMessageId = null,
  pinned = false,
  at = Date.now(),
}) {
  const key = assertScopeKey(scopeKey);
  const { scopeType, scopeId } = parseScopeKey(key);
  const text = String(content ?? "").trim().slice(0, 600);
  if (!text) return { id: null, duplicated: false, skipped: "内容为空" };
  if (sourceType === "simulated" && !getConfig().life?.simulated?.enabled) {
    return { id: null, duplicated: false, skipped: "虚构日常没开启" };
  }

  return tx(() => {
    const session = ensureSession(key, { characterId, accountId });
    const dedupeKey = dedupeKeyOf(category, subjectId, text);
    const existing = one("select id from memories where scope_key = ? and dedupe_key = ? and status = 'active'", [key, dedupeKey]);
    if (existing) {
      run("update memories set at = ?, updated_at = ? where id = ?", [at, Date.now(), existing.id]);
      return { id: existing.id, duplicated: true, superseded: false };
    }

    // 冲突处理：同类同主体的事实/偏好，若语义高度重叠则把旧记录标为被取代（不删原文）
    let supersedes = Number(supersedesId) || null;
    if (!supersedes && (category === "preference" || category === "fact")) {
      const tokens = new Set(tokenize(text));
      const candidates = all(
        `select m.id, m.content from memories m join memory_tokens t on t.memory_id = m.id
         where m.scope_key = ? and m.category = ? and m.subject_id = ? and m.status = 'active' and t.token in (${[...tokens].slice(0, 12).map(() => "?").join(",") || "''"})
         group by m.id order by count(*) desc limit 5`,
        [key, category, String(subjectId ?? ""), ...[...tokens].slice(0, 12)],
      );
      for (const candidate of candidates) {
        const oldTokens = new Set(tokenize(candidate.content));
        const overlap = [...tokens].filter((token) => oldTokens.has(token)).length;
        const similarity = overlap / Math.max(1, Math.min(tokens.size, oldTokens.size));
        if (similarity >= 0.6 && candidate.content !== text) {
          supersedes = candidate.id;
          break;
        }
      }
    }

    const writeVersion = supersedes
      ? Number(one("select write_version from memories where id = ?", [supersedes])?.write_version ?? 1) + 1
      : 1;

    run(
      `insert into memories(session_id, scope_key, character_id, scope_type, scope_id, subject_id, category, source_type,
         content, confidence, importance, status, pinned, supersedes_id, dedupe_key, write_version, valid_from, at, created_at, updated_at)
       values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        key,
        characterId,
        scopeType,
        scopeId,
        String(subjectId ?? ""),
        category,
        sourceType,
        text,
        clamp(confidence, 0, 1),
        clamp(importance, 0, 1),
        pinned ? 1 : 0,
        supersedes,
        dedupeKey,
        writeVersion,
        at,
        at,
        Date.now(),
        Date.now(),
      ],
    );
    const id = Number(one("select id from memories where scope_key = ? and dedupe_key = ? order by id desc limit 1", [key, dedupeKey])?.id);
    indexMemory(id, key, text);

    if (supersedes) {
      run("update memories set status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ? where id = ?", [
        id,
        at,
        Date.now(),
        supersedes,
      ]);
      log.info(`记忆冲突：新记录 #${id} 取代了 #${supersedes}（保留原文可追溯）`);
    }

    if (sourceMessageId) {
      run("insert into memory_sources(memory_id, message_id, evidence_type, at) values(?, ?, ?, ?)", [
        id,
        Number(sourceMessageId),
        sourceType,
        at,
      ]);
    }

    return { id, duplicated: false, superseded: Boolean(supersedes), supersedesId: supersedes ?? null };
  });
}

/** 手动补一条记忆（面板用，来源标 authored）。 */
export function addManualMemory({ scopeKey, content, category = "fact", subjectId = "", characterId = "", pinned = true }) {
  return addMemory({
    scopeKey,
    content,
    category,
    sourceType: "authored",
    confidence: 1,
    importance: 0.85,
    subjectId,
    characterId,
    pinned,
  });
}

/* -------------------------------- 检索 -------------------------------- */

function candidatesByTokens(scopeKey, tokens, limit) {
  const list = [...new Set(tokens)].slice(0, 16);
  if (!list.length) return [];
  const placeholders = list.map(() => "?").join(",");
  return all(
    `select m.id, m.content, m.category, m.source_type, m.confidence, m.importance, m.at, m.pinned, m.subject_id,
            count(*) as hits
     from memories m join memory_tokens t on t.memory_id = m.id
     where m.scope_key = ? and m.status = 'active' and t.token in (${placeholders})
     group by m.id order by hits desc limit ?`,
    [scopeKey, ...list, limit],
  );
}

function candidatesByLike(scopeKey, query, limit) {
  const value = String(query ?? "").trim().slice(0, 40);
  if (value.length < 2) return [];
  return all(
    `select id, content, category, source_type, confidence, importance, at, pinned, subject_id, 1 as hits
     from memories where scope_key = ? and status = 'active' and content like ?
     order by at desc limit ?`,
    [scopeKey, `%${value}%`, limit],
  );
}

function relevanceOf(row, queryTokens) {
  if (!queryTokens.length) return 0.3;
  const rowTokens = new Set(tokenize(row.content));
  const matched = queryTokens.filter((token) => rowTokens.has(token)).length;
  let score = matched / queryTokens.length;
  if (row.content && normalizeForMatch(row.content).includes(normalizeForMatch(queryTokens.join("")))) score += 0.2;
  if (row.pinned) score += 0.15;
  return clamp(score, 0, 1);
}

function recencyOf(at, now = Date.now()) {
  const ageDays = Math.max(0, (now - Number(at || 0)) / 86400000);
  // 半衰期约 21 天，但保留 0.1 的地板，让「很久以前但重要」的事仍有召回机会
  return clamp(0.1 + 0.9 * Math.exp((-ageDays * Math.LN2) / 21), 0, 1);
}

/**
 * 检索记忆。必须传 scopeKey；函数内部会用 scope_key = ? 做数据库级强过滤。
 * 返回按 score 排序的记忆数组，附可解释的评分明细。
 */
export function retrieveMemories({
  scopeKey,
  query = "",
  subjectId = "",
  limit = 8,
  maxTokens = 900,
  categories = null,
  includeOtherSubjects = false,
  now = Date.now(),
}) {
  const key = assertScopeKey(scopeKey);
  const cfg = getConfig();
  const weights = cfg.memory?.scoreWeights ?? { relevance: 0.4, importance: 0.25, recency: 0.2, confidence: 0.15 };
  const maxCandidates = Math.max(5, Number(cfg.memory?.maxCandidates) || 40);
  const queryTokens = tokenize(query);

  let candidates = candidatesByTokens(key, queryTokens, maxCandidates);
  if (candidates.length < 5 && query) {
    const byLike = candidatesByLike(key, query, maxCandidates);
    const seen = new Set(candidates.map((row) => row.id));
    candidates = [...candidates, ...byLike.filter((row) => !seen.has(row.id))];
  }
  if (!candidates.length) {
    candidates = all(
      `select id, content, category, source_type, confidence, importance, at, pinned, subject_id, 0 as hits
       from memories where scope_key = ? and status = 'active' order by pinned desc, at desc limit ?`,
      [key, maxCandidates],
    );
  }

  // 有话题的查询：与查询毫无关系的记忆不该出现（否则「检索」就退化成「列出全部」）
  // 但「嗯」「你说吧」「接着说」这种没有话题的句子，不能当成「一条都没命中」来处理
  if (queryTokens.length && !isLowInformationQuery(query)) {
    const filtered = candidates.filter((row) => {
      const rowTokens = new Set(tokenize(row.content));
      if (row.pinned) return true;
      return queryTokens.some((token) => rowTokens.has(token)) || normalizeForMatch(row.content).includes(normalizeForMatch(query));
    });
    if (filtered.length) candidates = filtered;
    else candidates = [];
  }

  const scored = [];
  for (const row of candidates) {
    if (categories && !categories.includes(row.category)) continue;
    if (subjectId && !includeOtherSubjects && row.subject_id && row.subject_id !== String(subjectId)) continue;
    const relevance = relevanceOf(row, queryTokens);
    const recency = recencyOf(row.at, now);
    const score =
      Number(weights.relevance) * relevance +
      Number(weights.importance) * clamp(row.importance, 0, 1) +
      Number(weights.recency) * recency +
      Number(weights.confidence) * clamp(row.confidence, 0, 1);
    scored.push({
      id: row.id,
      content: row.content,
      category: row.category,
      sourceType: row.source_type,
      confidence: row.confidence,
      importance: row.importance,
      at: row.at,
      pinned: Boolean(row.pinned),
      subjectId: row.subject_id,
      score: Number(score.toFixed(4)),
      breakdown: { relevance: Number(relevance.toFixed(3)), importance: row.importance, recency: Number(recency.toFixed(3)), confidence: row.confidence },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const out = [];
  let tokens = 0;
  for (const item of scored) {
    const cost = estimateTokens(item.content) + 4;
    if (out.length >= limit) break;
    if (tokens + cost > maxTokens && out.length > 0) break;
    tokens += cost;
    out.push(item);
  }
  return out;
}

/** 拼成可直接塞进提示词的记忆块；同时返回被检索到的记忆 id（供审计）。 */
export function memoryBlock({ scopeKey, query = "", subjectId = "", masterId = 0, masterName = "指挥官", limit = 8 }) {
  const cfg = getConfig();
  if (cfg.memory?.enabled === false) return { block: "", ids: [] };
  const items = retrieveMemories({
    scopeKey,
    query,
    subjectId,
    limit: limit ?? Math.max(1, Number(cfg.memory?.injectFacts) || 12),
  });
  if (!items.length) return { block: "", ids: [] };
  const grouped = new Map();
  for (const item of items) {
    const label = MEMORY_CATEGORIES.find((entry) => entry.id === item.category)?.label ?? item.category;
    const bucket = grouped.get(label) ?? [];
    bucket.push(item);
    grouped.set(label, bucket);
  }
  const lines = [];
  for (const [label, list] of grouped) {
    lines.push(`【你记得的${label}】`);
    for (const item of list) {
      const mark = item.sourceType === "simulated" ? "（你自己设想过的日常）" : item.sourceType === "inferred" ? "（你的感觉，未必准）" : "";
      lines.push(`- ${item.content}${mark}`);
    }
  }
  lines.push("（以上是你自己的记忆，自然地带进对话就好，不要逐条复述，也不要提「记忆」「记录」这些字眼。）");
  return { block: lines.join("\n"), ids: items.map((item) => item.id) };
}

/**
 * 「关于对方的可信事实」——不管这一句是什么都注入。
 *
 * 事实/偏好/约定这类长期内容不该因为用户这句只说了一个「嗯」就从提示词里消失。
 * 只取置顶的那几条（用户手写的、「记住：xxx」记下的），量小、稳定、可信。
 */
export function pinnedFacts({ scopeKey, limit = 8 } = {}) {
  const key = assertScopeKey(scopeKey);
  const rows = all(
    `select content from memories
     where scope_key = ? and status = 'active' and pinned = 1
     order by importance desc, at desc limit ?`,
    [key, Math.max(1, Math.min(30, Number(limit) || 8))],
  );
  return rows.map((row) => String(row.content)).filter(Boolean);
}

/**
 * 修历史数据：早期归档把记忆的 subject_id 写成了**机器人自己的 QQ**。
 *
 * 归档时取的是「这段对话最后一条消息的 sender_id」，而最后一条通常是角色自己发出去的那句，
 * 于是每条情景/事实记忆都挂在了机器人账号下。检索时又按对方 QQ 过滤，
 * 结果就是——存了几十条，一条都进不了提示词。这里把私聊作用域里的这些行改回对方 QQ。
 */
export function repairMemorySubjects({ botId } = {}) {
  const self = String(botId ?? getConfig()?.bot?.selfId ?? "").trim();
  if (!self || self === "0") return { fixed: 0 };
  const rows = all(`select id, scope_key from memories where subject_id = ? and scope_key like 'private\\_%' escape '\\'`, [self]);
  let fixed = 0;
  for (const row of rows) {
    const peer = String(row.scope_key).slice("private_".length);
    if (!peer || peer === self) continue;
    run("update memories set subject_id = ? where id = ?", [peer, row.id]);
    fixed += 1;
  }
  if (fixed) log.info(`已修正 ${fixed} 条记忆的归属（原来记在机器人自己名下，检索永远命中不到）`);
  return { fixed };
}

/* -------------------------------- 管理 -------------------------------- */

export function listMemories({ scopeKey = null, category = null, status = "active", limit = 300 } = {}) {
  const clauses = [];
  const params = [];
  if (scopeKey) {
    clauses.push("scope_key = ?");
    params.push(assertScopeKey(scopeKey));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  return all(`select * from memories ${where} order by pinned desc, at desc limit ?`, [...params, Math.max(1, Number(limit) || 300)]);
}

export function updateMemory(id, patch) {
  const current = one("select * from memories where id = ?", [Number(id)]);
  if (!current) throw new Error("这条记忆不存在");
  const next = { ...current, ...patch };
  run(
    `update memories set content = ?, category = ?, source_type = ?, confidence = ?, importance = ?, pinned = ?, status = ?, updated_at = ?
     where id = ?`,
    [
      String(next.content).slice(0, 600),
      next.category,
      next.source_type,
      clamp(next.confidence, 0, 1),
      clamp(next.importance, 0, 1),
      next.pinned ? 1 : 0,
      next.status,
      Date.now(),
      Number(id),
    ],
  );
  indexMemory(Number(id), current.scope_key, String(next.content));
  return one("select * from memories where id = ?", [Number(id)]);
}

export function deleteMemory(id) {
  const row = one("select * from memories where id = ?", [Number(id)]);
  if (!row) return false;
  tx(() => {
    run("delete from memory_tokens where memory_id = ?", [Number(id)]);
    run("delete from memory_sources where memory_id = ?", [Number(id)]);
    run("delete from memories where id = ?", [Number(id)]);
  });
  return true;
}

/** 用户撤销一条旧偏好：标记为 retracted 而不是物理删除（可追溯）。 */
export function retractMemory(id, { reason = "" } = {}) {
  run("update memories set status = 'retracted', valid_to = ?, updated_at = ? where id = ? and status = 'active'", [
    Date.now(),
    Date.now(),
    Number(id),
  ]);
  log.info(`记忆 #${id} 已被撤回：${reason || "用户手动撤销"}`);
  return one("select * from memories where id = ?", [Number(id)]);
}

export function memoryStats() {
  const rows = all("select category, count(*) as n from memories where status = 'active' group by category");
  const byScope = all(
    "select scope_key, count(*) as n from memories where status = 'active' group by scope_key order by n desc limit 50",
  );
  return {
    total: Number(one("select count(*) as n from memories where status = 'active'")?.n ?? 0),
    byCategory: rows,
    byScope: byScope.map((row) => ({ ...row, label: row.scope_key })),
    superseded: Number(one("select count(*) as n from memories where status = 'superseded'")?.n ?? 0),
    retracted: Number(one("select count(*) as n from memories where status = 'retracted'")?.n ?? 0),
  };
}

/** 手动录入「记住：xxx」的快捷通道。 */
export function rememberQuick({ scopeKey, text, peerId = "", characterId = "" }) {
  const content = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (content.length < 2) return null;
  if (SENSITIVE_PATTERN.test(content)) {
    log.warn("这条内容看起来包含敏感信息，已降低权重但仍会记住（用户主动要求）");
  }
  return addMemory({
    scopeKey,
    content,
    category: "fact",
    sourceType: "authored",
    confidence: 1,
    importance: 0.8,
    subjectId: peerId,
    characterId,
    pinned: true,
  });
}

export { log as memoryLog };
