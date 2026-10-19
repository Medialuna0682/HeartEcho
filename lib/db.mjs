/**
 * SQLite 持久化层（对应规划书 13 数据库与数据治理）。
 *
 * 设计要点：
 *  - 单文件 SQLite + WAL，无需单独数据库服务，适合单机用户
 *  - 所有跨作用域查询都必须显式带 scope_key，空值直接抛错（FR-302 的硬约束）
 *  - 外部事件「至少一次投递」，因此所有写入按 event_key / idempotency_key 幂等
 *  - 预算闸门用事务内原子预留实现，防止并发超支
 *  - 中文检索：FTS5 对中文分词不友好，这里用「二元分词倒排表 + LIKE 兜底」保证召回
 *  - 只保留 Repository/DAO 这一层抽象，将来要换外部数据库只改本文件
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./paths.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("DB");

export const SCHEMA_VERSION = 2;

const SCHEMA = `
create table if not exists meta (
  key text primary key,
  value text not null
);

-- Persistent clear boundaries survive restart and prevent history re-import.
create table if not exists scope_resets (
  scope_key text primary key,
  generation integer not null default 0,
  cleared_at integer not null default 0
);

-- 角色档案：核心人格 + 锁定字段 + 版本号（只允许用户确认后修改）
create table if not exists characters (
  id text primary key,
  name text not null default '',
  title text not null default '',
  avatar text not null default '',
  base_persona_json text not null default '{}',
  locked_fields text not null default '[]',
  version integer not null default 1,
  active integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0
);

-- QQ 接入账号
create table if not exists qq_accounts (
  id integer primary key autoincrement,
  external_qq_id text not null unique,
  adapter_type text not null default 'onebot11',
  display_name text not null default '',
  is_master integer not null default 0,
  connect_status text not null default 'unknown',
  last_seen_at integer not null default 0,
  created_at integer not null default 0
);

-- 会话：五元作用域（角色 / 账号 / 作用域类型 / 作用域 ID / 主体）
create table if not exists sessions (
  id integer primary key autoincrement,
  scope_key text not null unique,
  character_id text not null default '',
  qq_account_id text not null default '',
  scope_type text not null,
  scope_id text not null,
  subject_id text,
  title text not null default '',
  summary text not null default '',
  summary_upto integer not null default 0,
  summary_at integer not null default 0,
  archived_upto integer not null default 0,
  message_count integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0
);
create index if not exists idx_sessions_updated on sessions(updated_at desc);
create index if not exists idx_sessions_scope on sessions(scope_type, scope_id);

-- 联系人
create table if not exists contacts (
  id integer primary key autoincrement,
  qq_account_id text not null default '',
  peer_id text not null,
  display_name text not null default '',
  remark text not null default '',
  first_seen_at integer not null default 0,
  last_seen_at integer not null default 0,
  unique(qq_account_id, peer_id)
);

-- 群成员快照（增量刷新 + 离群标记，不删除历史关系）
create table if not exists group_members (
  group_id text not null,
  peer_id text not null,
  nickname text not null default '',
  card text not null default '',
  role text not null default 'member',
  level integer not null default 0,
  sync_at integer not null default 0,
  left_at integer,
  primary key (group_id, peer_id)
);
create index if not exists idx_group_members_group on group_members(group_id);

-- 群成员个性化策略（态度 / 称呼 / 亲密度 / 触发方式 / 概率 / 备注 / 静音）
create table if not exists member_policies (
  character_id text not null default '',
  group_id text not null default '*',
  peer_id text not null,
  settings_json text not null default '{}',
  updated_at integer not null default 0,
  unique(character_id, group_id, peer_id)
);

-- 消息原文
create table if not exists messages (
  id integer primary key autoincrement,
  event_key text not null unique,
  platform_message_id text not null default '',
  session_id integer not null,
  scope_key text not null,
  direction text not null,
  sender_id text not null default '',
  sender_name text not null default '',
  kind text not null default 'private',
  at integer not null,
  body text not null default '',
  segments_json text not null default '[]',
  attachments_json text not null default '[]',
  is_mention integer not null default 0,
  reply_to text not null default '',
  status text not null default 'ok',
  raw_ref text not null default '',
  trace_id text not null default '',
  created_at integer not null default 0
);
create index if not exists idx_messages_session on messages(session_id, at);
create index if not exists idx_messages_scope_at on messages(scope_key, at desc);
create index if not exists idx_messages_at on messages(at desc);

create virtual table if not exists messages_fts using fts5(body, content='messages', content_rowid='id', tokenize='trigram');
create trigger if not exists messages_ai after insert on messages begin
  insert into messages_fts(rowid, body) values (new.id, new.body);
end;
create trigger if not exists messages_ad after delete on messages begin
  insert into messages_fts(messages_fts, rowid, body) values('delete', old.id, old.body);
end;

-- 分层记忆（情景 / 事实 / 偏好 / 约定 / 关系 / 反思）
create table if not exists memories (
  id integer primary key autoincrement,
  session_id integer not null,
  scope_key text not null,
  character_id text not null default '',
  scope_type text not null,
  scope_id text not null,
  subject_id text not null default '',
  category text not null,
  source_type text not null default 'observed',
  content text not null,
  confidence real not null default 0.7,
  importance real not null default 0.5,
  status text not null default 'active',
  pinned integer not null default 0,
  supersedes_id integer,
  superseded_by integer,
  dedupe_key text not null default '',
  write_version integer not null default 1,
  valid_from integer not null default 0,
  valid_to integer,
  at integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0
);
create index if not exists idx_memories_scope on memories(scope_key, status, category);
create index if not exists idx_memories_dedupe on memories(scope_key, dedupe_key);
create index if not exists idx_memories_at on memories(at desc);

-- 记忆倒排索引（中文二元分词），保证「面试」这类双字词能命中
create table if not exists memory_tokens (
  token text not null,
  memory_id integer not null,
  scope_key text not null,
  primary key (token, memory_id)
);
create index if not exists idx_memory_tokens_token on memory_tokens(token, scope_key);

-- 记忆来源证据（可溯源）
create table if not exists memory_sources (
  memory_id integer not null,
  message_id integer,
  evidence_type text not null default 'observed',
  note text not null default '',
  at integer not null default 0
);
create index if not exists idx_memory_sources_memory on memory_sources(memory_id);

-- 反思（由多条经历概括而来，需带证据与置信度）
create table if not exists reflections (
  id integer primary key autoincrement,
  character_id text not null default '',
  scope_key text not null,
  source_type text not null default 'inferred',
  content text not null,
  evidence_count integer not null default 0,
  confidence real not null default 0.5,
  source_memories_json text not null default '[]',
  at integer not null default 0,
  created_at integer not null default 0
);
create index if not exists idx_reflections_scope on reflections(scope_key, at desc);

-- 关系演化（有界小幅变化，来源可追溯）
create table if not exists relationships (
  id integer primary key autoincrement,
  character_id text not null default '',
  account_id text not null default '',
  context_id text not null default '',
  subject_id text not null default '',
  familiarity real not null default 0,
  trust real not null default 0.5,
  affection real not null default 0,
  tension real not null default 0,
  updated_at integer not null default 0,
  unique(character_id, account_id, context_id, subject_id)
);

-- 动态心理状态（valence / energy / social_drive，随时间衰减）
create table if not exists life_state (
  character_id text primary key,
  valence real not null default 0.2,
  energy real not null default 0.7,
  social_drive real not null default 0.6,
  interest text not null default '',
  updated_at integer not null default 0
);

-- 目标与计划（待跟进约定 / 想聊的话题 / 短期意图）
create table if not exists goals (
  id integer primary key autoincrement,
  character_id text not null default '',
  scope_key text not null,
  kind text not null default 'topic',
  content text not null,
  status text not null default 'pending',
  due_at integer,
  at integer not null default 0,
  updated_at integer not null default 0
);
create index if not exists idx_goals_scope on goals(scope_key, status);

-- 审核事件（屏蔽词命中 / 警告 / 拉黑），(规则, 消息) 去重
create table if not exists moderation_events (
  id integer primary key autoincrement,
  rule_id text not null,
  rule_type text not null default 'word',
  session_id integer,
  scope_key text not null default '',
  actor_id text not null default '',
  message_id integer,
  event_key text not null default '',
  count_delta integer not null default 1,
  action text not null default 'warn',
  detail text not null default '',
  at integer not null default 0,
  unique(rule_id, event_key)
);
create index if not exists idx_moderation_scope on moderation_events(scope_key, at desc);

-- 黑名单（全局 / 群 / 角色三层）
create table if not exists blocklist (
  id integer primary key autoincrement,
  scope_kind text not null,
  scope_id text not null default '*',
  peer_id text not null,
  reason text not null default '',
  word text not null default '',
  by text not null default 'manual',
  warn_count integer not null default 0,
  at integer not null default 0,
  unique(scope_kind, scope_id, peer_id)
);

-- 警告计数（支持永久 / 滚动窗口 / 自然日）
create table if not exists warn_counts (
  scope_key text not null,
  peer_id text not null,
  rule_id text not null default '*',
  count integer not null default 0,
  day_count integer not null default 0,
  day_key text not null default '',
  window_json text not null default '[]',
  last_at integer not null default 0,
  last_word text not null default '',
  muted_until integer not null default 0,
  primary key (scope_key, peer_id, rule_id)
);

-- 限流令牌桶（多级：人 / 群 / 全局）
create table if not exists rate_events (
  id integer primary key autoincrement,
  bucket text not null,
  at integer not null
);
create index if not exists idx_rate_bucket on rate_events(bucket, at desc);

-- 定时任务（唯一 job_key 幂等 + 重启恢复）
create table if not exists scheduled_jobs (
  id integer primary key autoincrement,
  job_key text not null unique,
  kind text not null,
  scope_key text not null default '',
  policy_json text not null default '{}',
  next_run integer not null default 0,
  state text not null default 'pending',
  retry_count integer not null default 0,
  last_run integer not null default 0,
  last_result text not null default '',
  created_at integer not null default 0
);
create index if not exists idx_jobs_next on scheduled_jobs(state, next_run);

-- 事件提醒（一次性 / 每天 / 每周）
create table if not exists reminders (
  id integer primary key autoincrement,
  scope_key text not null default '',
  target_id text not null default '',
  text text not null,
  at integer not null default 0,
  repeat_rule text not null default 'none',
  polish integer not null default 1,
  advance_minutes integer not null default 0,
  enabled integer not null default 1,
  last_fired integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0
);
create index if not exists idx_reminders_at on reminders(enabled, at);

-- 生日与节日
create table if not exists anniversaries (
  id integer primary key autoincrement,
  kind text not null default 'birthday',
  peer_id text not null default '',
  name text not null default '',
  month_day text not null default '',
  calendar text not null default 'solar',
  privacy text not null default 'private',
  enabled integer not null default 1,
  created_at integer not null default 0
);

-- 出站队列（发送状态可核验，未知不盲目重发）
create table if not exists outgoing (
  id integer primary key autoincrement,
  idempotency_key text not null unique,
  scope_key text not null,
  kind text not null,
  target_id text not null,
  body text not null,
  reason text not null default '',
  status text not null default 'pending',
  attempts integer not null default 0,
  platform_message_id text not null default '',
  error text not null default '',
  trace_id text not null default '',
  created_at integer not null default 0,
  sent_at integer
);
create index if not exists idx_outgoing_status on outgoing(status, created_at);

-- QQ 空间动作（幂等键唯一 + 结果核验）
create table if not exists qzone_actions (
  id integer primary key autoincrement,
  target_post text not null default '',
  target_uin text not null default '',
  action text not null,
  status text not null default 'pending',
  idempotency_key text not null unique,
  request_json text not null default '{}',
  result_json text not null default '{}',
  verify_at integer,
  verified integer not null default 0,
  at integer not null default 0
);

-- QQ 空间能力状态（unknown/discovered/api_verified/end_to_end_verified/degraded/disabled）
create table if not exists qzone_capabilities (
  capability text primary key,
  status text not null default 'unknown',
  note text not null default '',
  checked_at integer not null default 0
);

-- 模型调用与费用（Actual 与 Estimated 明确区分）
create table if not exists llm_usage (
  id integer primary key autoincrement,
  request_id text not null unique,
  task text not null default 'chat',
  provider text not null default '',
  model text not null default '',
  character_id text not null default '',
  scope_key text not null default '',
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost real not null default 0,
  usage_source text not null default 'estimated',
  latency_ms integer not null default 0,
  retry_count integer not null default 0,
  status text not null default 'ok',
  error text not null default '',
  at integer not null default 0
);
create index if not exists idx_usage_at on llm_usage(at desc);
create index if not exists idx_usage_task on llm_usage(task, at desc);

-- 预算（全局 / 群 / 私聊 / 任务，日与月）
create table if not exists budgets (
  id integer primary key autoincrement,
  scope_kind text not null,
  scope_id text not null default '*',
  period text not null default 'day',
  limit_amount real not null default 0,
  reserved real not null default 0,
  spent real not null default 0,
  period_key text not null default '',
  warned integer not null default 0,
  updated_at integer not null default 0,
  unique(scope_kind, scope_id, period, period_key)
);

-- 审计日志
create table if not exists audit_logs (
  id integer primary key autoincrement,
  event_type text not null,
  scope_key text not null default '',
  actor text not null default '',
  reason text not null default '',
  detail_json text not null default '{}',
  trace_id text not null default '',
  occurred_at integer not null default 0
);
create index if not exists idx_audit_time on audit_logs(occurred_at desc);
create index if not exists idx_audit_scope on audit_logs(scope_key, occurred_at desc);

-- 幂等处理记录（外部事件至少一次投递）
create table if not exists event_keys (
  event_key text primary key,
  at integer not null default 0
);

-- 调度器执行记录（同一节日/生日一年只发一次）
create table if not exists job_runs (
  job_key text primary key,
  at integer not null default 0,
  detail text not null default ''
);
`;

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(paths.database, { recursive: true });
  db = new DatabaseSync(paths.mainDb);
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
  migrate(db);
  return db;
}

export function closeDb() {
  if (!db) return;
  try {
    db.exec("pragma wal_checkpoint(truncate)");
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function getUserVersion(database) {
  try {
    return Number(database.prepare("pragma user_version").get()?.user_version ?? 0);
  } catch {
    return 0;
  }
}

/** 迁移：迁移前先备份，失败可回滚（规划书 13.2）。 */
export function migrate(database = getDb()) {
  const current = getUserVersion(database);
  if (current >= SCHEMA_VERSION) return { from: current, to: current, migrated: false };
  if (current > 0) backup("pre-migrate");
  database.exec("begin");
  try {
    database.exec(SCHEMA);
    database.prepare("insert or replace into meta(key, value) values('schema_version', ?)").run(String(SCHEMA_VERSION));
    database.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw new Error(`数据库迁移失败（已回滚）：${error?.message ?? error}`);
  }
  log.info(`数据库结构已就绪（v${current} → v${SCHEMA_VERSION}）`);
  return { from: current, to: SCHEMA_VERSION, migrated: true };
}

