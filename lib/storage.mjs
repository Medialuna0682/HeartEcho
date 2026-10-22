/**
 * 存储服务：会话、消息、群成员、画像与策略的读写。
 *
 * 作用域硬约束（规划书 6.2 / FR-302）：所有查询必须显式带 scopeKey，
 * 空值直接抛错——绝不允许退化成「全局检索」。
 */
import { all, one, run, tx, claimEventKey } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { dayKey } from "./util.mjs";
import { scopeState } from "./scope-lifecycle.mjs";

export function assertScopeKey(scopeKey) {
  const value = String(scopeKey ?? "").trim();
  if (!value) throw new Error("作用域键不能为空（跨作用域检索是禁止的）");
  return value;
}

export function parseScopeKey(scopeKey) {
  const value = assertScopeKey(scopeKey);
  if (value.startsWith("private_")) return { scopeType: "private", scopeId: value.slice(8), subjectId: "" };
  if (value.startsWith("group_")) {
    const [, scopeId, subjectId] = value.split("_");
    return { scopeType: "group", scopeId: String(scopeId ?? ""), subjectId: String(subjectId ?? "") };
  }
  if (value.startsWith("sandbox")) return { scopeType: "sandbox", scopeId: value, subjectId: "" };
  return { scopeType: "custom", scopeId: value, subjectId: "" };
}

export function scopeLabel(scopeKey, { masterId = 0, masterName = "指挥官" } = {}) {
  const key = String(scopeKey ?? "");
  if (key === "panel_sandbox") return "面板试聊";
  if (key === "image_test") return "图片自检";
  if (key.startsWith("private_")) {
    const uid = key.slice(8);
    return String(uid) === String(masterId) ? `${masterName}（私聊）` : `QQ ${uid}（私聊）`;
  }
  if (key.startsWith("group_")) {
    const [, gid, uid] = key.split("_");
    return `群 ${gid} 里的 ${String(uid) === String(masterId) ? masterName : `成员 ${uid}`}`;
  }
  return key || "（未知）";
}

export function ensureSession(scopeKey, { characterId = "", accountId = "", title = "" } = {}) {
  const key = assertScopeKey(scopeKey);
  const { scopeType, scopeId, subjectId } = parseScopeKey(key);
  let row = one("select * from sessions where scope_key = ?", [key]);
  if (row) return row;
  const now = Date.now();
  run(
    `insert or ignore into sessions(scope_key, character_id, qq_account_id, scope_type, scope_id, subject_id, title, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, characterId, accountId, scopeType, scopeId, subjectId, title, now, now],
  );
  row = one("select * from sessions where scope_key = ?", [key]);
  return row;
}

export function ensureContact(peerId, { accountId = "", displayName = "" } = {}) {
  const now = Date.now();
  run(
    `insert into contacts(qq_account_id, peer_id, display_name, first_seen_at, last_seen_at)
     values(?, ?, ?, ?, ?)
     on conflict(qq_account_id, peer_id) do update set
       last_seen_at = excluded.last_seen_at,
       display_name = case when excluded.display_name <> '' then excluded.display_name else contacts.display_name end`,
    [accountId, String(peerId), displayName, now, now],
  );
  return one("select * from contacts where qq_account_id = ? and peer_id = ?", [accountId, String(peerId)]);
}

/**
 * 写入一条消息（幂等：同一个 event_key 只入库一次）。
 * 返回 { messageId, duplicated }。
 */
export function insertMessage({
  eventKey,
  platformMessageId = "",
  scopeKey,
  direction,
  senderId = "",
  senderName = "",
  kind = "private",
  at = Date.now(),
  body = "",
  segments = [],
  attachments = [],
  isMention = false,
  replyTo = "",
  status = "ok",
  traceId = "",
  characterId = "",
  accountId = "",
  recovered = false,
}) {
  const key = assertScopeKey(scopeKey);
  return tx(() => {
    const boundary = scopeState(key);
    // Live QQ events have second precision. Do not drop a fresh message in the
    // clear's second; pre-clear admitted tasks are fenced by generation instead.
    const old = recovered ? Number(at) <= boundary.cleared_at : Number(at) < Math.floor(boundary.cleared_at / 1000) * 1000;
    if (direction === "in" && boundary.cleared_at && old) {
      return { duplicated: true, cleared: true };
    }
    const session = ensureSession(key, { characterId, accountId });
    const existing = one("select id from messages where event_key = ?", [eventKey]);
    if (existing) {
      run("update sessions set updated_at = ? where id = ?", [Date.now(), session.id]);
      return { messageId: existing.id, duplicated: true, sessionId: session.id };
    }
    run(
      `insert into messages(event_key, platform_message_id, session_id, scope_key, direction, sender_id, sender_name,
         kind, at, body, segments_json, attachments_json, is_mention, reply_to, status, trace_id, created_at)
       values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventKey,
        String(platformMessageId),
        session.id,
        key,
        direction,
        String(senderId),
        senderName,
        kind,
        at,
        body,
        JSON.stringify(segments ?? []),
        JSON.stringify(attachments ?? []),
        isMention ? 1 : 0,
        String(replyTo ?? ""),
        status,
        traceId,
        Date.now(),
      ],
    );
    const inserted = one("select id from messages where event_key = ?", [eventKey]);
    run("update sessions set message_count = message_count + 1, updated_at = ? where id = ?", [Date.now(), session.id]);
    return { messageId: inserted.id, duplicated: false, sessionId: session.id };
  });
}

