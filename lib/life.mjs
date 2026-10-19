/**
 * 数字生命与成长机制（规划书 07、15.3、15.4）。
 *
 * 层次：
 *   核心人格（角色卡，只允许用户确认后修改）
 *   动态状态（valence / energy / social_drive，事件驱动 + 随时间衰减）
 *   个人经历（带 scope 与来源，observed / simulated 严格区分）
 *   关系网络（familiarity / trust / affection / tension，每次变化有界）
 *   反思（多源证据 + 置信度，不覆盖原始经历）
 *   目标与计划（待跟进约定、想聊的话题，可解释、可取消）
 *
 * 硬约束：模型无权直接发消息；模型也不能把推测写成事实。
 */
import { scopeGeneration, assertCurrentScope } from "./scope-lifecycle.mjs";
import { all, one, run, tx } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { cleanReply, clamp, dayKey, estimateTokens, formatNow, extractJson } from "./util.mjs";
import {
  addMemory,
  listMemories,
  retrieveMemories,
  memoryBlock,
  memoryStats,
} from "./memory.mjs";
import {
  assertScopeKey,
  parseScopeKey,
  messagesSince,
  messageCount,
  getSession,
  setSummary,
  setArchivedUpto,
  pendingArchiveScopes,
  scopeLabel,
  listSessions,
} from "./storage.mjs";

const log = createLogger("Life");
const MAX_EXPERIENCES = 600;

/* -------------------------------- 动态状态 -------------------------------- */

const STATE_DEFAULTS = { valence: 0.2, energy: 0.7, social_drive: 0.6, interest: "" };

export function getState(characterId) {
  let row = one("select * from life_state where character_id = ?", [characterId]);
  if (!row) {
    run(
      "insert or ignore into life_state(character_id, valence, energy, social_drive, interest, updated_at) values(?, ?, ?, ?, '', ?)",
      [characterId, STATE_DEFAULTS.valence, STATE_DEFAULTS.energy, STATE_DEFAULTS.social_drive, Date.now()],
    );
    row = one("select * from life_state where character_id = ?", [characterId]);
  }
  return row;
}

/** 按经过的时间做衰减（精力恢复、情绪回归中性）。 */
export function decayState(characterId, now = Date.now()) {
  const cfg = getConfig();
  if (cfg.life?.state?.enabled === false) return getState(characterId);
  const row = getState(characterId);
  const hours = Math.max(0, (now - Number(row.updated_at || now)) / 3600000);
  if (hours < 0.05) return row;
  const perHour = Math.max(0, Number(cfg.life?.state?.decayPerHour) || 0.04);
  const factor = Math.min(1, hours * perHour);
  const valence = clamp(Number(row.valence) + (0 - Number(row.valence)) * factor, -1, 1);
  const energy = clamp(Number(row.energy) + (0.75 - Number(row.energy)) * factor, 0, 1);
  const social = clamp(Number(row.social_drive) + (0.5 - Number(row.social_drive)) * factor, 0, 1);
  run("update life_state set valence = ?, energy = ?, social_drive = ?, updated_at = ? where character_id = ?", [
    valence,
    energy,
    social,
    now,
    characterId,
  ]);
  return getState(characterId);
}

/** 事件驱动的状态变化：有界、小幅、不为单条消息剧烈跳变。 */
export function nudgeState(characterId, { valence = 0, energy = 0, socialDrive = 0, interest = undefined } = {}) {
  const row = decayState(characterId);
  const next = {
    valence: clamp(Number(row.valence) + clamp(valence, -0.2, 0.2), -1, 1),
    energy: clamp(Number(row.energy) + clamp(energy, -0.2, 0.2), 0, 1),
    social_drive: clamp(Number(row.social_drive) + clamp(socialDrive, -0.2, 0.2), 0, 1),
    interest: interest === undefined ? row.interest : String(interest).slice(0, 120),
  };
  run("update life_state set valence = ?, energy = ?, social_drive = ?, interest = ?, updated_at = ? where character_id = ?", [
    next.valence,
    next.energy,
    next.social_drive,
    next.interest,
    Date.now(),
    characterId,
  ]);
  return getState(characterId);
}