/* --------------------------------- 事务 --------------------------------- */

let depth = 0;

export function tx(fn) {
  const database = getDb();
  if (depth > 0) return fn(database);
  database.exec("begin immediate");
  depth += 1;
  try {
    const result = fn(database);
    database.exec("commit");
    return result;
  } catch (error) {
    try {
      database.exec("rollback");
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    depth -= 1;
  }
}

/* ------------------------------- 便捷访问 ------------------------------- */

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function one(sql, params = []) {
  return getDb().prepare(sql).get(...params) ?? null;
}

export function exec(sql) {
  return getDb().exec(sql);
}

export function meta(key, value) {
  if (value === undefined) return one("select value from meta where key = ?", [key])?.value ?? null;
  run("insert or replace into meta(key, value) values(?, ?)", [key, String(value)]);
  return value;
}

/* ------------------------------ 幂等与审计 ------------------------------ */

/** 记录一个已处理的外部事件；重复投递返回 false。 */
export function claimEventKey(eventKey) {
  if (!eventKey) return true;
  try {
    run("insert into event_keys(event_key, at) values(?, ?)", [eventKey, Date.now()]);
    return true;
  } catch {
    return false;
  }
}

export function releaseEventKey(eventKey) {
  try {
    run("delete from event_keys where event_key = ?", [eventKey]);
  } catch {
    /* ignore */
  }
}

export function pruneEventKeys(keepMs = 7 * 86400000) {
  try {
    run("delete from event_keys where at < ?", [Date.now() - keepMs]);
  } catch {
    /* ignore */
  }
}

export function audit({ eventType, scopeKey = "", actor = "", reason = "", detail = {}, traceId = "" }) {
  try {
    run(
      `insert into audit_logs(event_type, scope_key, actor, reason, detail_json, trace_id, occurred_at)
       values(?, ?, ?, ?, ?, ?, ?)`,
      [eventType, scopeKey, actor, reason, JSON.stringify(detail ?? {}), traceId, Date.now()],
    );
  } catch (error) {
    log.warn(`审计写入失败：${error?.message ?? error}`);
  }
}

/* -------------------------------- 备份 -------------------------------- */

/**
 * 备份数据库。
 *
 * 用 SQLite 自带的 `VACUUM INTO`：它在事务里生成一份**自包含、已整理过**的数据库文件，
 * 不需要额外拷贝 -wal / -shm。这是唯一能保证「拷出来的文件一定完整」的做法——
 * 靠 checkpoint + copyFile，只要还有别的连接持有读快照，WAL 就合并不干净，备份会少一截。
 */
export function backup(tag = "manual") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(paths.backups, `${tag}-${stamp}.db`);
  try {
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.rmSync(target, { force: true });
    const database = getDb();
    // VACUUM INTO 的路径用参数绑不安全，这里用 SQLite 的单引号转义
    const escaped = target.replace(/'/g, "''");
    database.exec(`VACUUM INTO '${escaped}'`);
    const size = fs.statSync(target).size;
    const mainSize = fs.statSync(paths.mainDb).size;
    if (size < mainSize * 0.5) {
      log.warn(`备份体积偏小（${(size / 1024).toFixed(0)} KB < ${(mainSize / 1024).toFixed(0)} KB），请检查`);
    }

    // 轮转：只保留最近 10 份，并顺手清掉历史遗留的孤立 WAL/SHM
    const list = fs
      .readdirSync(paths.backups)
      .filter((name) => name.endsWith(".db"))
      .map((name) => ({ name, at: fs.statSync(path.join(paths.backups, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const keep = new Set(list.slice(0, 10).map((item) => item.name));
    for (const item of list.slice(10)) fs.rmSync(path.join(paths.backups, item.name), { force: true });
    for (const name of fs.readdirSync(paths.backups)) {
      const matched = /^(.*\.db)-(wal|shm)$/.exec(name);
      if (matched && !keep.has(matched[1])) fs.rmSync(path.join(paths.backups, name), { force: true });
    }

    return { ok: true, file: target, size, selfContained: true };
  } catch (error) {
    log.error(`备份失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function integrityCheck() {
  try {
    const rows = all("pragma integrity_check");
    const value = rows?.[0]?.integrity_check ?? "unknown";
    return { ok: value === "ok", value };
  } catch (error) {
    return { ok: false, value: String(error?.message ?? error) };
  }
}