/** 只入库一次：返回 false 表示这条事件已经处理过了。 */
export function claimEvent(eventKey) {
  return claimEventKey(eventKey);
}

/**
 * 最近的消息（时间正序返回）。
 *
 * excludeEventKeys：把这几个 event_key 排除掉。
 * 为什么需要：处理一条消息时是「先落库、再生成」，库里的最后一条就是**正在回的那条**；
 * 拼历史时如果不把它排掉，它就会在提示词里出现两次（历史一次 + 当前这句一次），
 * 模型会以为对方把话说了两遍。
 */
export function recentMessages(scopeKey, limit = 24, { excludeEventKeys = [] } = {}) {
  const key = assertScopeKey(scopeKey);
  const excluded = [...new Set((excludeEventKeys ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 20);
  const clause = excluded.length ? ` and event_key not in (${excluded.map(() => "?").join(",")})` : "";
  const rows = all(
    `select * from messages where scope_key = ?${clause} order by at desc, id desc limit ?`,
    [key, ...excluded, Math.max(1, Math.min(400, Number(limit) || 24))],
  );
  return rows.reverse();
}

export function messageCount(scopeKey) {
  const key = assertScopeKey(scopeKey);
  return Number(one("select count(*) as n from messages where scope_key = ?", [key])?.n ?? 0) ?? 0;
}

export function messagesSince(scopeKey, fromIndex = 0, limit = 400) {
  const key = assertScopeKey(scopeKey);
  const rows = all(
    "select * from messages where scope_key = ? order by at asc, id asc limit ? offset ?",
    [key, Math.max(1, Math.min(800, Number(limit) || 400)), Math.max(0, Number(fromIndex) || 0)],
  );
  return rows;
}

export function clearMessages(scopeKey, { alsoMemory = true } = {}) {
  const key = assertScopeKey(scopeKey);
  return tx(() => {
    run(`insert into scope_resets(scope_key, generation, cleared_at) values(?, 1, ?)
         on conflict(scope_key) do update set generation = generation + 1, cleared_at = max(cleared_at, excluded.cleared_at)`, [key, Date.now()]);
    const removed = Number(one("select count(*) as n from messages where scope_key = ?", [key])?.n ?? 0);
    run("delete from messages where scope_key = ?", [key]);
    if (alsoMemory) {
      run("delete from memories where scope_key = ?", [key]);
      run("delete from memory_tokens where scope_key = ?", [key]);
      run("delete from reflections where scope_key = ?", [key]);
      run("delete from goals where scope_key = ?", [key]);
    }
    run("update sessions set message_count = 0, summary = '', summary_upto = 0, archived_upto = 0, updated_at = ? where scope_key = ?", [Date.now(), key]);
    return { removed };
  });
}

/* --------------------------------- 会话 --------------------------------- */

export function getSession(scopeKey) {
  return one("select * from sessions where scope_key = ?", [assertScopeKey(scopeKey)]);
}

export function listSessions({ limit = 200 } = {}) {
  return all(
    `select s.*, (select max(at) from messages m where m.scope_key = s.scope_key) as last_at,
            (select body from messages m where m.scope_key = s.scope_key order by at desc limit 1) as last_body
     from sessions s where s.message_count > 0 or s.summary <> '' order by coalesce(last_at, s.updated_at) desc limit ?`,
    [Math.max(1, Number(limit) || 200)],
  );
}

export function setSummary(scopeKey, text, { uptoIndex = 0 } = {}) {
  const key = assertScopeKey(scopeKey);
  run("update sessions set summary = ?, summary_upto = ?, summary_at = ?, updated_at = ? where scope_key = ?", [
    String(text ?? "").slice(0, 4000),
    Number(uptoIndex) || 0,
    Date.now(),
    Date.now(),
    key,
  ]);
  return getSession(key);
}

export function setArchivedUpto(scopeKey, index) {
  const key = assertScopeKey(scopeKey);
  run("update sessions set archived_upto = ?, updated_at = ? where scope_key = ?", [
    Math.max(0, Number(index) || 0),
    Date.now(),
    key,
  ]);
}

export function pendingArchiveScopes({ minNewMessages = 12 } = {}) {
  const need = Math.max(2, Number(minNewMessages) || 12);
  return all(
    `select scope_key, message_count, archived_upto, (message_count - archived_upto) as pending
     from sessions
     where scope_key not in ('panel_sandbox', 'image_test')
       and (message_count - archived_upto) >= ?
     order by pending desc limit 20`,
    [need],
  );
}

/* ------------------------------- 群成员 ------------------------------- */

export function upsertGroupMember({ groupId, peerId, nickname = "", card = "", role = "member", level = 0 }) {
  const now = Date.now();
  run(
    `insert into group_members(group_id, peer_id, nickname, card, role, level, sync_at, left_at)
     values(?, ?, ?, ?, ?, ?, ?, null)
     on conflict(group_id, peer_id) do update set
       nickname = excluded.nickname, card = excluded.card, role = excluded.role,
       level = excluded.level, sync_at = excluded.sync_at, left_at = null`,
    [String(groupId), String(peerId), nickname, card, role, Number(level) || 0, now],
  );
}

export function markLeftMembers(groupId, presentIds) {
  const idSet = new Set((presentIds ?? []).map(String));
  const rows = all("select peer_id from group_members where group_id = ? and left_at is null", [String(groupId)]);
  const left = [];
  for (const row of rows) {
    if (!idSet.has(String(row.peer_id))) {
      run("update group_members set left_at = ? where group_id = ? and peer_id = ?", [Date.now(), String(groupId), row.peer_id]);
      left.push(row.peer_id);
    }
  }
  return left;
}

export function groupMembers(groupId) {
  return all("select * from group_members where group_id = ? order by left_at is not null, level desc, peer_id asc", [
    String(groupId),
  ]);
}

export function allGroups() {
  return all(
    `select group_id, count(*) as members, max(sync_at) as sync_at from group_members group by group_id order by group_id`,
  );
}

/* ------------------------------- 成员策略 ------------------------------- */

export function getMemberPolicy({ characterId = "", groupId = "*", peerId }) {
  return one("select * from member_policies where character_id = ? and group_id = ? and peer_id = ?", [
    characterId,
    String(groupId ?? "*"),
    String(peerId),
  ]);
}

export function upsertMemberPolicy({ characterId = "", groupId = "*", peerId, settings = {} }) {
  const current = getMemberPolicy({ characterId, groupId, peerId });
  const merged = { ...(current ? JSON.parse(current.settings_json || "{}") : {}), ...settings };
  for (const [key, value] of Object.entries(merged)) {
    if (value === "" || value === null || value === undefined) delete merged[key];
  }
  if (Object.keys(merged).length) {
    run(
      `insert into member_policies(character_id, group_id, peer_id, settings_json, updated_at)
       values(?, ?, ?, ?, ?)
       on conflict(character_id, group_id, peer_id) do update set settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      [characterId, String(groupId ?? "*"), String(peerId), JSON.stringify(merged), Date.now()],
    );
  } else {
    run("delete from member_policies where character_id = ? and group_id = ? and peer_id = ?", [
      characterId,
      String(groupId ?? "*"),
      String(peerId),
    ]);
  }
  return getMemberPolicy({ characterId, groupId, peerId });
}

/** 分层解析：成员级 > 群内通配 > 全局通配。 */
export function resolveMemberPolicy({ characterId = "", groupId = "*", peerId }) {
  const cfg = getConfig();
  const layers = [
    getMemberPolicy({ characterId, groupId: "*", peerId }),
    getMemberPolicy({ characterId, groupId: String(groupId), peerId }),
    getMemberPolicy({ characterId, groupId: String(groupId), peerId: "*" }),
  ];
  const out = {
    attitude: "",
    note: "",
    nickname: "",
    mute: false,
    trigger: cfg.group?.defaultTrigger ?? "at",
    replyChance: 1,
    intimacy: 0,
    blocked: false,
  };
  for (const layer of layers) {
    if (!layer) continue;
    const settings = JSON.parse(layer.settings_json || "{}");
    for (const [key, value] of Object.entries(settings)) {
      if (value === "" || value === null || value === undefined) continue;
      out[key] = value;
    }
  }
  return out;
}

/* --------------------------------- 统计 --------------------------------- */

export function storageStats() {
  const tables = ["messages", "memories", "sessions", "moderation_events", "llm_usage", "outgoing", "scheduled_jobs", "audit_logs"];
  const counts = {};
  for (const table of tables) {
    counts[table] = Number(one(`select count(*) as n from ${table}`)?.n ?? 0);
  }
  const today = dayKey();
  counts.todayMessages = Number(
    one("select count(*) as n from messages where at >= ?", [new Date(`${today}T00:00:00`).getTime()])?.n ?? 0,
  );
  return counts;
}

export { run, all, one };