export function stateLabel(state) {
  const mood = Number(state.valence);
  const label = mood > 0.45 ? "心情很好" : mood > 0.1 ? "心情不错" : mood > -0.15 ? "平静" : mood > -0.45 ? "有点低落" : "心情不好";
  const energy = Number(state.energy);
  const energyLabel = energy > 0.7 ? "精神充沛" : energy > 0.4 ? "还行" : "有点累";
  return { mood: label, energy: energyLabel };
}

/* -------------------------------- 关系演化 -------------------------------- */

const RELATION_DEFAULTS = { familiarity: 0, trust: 0.5, affection: 0, tension: 0 };

export function getRelationship({ characterId, accountId = "", contextId = "", subjectId = "" }) {
  let row = one(
    "select * from relationships where character_id = ? and account_id = ? and context_id = ? and subject_id = ?",
    [characterId, String(accountId), String(contextId), String(subjectId)],
  );
  if (!row) {
    run(
      `insert or ignore into relationships(character_id, account_id, context_id, subject_id, familiarity, trust, affection, tension, updated_at)
       values(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        characterId,
        String(accountId),
        String(contextId),
        String(subjectId),
        RELATION_DEFAULTS.familiarity,
        RELATION_DEFAULTS.trust,
        RELATION_DEFAULTS.affection,
        RELATION_DEFAULTS.tension,
        Date.now(),
      ],
    );
    row = one(
      "select * from relationships where character_id = ? and account_id = ? and context_id = ? and subject_id = ?",
      [characterId, String(accountId), String(contextId), String(subjectId)],
    );
  }
  return row;
}

/**
 * 关系更新：单次变化被限制在 maxDeltaPerEvent 内，并对长期状态做指数滑动平均。
 * 返回 { before, after, delta }。
 */
export function updateRelationship({ characterId, accountId = "", contextId = "", subjectId = "", delta = {} }) {
  const cfg = getConfig();
  if (cfg.life?.relationship?.enabled === false) return null;
  const maxDelta = Math.max(0.001, Number(cfg.life?.relationship?.maxDeltaPerEvent) || 0.05);
  const smoothing = clamp(cfg.life?.relationship?.smoothing ?? 0.3, 0.05, 1);
  const before = getRelationship({ characterId, accountId, contextId, subjectId });
  const bound = (value) => clamp(Number(value) || 0, -maxDelta, maxDelta);
  const next = {
    familiarity: clamp(Number(before.familiarity) + bound(delta.familiarity), 0, 1),
    trust: clamp(Number(before.trust) + bound(delta.trust), 0, 1),
    affection: clamp(Number(before.affection) + bound(delta.affection), -1, 1),
    tension: clamp(Number(before.tension) + bound(delta.tension), 0, 1),
  };
  const blended = {
    familiarity: Number(before.familiarity) * (1 - smoothing) + next.familiarity * smoothing,
    trust: Number(before.trust) * (1 - smoothing) + next.trust * smoothing,
    affection: Number(before.affection) * (1 - smoothing) + next.affection * smoothing,
    tension: Number(before.tension) * (1 - smoothing) + next.tension * smoothing,
  };
  run(
    "update relationships set familiarity = ?, trust = ?, affection = ?, tension = ?, updated_at = ? where id = ?",
    [blended.familiarity, blended.trust, blended.affection, blended.tension, Date.now(), before.id],
  );
  const after = getRelationship({ characterId, accountId, contextId, subjectId });
  return {
    before,
    after,
    delta: {
      familiarity: Number((after.familiarity - before.familiarity).toFixed(4)),
      trust: Number((after.trust - before.trust).toFixed(4)),
      affection: Number((after.affection - before.affection).toFixed(4)),
      tension: Number((after.tension - before.tension).toFixed(4)),
    },
  };
}

export function relationshipText({ characterId, accountId = "", contextId = "", subjectId = "" }) {
  const row = getRelationship({ characterId, accountId, contextId, subjectId });
  const parts = [];
  if (Number(row.familiarity) > 0.6) parts.push("你们已经很熟了");
  else if (Number(row.familiarity) > 0.3) parts.push("你们渐渐熟起来");
  else if (Number(row.familiarity) > 0.1) parts.push("你们还不算太熟");
  else parts.push("你们刚认识不久");
  if (Number(row.affection) > 0.5) parts.push("你很依赖、也很喜欢对方");
  else if (Number(row.affection) > 0.2) parts.push("你对对方有明显的好感");
  if (Number(row.tension) > 0.4) parts.push("你们之间还有点别扭没解开");
  if (Number(row.trust) < 0.35) parts.push("你还没完全信任对方");
  return parts.join("；");
}

/* -------------------------------- 目标与计划 -------------------------------- */

export function addGoal({ characterId, scopeKey, kind = "topic", content, dueAt = null }) {
  const key = assertScopeKey(scopeKey);
  const text = String(content ?? "").trim().slice(0, 200);
  if (!text) return null;
  const existing = one("select * from goals where scope_key = ? and content = ? and status = 'pending'", [key, text]);
  if (existing) return existing;
  run("insert into goals(character_id, scope_key, kind, content, status, due_at, at, updated_at) values(?, ?, ?, ?, 'pending', ?, ?, ?)", [
    characterId,
    key,
    kind,
    text,
    dueAt,
    Date.now(),
    Date.now(),
  ]);
  return one("select * from goals where scope_key = ? and content = ? order by id desc limit 1", [key, text]);
}

export function listGoals({ scopeKey = null, status = "pending" } = {}) {
  if (scopeKey) {
    return all("select * from goals where scope_key = ? and status = ? order by due_at is null, due_at asc, at desc", [
      assertScopeKey(scopeKey),
      status,
    ]);
  }
  return all("select * from goals where status = ? order by due_at is null, due_at asc, at desc limit 200", [status]);
}

export function closeGoal(id, { status = "done" } = {}) {
  run("update goals set status = ?, updated_at = ? where id = ?", [status, Date.now(), Number(id)]);
}

/* -------------------------------- 归档与经历 -------------------------------- */

export function listExperiences({ characterId, scopeKey = null, limit = 200 } = {}) {
  const params = [characterId];
  let where = "character_id = ? and category = 'episodic' and source_type <> 'reflection'";
  if (scopeKey) {
    where += " and scope_key = ?";
    params.push(assertScopeKey(scopeKey));
  }
  return all(`select * from memories where ${where} order by at desc limit ?`, [...params, Math.max(1, Number(limit) || 200)]);
}

export function listReflections({ characterId, scopeKey = null, limit = 100 } = {}) {
  const params = [characterId];
  let where = "character_id = ?";
  if (scopeKey) {
    where += " and scope_key = ?";
    params.push(assertScopeKey(scopeKey));
  }
  return all(`select * from reflections where ${where} order by at desc limit ?`, [...params, Math.max(1, Number(limit) || 100)]);
}

/**
 * 归档一个会话：摘要写回会话、经历写入记忆（带 scope 与来源）。
 * 使用严格 JSON 结构化输出；解析失败只重试一次，不写任何脏数据。
 */
export async function archiveScope({ llm, scopeKey, character, masterId = 0, masterName = "指挥官", accountId = "" }) {
  const key = assertScopeKey(scopeKey);
  const generation = scopeGeneration(key);
  const cfg = getConfig();
  const session = getSession(key);
  const from = Number(session?.archived_upto ?? 0);
  const messages = messagesSince(key, from, 200);
  if (!messages.length) return null;

  const transcript = messages
    .slice(-80)
    .map((m) => `${m.direction === "out" ? character.name : "对方"}：${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");

  const label = scopeLabel(key, { masterId, masterName });
  const previous = session?.summary ?? "";
  const known = listMemories({ scopeKey: key, limit: 20 })
    .filter((row) => row.category === "fact" || row.category === "preference")
    .map((row) => `- ${row.content}`)
    .join("\n");

  const system = [
    `你在替角色「${character.name}」整理自己的记忆。对象是：${label}。`,
    "只总结这一段对话，不要把别处的事混进来；不要编造对话里没有的事实。",
    "输出严格的 JSON（不要 markdown 代码块），字段如下：",
    `{"summary":"80 字以内，说明你们的关系、最近在聊什么、有没有要记住的事",`,
    ` "experiences":[{"text":"第一人称、40 字以内、写发生了什么和你的感受","importance":0.5}],`,
    ` "facts":[{"text":"关于对方的客观信息","category":"fact|preference|agreement","confidence":0.8,"importance":0.6}]}`,
    "experiences 最多 3 条，宁少勿多；facts 最多 3 条，没有就给空数组。",
    "不确定的内容不要写进 facts；情绪化的一句话不要当成长期偏好。",
  ].join("\n");

  const user = [
    previous ? `【之前的摘要】\n${previous}` : "",
    known ? `【你已经知道的事】\n${known}` : "",
    `【这次的对话】\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await llm.json(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { task: "summary", characterId: character.id, scopeKey: key, schemaHint: "summary / experiences / facts" },
  );

  return tx(() => {
    assertCurrentScope(key, generation);
    const payload = result.json ?? {};
    const summary = cleanReply(String(payload.summary ?? "")).replace(/\s+/g, " ").slice(0, Number(cfg.memory?.summaryMaxChars) || 300);
    const experiences = (Array.isArray(payload.experiences) ? payload.experiences : [])
      .map((item) => (typeof item === "string" ? { text: item } : item))
      .filter((item) => item?.text && String(item.text).trim().length >= 4)
      .slice(0, Math.max(1, Number(cfg.life?.archive?.maxEntriesPerRun) || 3));
    const facts = (Array.isArray(payload.facts) ? payload.facts : [])
      .map((item) => (typeof item === "string" ? { text: item, category: "fact" } : item))
      .filter((item) => item?.text && String(item.text).trim().length >= 3)
      .slice(0, 3);

    const now = Date.now();
    const created = { experiences: [], facts: [] };

    /*
     * 记忆挂在谁名下？
     *
     * 以前这里取的是「这段对话最后一条消息的 sender_id」，而最后一条通常是角色自己刚发出去的那句，
     * 于是每条记忆的 subject_id 都变成了**机器人自己的 QQ**。
     * 检索时又按「对方 QQ」过滤，结果存了几十条却一条都进不了提示词——
     * 用户那边的体感就是「她完全记不住」。
     * 现在按作用域取：私聊就是对方，群聊取最后一个开口的真人。
     */
    const subjectOf = (() => {
      const parsed = parseScopeKey(key);
      if (parsed?.scopeType === "private") return String(parsed.scopeId || "");
      if (parsed?.subjectId) return String(parsed.subjectId);
      const incoming = [...messages].reverse().find((m) => m.direction !== "out" && m.sender_id);
      return String(incoming?.sender_id ?? "");
    })();

    for (const item of experiences) {
      const added = addMemory({
        scopeKey: key,
        content: cleanReply(String(item.text)),
        category: "episodic",
        sourceType: "observed",
        confidence: 0.85,
        importance: clamp(item.importance ?? 0.6, 0, 1),
        subjectId: subjectOf,
        characterId: character.id,
        accountId,
        at: now,
        sourceMessageId: messages[messages.length - 1]?.id ?? null,
      });
      if (added?.id) created.experiences.push(added.id);
    }

    for (const item of facts) {
      const category = ["fact", "preference", "agreement", "relation"].includes(item.category) ? item.category : "fact";
      const added = addMemory({
        scopeKey: key,
        content: cleanReply(String(item.text)),
        category,
        sourceType: "observed",
        confidence: clamp(item.confidence ?? 0.75, 0, 1),
        importance: clamp(item.importance ?? 0.6, 0, 1),
        subjectId: subjectOf,
        characterId: character.id,
        accountId,
        at: now,
      });
      if (added?.id) created.facts.push(added.id);
    }

    if (summary) setSummary(key, summary, { uptoIndex: messageCount(key) });
    setArchivedUpto(key, messageCount(key));

    log.info(`归档完成 ${key}`, {
      messages: messages.length,
      experiences: created.experiences.length,
      facts: created.facts.length,
    });

    return {
      scopeKey: key,
      label,
      summary,
      experiences: created.experiences.length,
      facts: created.facts.length,
      messages: messages.length,
      raw: result.text,
    };
  });
}

export async function archiveOnce({ llm, character, masterId = 0, masterName = "指挥官", force = false, limit = 3, scopeKey = null, onProgress = null }) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const cfg = getConfig();
  if (cfg.life?.enabled === false) return { skipped: true, reason: "数字生命功能关着", results: [], summary: "数字生命功能关着，没做" };
  const pending = scopeKey
    ? [{ scope_key: assertScopeKey(scopeKey), pending: 0 }]
    : pendingArchiveScopes({ minNewMessages: force ? 2 : Number(cfg.life?.archive?.minNewMessages) || 12 });
  if (!pending.length) {
    report("没有需要归档的会话");
    return { skipped: true, reason: "没有需要归档的会话", results: [], summary: "没有需要归档的会话" };
  }
  const todo = pending.slice(0, Math.max(1, Number(limit) || 3));
  report(`要归档 ${todo.length} 个会话`);

  const results = [];
  let index = 0;
  for (const item of todo) {
    index += 1;
    const label = scopeLabel(item.scope_key, { masterId, masterName });
    report(`正在整理「${label}」（${index}/${todo.length}）…`);
    try {
      const result = await archiveScope({ llm, scopeKey: item.scope_key, character, masterId, masterName });
      if (result) {
        results.push(result);
        report(`「${result.label}」存下了 ${result.experiences} 条经历、${result.facts} 条事实`);
      } else {
        report(`「${label}」没有新内容，跳过`);
      }
    } catch (error) {
      log.warn(`归档 ${item.scope_key} 失败：${error?.message ?? error}`);
    }
  }
  return {
    skipped: false,
    results,
    pending: pending.length,
    summary: results.length
      ? `归档完成：${results.map((row) => `${row.label}（${row.experiences} 条经历 / ${row.facts} 条事实）`).join("，")}`
      : "没有会话归档成功",
  };
}

/* -------------------------------- 反思 -------------------------------- */

/**
 * 反思：需要多条证据。证据不足时不输出定性结论（规划书 FR-402）。
 */
export async function reflect({ llm, character, scopeKey, masterId = 0, masterName = "指挥官", onProgress = null }) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const cfg = getConfig();
  if (cfg.life?.reflection?.enabled === false) return { skipped: true, reason: "反思功能关着", summary: "反思功能关着" };
  const key = assertScopeKey(scopeKey);
  const generation = scopeGeneration(key);
  const minEvidence = Math.max(2, Number(cfg.life?.reflection?.minEvidence) || 3);
  const since = Date.now() - 30 * 86400000;
  const experiences = all(
    `select * from memories where scope_key = ? and category in ('episodic','fact','preference','agreement')
       and status = 'active' and source_type in ('observed','authored') and at >= ? order by at desc limit 40`,
    [key, since],
  );
  if (experiences.length < minEvidence) {
    report(`可信经历只有 ${experiences.length} 条，不足 ${minEvidence} 条，先不下结论`);
    return { skipped: true, reason: `可信经历只有 ${experiences.length} 条，不足 ${minEvidence} 条，先不急着下结论`, summary: "经历太少，先不反思" };
  }
  report(`有 ${experiences.length} 条经历可以依据，正在让她想一想…`);
  const existing = listReflections({ characterId: character.id, scopeKey: key, limit: 10 });
  const material = experiences
    .slice(0, 30)
    .map((row) => `- [${row.category}｜${new Date(row.at).toLocaleDateString("zh-CN")}] ${row.content}`)
    .join("\n");
  const system = [
    `你在替角色「${character.name}」做自我反思。对象是 ${scopeLabel(key, { masterId, masterName })}。`,
    "只根据给出的经历做概括，不要引入任何经历之外的信息，不要编造。",
    '输出严格 JSON：{"reflections":[{"text":"第一人称，40 字以内，例如「我注意到他最近总是很晚才睡」","confidence":0.6,"evidence":[经历前面的序号]}]}',
    "最多 2 条；如果证据不足以下结论，就输出空数组。",
  ].join("\n");
  const indexed = experiences.slice(0, 30).map((row, index) => `${index + 1}. ${row.content}`).join("\n");
  const result = await llm.json(
    [
      { role: "system", content: system },
      { role: "user", content: `【可以依据的经历（带序号）】\n${indexed}` },
    ],
    { task: "reflection", characterId: character.id, scopeKey: key, schemaHint: "reflections 数组" },
  );
  return tx(() => {
    assertCurrentScope(key, generation);
    const items = (Array.isArray(result.json?.reflections) ? result.json.reflections : [])
      .filter((item) => item?.text && String(item.text).trim().length >= 4)
      .slice(0, Math.max(1, Number(cfg.life?.reflection?.maxPerRun) || 2));

    const created = [];
    for (const item of items) {
      const text = cleanReply(String(item.text));
      if (existing.some((row) => row.content === text)) continue;
      const evidenceIds = (Array.isArray(item.evidence) ? item.evidence : [])
        .map((index) => experiences[Number(index) - 1]?.id)
        .filter(Boolean);
      if (evidenceIds.length < minEvidence) {
        log.debug(`反思证据不足被丢弃：${text}`);
        continue;
      }
      run(
        `insert into reflections(character_id, scope_key, source_type, content, evidence_count, confidence, source_memories_json, at, created_at)
         values(?, ?, 'inferred', ?, ?, ?, ?, ?, ?)`,
        [
          character.id,
          key,
          text,
          evidenceIds.length,
          clamp(item.confidence ?? 0.5, 0, 1),
          JSON.stringify(evidenceIds),
          Date.now(),
          Date.now(),
        ],
      );
      const id = Number(one("select id from reflections where scope_key = ? order by id desc limit 1", [key])?.id);
      addMemory({
        scopeKey: key,
        content: text,
        category: "reflection",
        sourceType: "inferred",
        confidence: clamp(item.confidence ?? 0.5, 0, 1),
        importance: 0.7,
        characterId: character.id,
        at: Date.now(),
      });
      created.push({ id, text, evidence: evidenceIds.length });
    }
    return {
      skipped: false,
      created,
      materialCount: experiences.length,
      summary: created.length ? `形成了 ${created.length} 条反思` : "这次没形成新的反思（证据不够，或和已有的重复）",
    };
  });
}

/* -------------------------------- 日记 -------------------------------- */

export async function writeDiary({ llm, character, scopeKey = null, masterId = 0, masterName = "指挥官", force = false, date = new Date(), onProgress = null }) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const cfg = getConfig();
  if (cfg.life?.diary?.enabled === false && !force) return { skipped: true, reason: "日记关着", summary: "日记功能关着" };
  const key = scopeKey ? assertScopeKey(scopeKey) : `diary_${character.id}_${dayKey(date)}`;
  const today = dayKey(date);
  const existing = one(
    "select * from memories where scope_key = ? and category = 'episodic' and source_type = 'simulated' and content like ?",
    [key, `%[日记 ${today}]%`],
  );
  if (existing && !force) return { skipped: true, reason: "今天已经写过日记了", summary: "今天已经写过了" };

  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const experiences = all(
    `select * from memories where category = 'episodic' and status = 'active' and at >= ? and at < ? order by at asc limit 60`,
    [dayStart, dayStart + 86400000],
  );
  const reflections = all("select * from reflections where at >= ? order by at desc limit 10", [dayStart - 3 * 86400000]);
  const generations = new Map([key, ...experiences.map((row) => row.scope_key), ...reflections.map((row) => row.scope_key)]
    .map((scope) => [scope, scopeGeneration(scope)]));
  if (!experiences.length && !reflections.length) {
    report("今天还没有新的经历，这次不写");
    return { skipped: true, reason: "今天还没有新的经历，日记先不写", summary: "今天没有新经历，没写" };
  }
  report(`翻出今天 ${experiences.length} 条经历、${reflections.length} 条反思，正在写…`);
  const material = [
    experiences.length ? `【今天的经历】\n${experiences.map((row) => `- ${row.content}`).join("\n")}` : "",
    reflections.length ? `【最近的自我反思】\n${reflections.map((row) => `- ${row.content}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await llm.chat(
    [
      {
        role: "system",
        content: [
          `你在替角色「${character.name}」写今天的日记。`,
          "用第一人称，200~300 字，像给自己看的随笔：今天做了什么、和谁说话让你记挂、明天想做点什么。",
          "语气温柔认真，带一点克制。不要写成流水账，不要罗列时间线。",
          "不要写别人的隐私细节，提到人时用模糊称呼；不要编造没有发生过的事。",
        ].join("\n"),
      },
      { role: "user", content: material },
    ],
    /*
     * maxTokens 不能给小：思考型模型会先把额度花在 reasoning_content 上，
     * 900 个 token 连「想」都不够，正文一个字都写不出来，
     * 用户看到的就是「模型返回空内容」。给足之后不再出现。
     */
    { task: "reflection", characterId: character.id, scopeKey: key, scopeGenerations: [...generations].map(([scopeKey, generation]) => ({ scopeKey, generation })), overrides: { maxTokens: 4096, temperature: 1 } },
  );
  return tx(() => {
    for (const [scope, generation] of generations) assertCurrentScope(scope, generation);
    const text = cleanReply(result.text).slice(0, 1200);
    if (!text) {
      report("模型这次没有写出正文，日记没保存");
      return { skipped: true, reason: "模型返回空内容", summary: "模型没写出正文，日记没保存" };
    }

    const added = addMemory({
      scopeKey: key,
      content: `[日记 ${today}] ${text}`,
      category: "episodic",
      sourceType: "simulated",
      confidence: 0.9,
      importance: 0.5,
      characterId: character.id,
      at: Date.now(),
    });

    const keepDays = Math.max(7, Number(cfg.life?.diary?.keepDays) || 90);
    const cutoff = Date.now() - keepDays * 86400000;
    run("delete from memories where scope_key = ? and content like '[日记 %' and at < ?", [key, cutoff]);

    report(`写完并保存了（${text.length} 字）`);
    return { skipped: false, date: today, text, memoryId: added?.id ?? null, summary: `日记写好了（${text.length} 字）` };
  });
}

export function listDiary({ characterId, limit = 30 }) {
  return all(
    `select * from memories where category = 'episodic' and content like '[日记 %' and status = 'active'
     order by at desc limit ?`,
    [Math.max(1, Number(limit) || 30)],
  );
}

/* -------------------------------- 提示词注入 -------------------------------- */

/**
 * 组装「她自己知道的事」：本作用域的摘要 + 相关经历 + 最近反思 + 日记 + 关系。
 * 严格只用 scopeKey 范围内的数据，跨作用域一律拿不到（规划书 FR-302）。
 */
export function contextFor({ characterId, scopeKey, query = "", subjectId = "", masterId = 0, masterName = "指挥官", accountId = "" }) {
  const cfg = getConfig();
  const key = assertScopeKey(scopeKey);
  const session = getSession(key);
  const out = { summary: "", memoryBlock: "", ids: [], relationship: "", state: null, goals: [] };

  if (cfg.memory?.injectSummary !== false && session?.summary) out.summary = session.summary;

  const block = memoryBlock({ scopeKey: key, query, subjectId, masterId, masterName });
  out.memoryBlock = block.block;
  out.ids = block.ids;

  out.relationship = relationshipText({ characterId, accountId, contextId: key, subjectId: subjectId || "*" });
  out.state = stateLabel(decayState(characterId));
  out.goals = listGoals({ scopeKey: key }).slice(0, 5);
  return out;
}

export function promptBlock({ characterId, scopeKey, query = "", subjectId = "", masterId = 0, masterName = "指挥官", accountId = "" }) {
  const ctx = contextFor({ characterId, scopeKey, query, subjectId, masterId, masterName, accountId });
  const lines = [];
  if (ctx.summary) lines.push(`【你们之前的相处（摘要）】\n${ctx.summary}`);
  if (ctx.memoryBlock) lines.push(ctx.memoryBlock);
  if (ctx.relationship) lines.push(`【你此刻对这段关系的感受】${ctx.relationship}`);
  if (ctx.state) lines.push(`【你自己的状态】现在是${ctx.state.mood}，${ctx.state.energy}。`);
  if (ctx.goals.length) {
    lines.push(`【你惦记着的事】\n${ctx.goals.map((goal) => `- ${goal.content}`).join("\n")}`);
  }
  return { block: lines.join("\n\n"), ids: ctx.ids, context: ctx };
}

/* -------------------------------- 快照（面板） -------------------------------- */

export function lifeSnapshot({ characterId, masterId = 0, masterName = "指挥官" }) {
  const cfg = getConfig();
  const state = decayState(characterId);
  const experiences = listExperiences({ characterId, limit: 60 });
  const reflections = listReflections({ characterId, limit: 30 });
  const diary = listDiary({ characterId, limit: 10 });
  const relationships = all(
    "select * from relationships where character_id = ? order by updated_at desc limit 40",
    [characterId],
  ).map((row) => ({ ...row, label: scopeLabel(row.context_id, { masterId, masterName }) }));
  return {
    enabled: cfg.life?.enabled !== false,
    state: { ...state, label: stateLabel(state) },
    experiences: experiences.map((row) => ({ ...row, label: scopeLabel(row.scope_key, { masterId, masterName }) })),
    reflections: reflections.map((row) => ({ ...row, label: scopeLabel(row.scope_key, { masterId, masterName }) })),
    diary: diary.map((row) => ({ ...row, date: (/(\[日记 ([\d-]+)\])/.exec(row.content) ?? [])[2] ?? "" })),
    relationships,
    goals: listGoals({ status: "pending" }).slice(0, 40).map((row) => ({ ...row, label: scopeLabel(row.scope_key, { masterId, masterName }) })),
    sessions: listSessions({ limit: 60 }).map((row) => ({ ...row, label: scopeLabel(row.scope_key, { masterId, masterName }) })),
    memory: memoryStats(),
    simulatedEnabled: cfg.life?.simulated?.enabled === true,
  };
}

/** 模拟生活：明确标记 simulated，永远不冒充真实互动。 */
export function addSimulatedExperience({ characterId, scopeKey, content }) {
  const cfg = getConfig();
  if (cfg.life?.simulated?.enabled !== true) throw new Error("虚构日常没开启（面板「数字生命」里可以打开）");
  return addMemory({
    scopeKey: assertScopeKey(scopeKey),
    content,
    category: "episodic",
    sourceType: "simulated",
    confidence: 0.9,
    importance: 0.35,
    characterId,
  });
}

export { estimateTokens, formatNow, extractJson };
