/**
 * 规则引擎 / Policy Gate（规划书 05、15.1、3.3）。
 *
 * 自动化行为优先级（硬性，低优先级永远不能覆盖高优先级）：
 *   用户手动暂停 > 全局黑名单与合规拦截 > 群级策略 > 用户级策略 > 预算与冷却 > 主动行为意图 > 模型生成偏好
 *
 * 三条验收红线：
 *   1. 黑名单命中的消息：出站消息数 = 0，付费模型调用数 = 0
 *   2. 屏蔽词计数按 (规则, 消息) 去重，同一条消息重复投递不重复计数
 *   3. 所有判定都要给出可解释理由（面板能回答「为什么回 / 为什么没回」）
 */
import { all, one, run, tx, audit } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { normalizeForMatch, dayKey, clamp } from "./util.mjs";
import { resolveMemberPolicy } from "./storage.mjs";

const log = createLogger("Policy");

const HOUR = 3600000;
const DAY = 86400000;

export const ACTION = {
  REPLY: "reply",
  WARN: "warn",
  SILENT: "silent",
  SKIP: "skip",
};

/** 全局暂停开关（面板「一键暂停」），最高优先级。 */
class PauseState {
  constructor() {
    this.paused = false;
    this.reason = "";
    this.at = 0;
  }
  set(paused, reason = "") {
    this.paused = Boolean(paused);
    this.reason = reason;
    this.at = Date.now();
    audit({ eventType: paused ? "automation_paused" : "automation_resumed", actor: "panel", reason });
    return this.snapshot();
  }
  snapshot() {
    return { paused: this.paused, reason: this.reason, at: this.at };
  }
}

export const pauseState = new PauseState();

/* ------------------------------- 黑名单（三层） ------------------------------- */

export function blockPeer({ scopeKind, scopeId = "*", peerId, reason = "", word = "", by = "manual", warnCount = 0 }) {
  run(
    `insert into blocklist(scope_kind, scope_id, peer_id, reason, word, by, warn_count, at)
     values(?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(scope_kind, scope_id, peer_id) do update set
       reason = excluded.reason, word = excluded.word, by = excluded.by, warn_count = excluded.warn_count, at = excluded.at`,
    [scopeKind, String(scopeId ?? "*"), String(peerId), reason, word, by, Number(warnCount) || 0, Date.now()],
  );
  audit({ eventType: "blocklist_add", scopeKey: `${scopeKind}:${scopeId}:${peerId}`, actor: by, reason, detail: { word } });
  log.info(`已拉黑 ${scopeKind}/${scopeId}/${peerId}${word ? `（命中「${word}」）` : ""}`);
}

export function unblockPeer({ scopeKind, scopeId = "*", peerId, by = "manual", clearWarnings = true }) {
  run("delete from blocklist where scope_kind = ? and scope_id = ? and peer_id = ?", [
    scopeKind,
    String(scopeId ?? "*"),
    String(peerId),
  ]);
  if (clearWarnings) {
    run("delete from warn_counts where scope_key = ? and peer_id = ?", [`${scopeKind}:${scopeId}`, String(peerId)]);
  }
  audit({ eventType: "blocklist_remove", scopeKey: `${scopeKind}:${scopeId}:${peerId}`, actor: by });
}

export function checkBlocked({ kind, groupId, peerId, characterId = "" }) {
  const checks = [
    { scopeKind: "global", scopeId: "*" },
    ...(kind === "group" ? [{ scopeKind: "group", scopeId: String(groupId) }] : []),
    { scopeKind: "character", scopeId: String(characterId || "*") },
  ];
  for (const { scopeKind, scopeId } of checks) {
    const row = one("select * from blocklist where scope_kind = ? and scope_id = ? and peer_id = ?", [
      scopeKind,
      scopeId,
      String(peerId),
    ]);
    if (row) return { blocked: true, layer: scopeKind, row };
  }
  return { blocked: false };
}
export function listBlocklist() {
  return all("select * from blocklist order by at desc");
}

/* ------------------------------- 屏蔽词 ------------------------------- */

export function hitFilter(text) {
  const cfg = getConfig();
  const filter = cfg.group?.filter ?? {};
  if (filter.enabled === false) return null;
  const raw = String(text ?? "");
  if (!raw) return null;
  const value = normalizeForMatch(raw);
  for (const word of filter.words ?? []) {
    const target = String(word ?? "").trim();
    if (!target) continue;
    if (value.includes(normalizeForMatch(target))) return { ruleId: `word:${target}`, word: target, ruleType: "word" };
  }
  for (const pattern of filter.regex ?? []) {
    const source = String(pattern ?? "").trim();
    if (!source) continue;
    try {
      if (new RegExp(source, "iu").test(raw)) return { ruleId: `regex:${source}`, word: source, ruleType: "regex" };
    } catch {
      /* 用户写错的正则忽略，不让它拖垮整条链路 */
    }
  }
  return null;
}

/* ------------------------------- 警告计数 ------------------------------- */

function loadWarn(scopeKey, peerId, ruleId) {
  return one("select * from warn_counts where scope_key = ? and peer_id = ? and rule_id = ?", [
    scopeKey,
    String(peerId),
    ruleId,
  ]);
}

function saveWarn(row) {
  run(
    `insert into warn_counts(scope_key, peer_id, rule_id, count, day_count, day_key, window_json, last_at, last_word, muted_until)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(scope_key, peer_id, rule_id) do update set
       count = excluded.count, day_count = excluded.day_count, day_key = excluded.day_key,
       window_json = excluded.window_json, last_at = excluded.last_at, last_word = excluded.last_word,
       muted_until = excluded.muted_until`,
    [
      row.scope_key,
      row.peer_id,
      row.rule_id,
      row.count,
      row.day_count,
      row.day_key,
      row.window_json,
      row.last_at,
      row.last_word,
      row.muted_until,
    ],
  );
}

/**
 * 屏蔽词状态机。必须传入 eventKey（消息 ID），用于「同一条消息不重复计数」。
 * 返回 { state: 0|1|2, count, willBlock, cooldown }。
 */
export function bumpWarning({ scopeKey, peerId, ruleId, ruleType = "word", word = "", eventKey }) {
  const cfg = getConfig();
  const filter = cfg.group?.filter ?? {};
  const policy = String(filter.countPolicy ?? "permanent");
  const maxWarnings = Math.max(0, Number(filter.maxWarnings) || 0);
  const action = String(filter.action ?? "warn_then_block");

  return tx(() => {
    // (规则, 消息) 唯一：重复投递不计第二次
    if (eventKey) {
      const existing = one("select id from moderation_events where rule_id = ? and event_key = ?", [ruleId, eventKey]);
      if (existing) {
        const current = loadWarn(scopeKey, peerId, ruleId);
        return {
          duplicated: true,
          count: Number(current?.count ?? 0),
          willBlock: false,
          cooldown: false,
          action: "skip",
        };
      }
    }

    const today = dayKey();
    const now = Date.now();
    const current = loadWarn(scopeKey, peerId, ruleId) ?? {
      scope_key: scopeKey,
      peer_id: String(peerId),
      rule_id: ruleId,
      count: 0,
      day_count: 0,
      day_key: today,
      window_json: "[]",
      last_at: 0,
      last_word: "",
      muted_until: 0,
    };

    let effective;
    if (policy === "daily") {
      effective = current.day_key === today ? Number(current.day_count) : 0;
    } else if (policy === "rolling") {
      const windowMs = Math.max(1, Number(filter.countWindowHours) || 24) * HOUR;
      const window = JSON.parse(current.window_json || "[]").filter((at) => now - at < windowMs);
      current.window_json = JSON.stringify([...window, now]);
      effective = window.length;
    } else {
      const window = JSON.parse(current.window_json || "[]");
      current.window_json = JSON.stringify([...window.slice(-49), now]);
      effective = Number(current.count);
    }

    const willBlock = action === "block_now" || (action === "warn_then_block" && effective >= maxWarnings);
    const cooldownMs = Math.max(0, Number(filter.warnCooldownMinutes) || 0) * 60000;
    const inCooldown = !willBlock && current.last_at && now - current.last_at < cooldownMs;

    current.count = Number(current.count) + 1;
    if (current.day_key !== today) {
      current.day_key = today;
      current.day_count = 1;
    } else {
      current.day_count = Number(current.day_count) + 1;
    }
    current.last_at = now;
    current.last_word = word;

    const effectiveNext = effective + 1;
    if (action === "warn_then_block" && effectiveNext >= maxWarnings) {
      current.muted_until = 0;
    } else if (inCooldown) {
      current.muted_until = current.last_at + cooldownMs;
    }
    saveWarn(current);

    run(
      `insert or ignore into moderation_events(rule_id, rule_type, scope_key, actor_id, event_key, count_delta, action, detail, at)
       values(?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [ruleId, ruleType, scopeKey, String(peerId), eventKey ?? "", willBlock ? "block" : inCooldown ? "cooldown" : "warn", word, now],
    );

    return {
      duplicated: false,
      count: current.count,
      effective: effectiveNext,
      willBlock,
      cooldown: inCooldown,
      action: willBlock ? "block" : inCooldown ? "cooldown" : "warn",
      warnCount: current.count,
    };
  });
}

export function resetWarnings({ scopeKey, peerId }) {
  run("delete from warn_counts where scope_key = ? and peer_id = ?", [scopeKey, String(peerId)]);
}

export function listWarnings() {
  return all("select * from warn_counts where count > 0 order by last_at desc");
}

/* ------------------------------- 限流 ------------------------------- */

function rateBuckets({ kind, groupId, peerId }) {
  const gid = String(groupId ?? "");
  const uid = String(peerId ?? "");
  const buckets = [{ bucket: "global", limitKey: "globalPerDay", windowMs: DAY, label: "今天总共说得够多了（保护钱包）" }];
  if (kind === "group") {
    buckets.push({ bucket: `user:${gid}:${uid}`, limitKey: "perUserPerHour", windowMs: HOUR, label: "这个人这一小时说得有点多" });
    buckets.push({ bucket: `user:${gid}:${uid}`, limitKey: "perUserPerDay", windowMs: DAY, label: "这个人今天说得有点多" });
    buckets.push({ bucket: `group:${gid}`, limitKey: "perGroupPerHour", windowMs: HOUR, label: "这个群这一小时太热闹了" });
    buckets.push({ bucket: `group:${gid}`, limitKey: "perGroupPerDay", windowMs: DAY, label: "这个群今天太热闹了" });
  } else {
    buckets.push({ bucket: `private:${uid}`, limitKey: "perUserPerHour", windowMs: HOUR, label: "这一小时已经聊了不少了" });
    buckets.push({ bucket: `private:${uid}`, limitKey: "perUserPerDay", windowMs: DAY, label: "今天已经聊了不少了" });
  }
  return buckets;
}

/**
 * 频率与冷却检查。
 *
 * 「最小间隔」这一条**不适用于私聊**：用户在私聊里连着说话是常态，
 * 而按最小间隔直接丢掉一条消息，表现出来就是「她不理我」——更糟的是，
 * 用户说的「我这边是大晴天」「别再说了」如果刚好落在间隔里被丢掉，
 * 她就永远学不会，只能不停地重复天气。
 *
 * 所以私聊只保留「每小时/每天」的硬上限（那才是防刷钱的东西），
 * 最小间隔只用来管群聊的刷屏。isMaster 仍然收进来，留给以后更细的规则。
 */
export function rateCheck({ kind, groupId, peerId, at = Date.now(), isMaster = false }) {
  const cfg = getConfig();
  const rate = cfg.group?.rate ?? {};
  if (rate.enabled === false) return { ok: true, checks: [] };
  if (kind === "private" && rate.applyToPrivate === false) return { ok: true, checks: [] };
  const skipGap = kind === "private" || isMaster;

  const checks = [];
  for (const item of rateBuckets({ kind, groupId, peerId })) {
    const limit = Number(rate[item.limitKey]) || 0;
    if (limit <= 0) continue;
    const count = Number(
      one("select count(*) as n from rate_events where bucket = ? and at >= ?", [item.bucket, at - item.windowMs])?.n ?? 0,
    );
    checks.push({ ...item, count, limit });
    if (count >= limit) {
      return {
        ok: false,
        reason: `${item.label}（${count}/${limit}），先安静一会儿`,
        checks,
        blocked: { bucket: item.bucket, count, limit },
      };
    }
  }

  const gapMs = skipGap ? 0 : Math.max(0, Number(rate.minGapSeconds) || 0) * 1000;
  if (gapMs > 0) {
    const last = Number(
      one("select max(at) as at from rate_events where bucket = ? and at >= ?", [`scope:${kind}:${groupId ?? ""}:${peerId}`, at - gapMs])?.at ?? 0,
    );
    if (last && at - last < gapMs) {
      return { ok: false, reason: `${Math.ceil((gapMs - (at - last)) / 1000)} 秒内已经回过一次`, checks };
    }
  }

  /*
   * 「连续回 N 条就静默 M 分钟」只对群聊生效。
   *
   * 这条规则的初衷是：她在群里自说自话、没人接话时别再刷屏。
   * 但私聊里用户就在对面说着话，按「连续 8 条」把她静默 20 分钟，
   * 表现出来就是「聊得好好的她突然不理我了」——比刷屏更糟。
   * 私聊的刹车交给每小时/每天的硬上限。
   */
  const maxConsecutive = kind === "private" ? 0 : Math.max(0, Number(rate.maxConsecutive) || 0);
  if (maxConsecutive > 0) {
    const silentMs = Math.max(1, Number(rate.silentMinutes) || 20) * 60000;
    const recent = Number(
      one("select count(*) as n from rate_events where bucket = ? and at >= ?", [
        `scope:${kind}:${groupId ?? ""}:${peerId}`,
        at - silentMs,
      ])?.n ?? 0,
    );
    if (recent >= maxConsecutive) {
      return { ok: false, reason: `连续回了 ${recent} 条，静默 ${rate.silentMinutes} 分钟`, checks };
    }
  }

  return { ok: true, checks };
}

export function noteReply({ kind, groupId, peerId, at = Date.now() }) {
  tx(() => {
    for (const item of rateBuckets({ kind, groupId, peerId })) {
      run("insert into rate_events(bucket, at) values(?, ?)", [item.bucket, at]);
    }
    run("insert into rate_events(bucket, at) values(?, ?)", [`scope:${kind}:${groupId ?? ""}:${peerId}`, at]);
    run("delete from rate_events where at < ?", [at - 8 * DAY]);
  });
}

export function rateSnapshot({ kind, groupId, peerId }) {
  const checks = rateBuckets({ kind, groupId, peerId }).map((item) => ({
    ...item,
    count: Number(
      one("select count(*) as n from rate_events where bucket = ? and at >= ?", [item.bucket, Date.now() - item.windowMs])?.n ?? 0,
    ),
    limit: Number(getConfig().group?.rate?.[item.limitKey]) || 0,
  }));
  return checks;
}

/* ------------------------------- 回复触发 ------------------------------- */

/**
 * 该不该回这条消息（只看触达策略，不看预算）。
 * 返回 { ok, reason, policy }
 */
export function shouldReply(event) {
  const cfg = getConfig();
  if (pauseState.paused) return { ok: false, reason: `自动化已暂停（${pauseState.reason || "面板手动暂停"}）` };

  if (event.kind === "private") {
    if (!cfg.chat.replyPrivate) return { ok: false, reason: "私聊回复已关闭" };
    return { ok: true, policy: "private" };
  }

  const allow = (cfg.chat.groupAllowList ?? []).map(String);
  if (allow.length && !allow.includes(String(event.groupId))) {
    return { ok: false, reason: "这个群不在允许名单里" };
  }

  const memberPolicy = resolveMemberPolicy({
    characterId: cfg.activeCharacter,
    groupId: event.groupId,
    peerId: event.senderId,
  });
  if (memberPolicy.mute) return { ok: false, reason: "这个人被设成静音" };

  const trigger = String(memberPolicy.trigger ?? cfg.group?.defaultTrigger ?? "at");
  if (trigger === "never") return { ok: false, reason: "这个人被设成从不回复" };
  if (trigger === "all") return { ok: true, policy: "group_all" };
  if (trigger === "keyword") return { ok: event.isMention, reason: event.isMention ? "" : "需要关键词唤醒", policy: "group_keyword" };
  if (trigger === "probability") {
    const chance = clamp(memberPolicy.replyChance ?? 0.3, 0, 1);
    const ok = Math.random() < chance;
    return { ok, reason: ok ? "" : `概率回复未命中（${chance}）`, policy: "group_probability" };
  }
  // 默认 at
  if (event.isMention && cfg.chat.replyGroupAt) return { ok: true, policy: "group_at" };
  if (cfg.chat.replyGroupAll) return { ok: true, policy: "group_all" };
  return { ok: false, reason: event.isMention ? "群里被 @ 回复已关闭" : "群里没有 @ 我" };
}

/* ------------------------------- 总裁决 ------------------------------- */

/**
 * 完整准入判定（规划书 15.1 的消息准入算法）。
 * 返回值里带 decision 轨迹，面板可以回答「为什么回 / 为什么没回」。
 */
export function gate(event, { characterId = "" } = {}) {
  const cfg = getConfig();
  const trace = [];
  const push = (step, ok, reason) => trace.push({ step, ok, reason });

  if (pauseState.paused) {
    push("全局暂停", false, pauseState.reason || "面板手动暂停");
    return { action: ACTION.SILENT, reason: `自动化已暂停（${pauseState.reason || "面板手动暂停"}）`, trace };
  }
  push("全局暂停", true, "");

  const replyCheck = shouldReply(event);
  push("触达策略", replyCheck.ok, replyCheck.reason);
  if (!replyCheck.ok) return { action: ACTION.SILENT, reason: replyCheck.reason, trace };

  const blocked = checkBlocked({
    kind: event.kind,
    groupId: event.groupId,
    peerId: event.senderId,
    characterId,
  });
  push("黑名单", !blocked.blocked, blocked.blocked ? `已在${blocked.layer === "global" ? "全局" : blocked.layer === "group" ? "本群" : "角色"}黑名单` : "");
  if (blocked.blocked) {
    return {
      action: ACTION.SILENT,
      reason: `已在黑名单（${blocked.row?.reason || blocked.layer}）`,
      blocked: blocked.row,
      trace,
      costFree: true,
    };
  }

  const filter = cfg.group?.filter ?? {};
  const filterApplies = String(filter.scope ?? "group") === "all" || event.kind === "group";
  const isMaster = String(event.senderId) === String(cfg.bot.masterId);
  const hit = event.senderId && filterApplies && !isMaster ? hitFilter(event.text) : null;

  if (hit) {
    const scopeKey = `${event.kind === "group" ? "group" : "global"}:${event.groupId || "*"}`;
    const result = bumpWarning({
      scopeKey,
      peerId: event.senderId,
      ruleId: hit.ruleId,
      ruleType: hit.ruleType,
      word: hit.word,
      eventKey: event.messageId,
    });
    push("屏蔽词", false, `命中「${hit.word}」第 ${result.count} 次`);
    if (result.duplicated) {
      return { action: ACTION.SKIP, reason: "这条消息已经计过数了", trace, costFree: true };
    }
    if (filter.action === "log_only") {
      return { action: ACTION.REPLY, reason: "只记录，不拦截", trace, hit, moderation: result };
    }
    if (result.cooldown) {
      return { action: ACTION.SILENT, reason: "刚警告过没多久，这次先不理", trace, hit, moderation: result, costFree: true };
    }
    if (result.willBlock) {
      blockPeer({
        scopeKind: event.kind === "group" ? "group" : "global",
        scopeId: event.kind === "group" ? String(event.groupId) : "*",
        peerId: event.senderId,
        reason: filter.action === "block_now" ? "命中屏蔽词，直接拉黑" : `命中屏蔽词 ${result.count} 次后拉黑`,
        word: hit.word,
        by: "auto",
        warnCount: result.count,
      });
      return {
        action: ACTION.WARN,
        warnText: null,
        blocked: true,
        reason: `命中屏蔽词「${hit.word}」，本次警告后拉黑`,
        hit,
        moderation: result,
        trace,
        costFree: true,
      };
    }
    return {
      action: ACTION.WARN,
      warnText: null,
      blocked: false,
      reason: `命中屏蔽词「${hit.word}」，第 ${result.count} 次警告`,
      hit,
      moderation: result,
      trace,
    };
  }
  push("屏蔽词", true, "");

  // 群级拒绝名单
  if (event.kind === "group") {
    const deny = (cfg.group?.denyList ?? []).map(String);
    if (deny.includes(String(event.groupId))) {
      push("群级策略", false, "该群在拒绝名单里");
      return { action: ACTION.SILENT, reason: "该群在拒绝名单里", trace, costFree: true };
    }
  }
  push("群级策略", true, "");

  const rate = rateCheck({ kind: event.kind, groupId: event.groupId, peerId: event.senderId, isMaster });
  push("频率与冷却", rate.ok, rate.reason);
  if (!rate.ok) return { action: ACTION.SILENT, reason: rate.reason, trace, costFree: true };

  const memberPolicy = resolveMemberPolicy({
    characterId: cfg.activeCharacter,
    groupId: event.groupId || "*",
    peerId: event.senderId,
  });
  push("用户级策略", true, "");

  return { action: ACTION.REPLY, reason: "", trace, memberPolicy, policy: replyCheck.policy };
}

/** 发送前二次复核（规划书 15.1 第七步）：是否已被拉黑 / 是否被暂停。 */
export function preflight({ kind, groupId, peerId, characterId = "" }) {
  if (pauseState.paused) return { ok: false, reason: "自动化已被暂停" };
  const blocked = checkBlocked({ kind, groupId, peerId, characterId });
  if (blocked.blocked) return { ok: false, reason: "发送前发现已被拉黑" };
  return { ok: true };
}

export { clamp, audit };
