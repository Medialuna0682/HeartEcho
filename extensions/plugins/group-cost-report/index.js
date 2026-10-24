// 群友花费统计（确定性型插件 / 放在 plugins/）
//
// ── 干什么 ────────────────────────────────────────────────────────────────
// 群里有人 @机器人 说「金额统计」，就把**这个群**在指定区间内消耗的 token 与
// 折算花费，按"是谁触发了这次运行"分摊到各个群友头上，并把报告直接发回群里，
// 标题里写明统计的是几号到几号。
//
// ── 为什么做成插件（确定性型）──────────────────────────────────────────────
// 触发条件是"@机器人 + 固定关键词"，规则能写死 → 命中必然执行，不交给模型判断。
// 但发消息这一步仍然需要模型配合：钩子（before-context / before-llm-messages /
// before-tool / after-response）能拿到的上下文里**没有** sender，只有工具
// execute(ctx) 拿得到 ctx.sender。所以与仓库里的 forward-summary 同套路：
//
//   ① before-context        确定性识别"谁在哪个群要哪个区间"，只记任务，不发消息
//   ② before-llm-messages   把本轮对话压成本任务的一句话指令（模型不再参与闲聊）
//   ③ llm.request-params    把本轮工具列表压到只剩本插件的工具（发完只剩 finish）
//   ④ before-tool           别的工具一律拒绝；没发报告就想 finish 也拒绝
//   ⑤ 工具 execute(ctx)     就地统计 + **直接发送**，模型碰不到数字与文案
//   ⑥ after-response        已发送则清空正文，杜绝再补一句造成重复
//
// 关键点：报告的**数字与文案全部由代码生成**，模型只做"调用工具"和"finish"两个
// 动作，所以既不会算错，也不会被改写。
//
// ── 数据从哪来（心语移植版）──────────────────────────────────────────────
//   <心语数据目录>/extensions/sessions/<id>.json（宿主每次运行落一个文件）
//     chatKey     'group:<群号>'
//     startedAt   本次运行开始时间
//     model/vendor 实际调用的模型与渠道（与「用量」页同口径）
//     usage       { promptTokens, completionTokens, cachedTokens, totalTokens, calls }
//     trigger[]   触发本次运行的消息条目，含 senderId / senderName / atMe
//     cost        宿主已按同口径算好的金额（价格表解析不到时的兜底）
//   价格复用兼容层 ../../src/model-prices.js —— 报告里的钱与「用量」页对得上。
//
// ── 移植改动（相对 QQ Agent 原实现）──────────────────────────────────────
//   · 数据目录改成心语 compat 的 DATA_DIR（= <数据目录>/extensions），不再用 ../../data
//   · 触发条目字段兼容心语的 isSelf / messageId（原来只有 self / mid）
//   · getToolAvailability 兼容心语返回的 {ok}（原平台返回 {enabled}）
//   · 发送只用 ctx.sender.sendTextBatch(texts)（心语只允许发当前会话）
//   · 会话 id 不一定能从文件名解出时间 → 读文件头同时取 chatKey 与 startedAt
//   · 价格兼容层解析不到时，回落到宿主写在会话记录里的 cost
//
// ── 口径（会印在报告末尾）─────────────────────────────────────────────────
// 机器人的 token 消耗天然是按"会话（一次运行）"计量的，不存在"某人每条消息花了
// 多少"。这里把一次运行的花费归给**触发这次运行的人**：优先取被 @ 的那条消息，
// 没有则取触发批里最早的一条。这是唯一能落到"人"且可复现的口径。
//
// ── 常见坑（都已规避）─────────────────────────────────────────────────────
//   · 工具 id 会被加载器加前缀，所以只能按注册返回值引用（拿不到就用约定前缀）
//   · 工具被单独关掉时要**放弃接管**，否则会卡住模型轮次
//   · 会话文件可能被截断或不存在，任何单个文件读失败都不能让整次统计失败
//   · 零消耗会话（没真正调用过模型的等待/中止会话）不计入，与核心记账口径一致

import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { resolveModelPrice, priceAt, modelLabel } from '../../src/model-prices.js';
import { getToolAvailability } from '../../src/tool-registry.js';

const EXTENSION_ID = 'group-cost-report';
const TOOL_ID = 'group_cost_report';
const TOOL_ID_FALLBACK = `${EXTENSION_ID}__${TOOL_ID}`;   // 心语加载器加前缀后的形态
const FINISH_ID = 'finish';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');

const DAY = 86400000;
const TASK_TTL_MS = 6 * 60 * 60 * 1000;   // 任务记忆有效期（防 Map 无限增长）
const READ_CONCURRENCY = 8;              // 同时读几个会话文件
const HARD_MAX_SESSIONS = 2000;
const DEFAULT_KEYWORDS = ['金额统计', '花费统计', '花费查询', 'token统计', '用量统计', '消费统计'];

let api = null;
let config = () => ({});
let log = () => {};
let warn = () => {};
let toolId = TOOL_ID_FALLBACK;
let registeredFor = null;

/** sessionId -> 本轮统计任务（只在这一次运行内有效） */
const tasks = new Map();

// ───────────────────────────── 设置 ─────────────────────────────

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把设置规整成稳定的形状（设置项缺省/写错都不该让功能消失）。 */
function normalizeSettings(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  // ⚠️ 字段名不能叫 keywords：核心的密文掩码规则是 /key|token|secret|password|cookie/i，
  //    "keywords" 里的 key 会让这个设置被当成密钥，在设置弹窗里显示成 ****** 的密码框。
  //    （这里仍然兼容旧名 keywords，避免手改过配置的用户丢设置。）
  const words = String(c.triggerWords ?? c.keywords ?? '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    triggerWords: words.length ? words : [...DEFAULT_KEYWORDS],
    allowWithoutAt: c.allowWithoutAt === true,
    defaultRange: String(c.defaultRange || 'today').trim().toLowerCase() || 'today',
    topN: clampInt(c.topN, 8, 1, 50),
    maxSessions: clampInt(c.maxSessions, 400, 20, HARD_MAX_SESSIONS),
    footer: c.footer !== false
  };
}

function currentSettings() {
  try { return normalizeSettings(config() || {}); } catch { return normalizeSettings({}); }
}

// ───────────────────────────── 区间解析 ─────────────────────────────

// ⚠️ 不能写 `Number(ts) || Date.now()`：时间戳 0（"全部历史"的左边界）是 falsy，
//    会被当成"没传时间"悄悄变成今天 —— 表现为「金额统计 全部」只统计当天。
function safeTs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function startOfDay(ts) {
  const d = new Date(safeTs(ts));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfDay(ts) {
  return startOfDay(ts) + DAY - 1;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDay(ts, { withYear = false } = {}) {
  const d = new Date(Number(ts) || Date.now());
  return `${withYear ? `${d.getFullYear()}-` : ''}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 从消息文本里认出区间。认不出就用 defaultKey。 */
function parseRange(text, defaultKey = 'today', now = Date.now()) {
  const s = String(text || '');
  const year = new Date(now).getFullYear();
  const today = startOfDay(now);

  const make = (key, from, to) => {
    const f = startOfDay(from);
    const t = endOfDay(to);
    const crossYear = new Date(f).getFullYear() !== new Date(t).getFullYear();
    const label = f === startOfDay(t) && t - f < DAY
      ? `${fmtDay(f, { withYear: crossYear })}（当天）`
      : `${fmtDay(f, { withYear: crossYear })} ~ ${fmtDay(t, { withYear: crossYear })}`;
    return { key, from: f, to: t, label, fromDay: startOfDay(f), toDay: startOfDay(t) };
  };

  // "全部历史"单独走一条：左边界是 0（不能退化成今天），标题也不该印 1970-01-01
  const makeAll = () => ({ key: 'all', from: 0, to: endOfDay(today), label: '全部历史', fromDay: 0, toDay: startOfDay(today) });

  // 1) 显式日期（优先于关键词：用户写了就是最准的）
  const dates = [];
  for (const m of s.matchAll(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g)) {
    dates.push(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
  }
  for (const m of s.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    dates.push(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
  }
  for (const m of s.matchAll(/(?<![\d.:])(\d{1,2})\s*[-/]\s*(\d{1,2})(?![\d:])/g)) {
    dates.push(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
  }
  const ok = dates.filter((d) => Number.isFinite(d) && d > 0);
  ok.sort((a, b) => a - b);
  if (ok.length >= 2) return make('custom', ok[0], ok[ok.length - 1]);
  if (ok.length === 1) return make('custom', ok[0], ok[0]);

  // 2) 关键词
  if (/今天|今日|本日|\btoday\b/i.test(s)) return make('today', today, today);
  if (/昨天|昨日|\byesterday\b/i.test(s)) return make('yesterday', today - DAY, today - DAY);
  if (/前天/.test(s)) return make('daybefore', today - 2 * DAY, today - 2 * DAY);
  if (/上个?周|上星期|\blastweek\b/i.test(s)) {
    const dow = (new Date(today).getDay() + 6) % 7;   // 周一 = 0
    const thisMonday = today - dow * DAY;
    return make('lastweek', thisMonday - 7 * DAY, thisMonday - DAY);
  }
  if (/本周|这周|这个?星期|\bthisweek\b/i.test(s)) {
    const dow = (new Date(today).getDay() + 6) % 7;
    return make('thisweek', today - dow * DAY, today);
  }
  if (/上个?月|上个月|\blastmonth\b/i.test(s)) {
    const firstThisMonth = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime();
    return make('lastmonth', new Date(new Date(firstThisMonth).getFullYear(), new Date(firstThisMonth).getMonth() - 1, 1).getTime(), firstThisMonth - DAY);
  }
  if (/本月|这个?月|\bthismonth\b/i.test(s)) {
    const d = new Date(today);
    return make('thismonth', new Date(d.getFullYear(), d.getMonth(), 1).getTime(), today);
  }
  if (/全部|所有|历史|累计|all/i.test(s) && !/\d/.test(s)) return makeAll();

  const days = /(?:最近|近|这|过去)?\s*(\d{1,3})\s*(?:天|日)/.exec(s);
  if (days) {
    const n = clampInt(days[1], 0, 1, 3650);
    if (n > 0) return make(`${n}d`, today - (n - 1) * DAY, today);
  }

  // 3) 用户没写 → 用设置里的默认值
  const key = String(defaultKey || 'today').toLowerCase();
  if (key === 'yesterday') return make('yesterday', today - DAY, today - DAY);
  if (key === 'thisweek') return parseRange('本周', defaultKey, now);
  if (key === 'lastweek') return parseRange('上周', defaultKey, now);
  if (key === 'thismonth') return parseRange('本月', defaultKey, now);
  if (key === 'lastmonth') return parseRange('上月', defaultKey, now);
  if (key === 'all') return makeAll();
  const defDays = /^(\d{1,3})d$/.exec(key);
  if (defDays) {
    const n = clampInt(defDays[1], 1, 1, 3650);
    return make(`${n}d`, today - (n - 1) * DAY, today);
  }
  return make('today', today, today);
}

// ───────────────────────────── 计价（与用量页同口径）─────────────────────────────

/** 与心语用量页保持一致：能解析到价格就用价格表，否则退回宿主已经算好的 cost。 */
function priceOf(model, vendor, cfg) {
  const c = cfg || getConfig();
  const m = String(model || '');
  try {
    if (vendor) {
      const byVendor = resolveModelPrice(modelLabel(vendor, m), c);
      if (byVendor && byVendor.source === 'custom') return byVendor;
    }
    return resolveModelPrice(m, c) || { in: 0, out: 0, cached: 0 };
  } catch {
    return { in: 0, out: 0, cached: 0 };
  }
}

/** 单次运行的花费（元）。峰谷价在心语里与现价一致。 */
function costOfSession(session, cfg) {
  const u = session?.usage || {};
  const prompt = Number(u.promptTokens) || 0;
  const completion = Number(u.completionTokens) || 0;
  const cached = Math.min(Number(u.cachedTokens) || 0, prompt);
  const fresh = Math.max(0, prompt - cached);
  const price = priceOf(session?.model, session?.vendor, cfg);
  const tier = price?.peak ? priceAt(price, Number(session?.startedAt) || Date.now()) : price;
  const inRate = Number(tier?.in) || 0;
  const outRate = Number(tier?.out) || 0;
  const cachedRate = Number.isFinite(Number(tier?.cached)) ? Number(tier.cached) : inRate;
  const cost = (fresh / 1e6) * inRate + (cached / 1e6) * cachedRate + (completion / 1e6) * outRate;
  // 价格表里没有这个模型（或兼容层拿不到价格）时不能把真实花费报成 ¥0：
  // 宿主的会话记录里已经落了与「用量」页同口径的 cost，直接用它兜底。
  if (!(cost > 0)) {
    const recorded = Number(session?.cost);
    if (Number.isFinite(recorded) && recorded > 0) return recorded;
  }
  return cost;
}

// ───────────────────────────── 会话数据采集 ─────────────────────────────

/**
 * 会话记录里的 chatKey 应该是 'group:<群号>'；宿主若直接落了 scopeKey
 * （group_<群号>_<成员号>），这里统一翻译回来，保证按群统计不丢数据。
 */
function asChatKey(raw) {
  const s = String(raw ?? '');
  if (!s || s.startsWith('group:') || s.startsWith('private:')) return s;
  const g = /^group_(\d+)/.exec(s);
  if (g) return `group:${g[1]}`;
  const p = /^private_(\d+)/.exec(s);
  if (p) return `private:${p[1]}`;
  return s;
}

/** 会话 id 形如 <Date.now().toString(36)>-<hex>，时间戳可以直接解出来；解不出返回 0。 */
function decodeIdTime(id) {
  const seg = String(id || '').split('-')[0];
  const ts = parseInt(seg, 36);
  return Number.isFinite(ts) && ts > 1.6e12 && ts < 4e12 ? ts : 0;
}

/**
 * 只读文件开头，拿到 chatKey 与 startedAt。
 * 心语的会话文件字段顺序是 {id, chatKey, startedAt, ...}，前 8KB 足够；
 * 这样即使文件名（id）不是时间戳形态，也能按时间区间筛会话，不用整文件解析。
 */
async function headInfo(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const keyMatch = /"chatKey"\s*:\s*"([^"]*)"/.exec(head);
    const tsMatch = /"startedAt"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(head);
    const isoMatch = tsMatch ? null : /"startedAt"\s*:\s*"([^"]*)"/.exec(head);
    let startedAt = tsMatch ? Number(tsMatch[1]) : 0;
    if (!Number.isFinite(startedAt)) startedAt = 0;
    if (!startedAt && isoMatch) startedAt = Date.parse(isoMatch[1]) || 0;
    return { chatKey: keyMatch ? keyMatch[1] : '', startedAt };
  } catch {
    return { chatKey: '', startedAt: 0 };
  } finally {
    try { await handle?.close(); } catch { /* ignore */ }
  }
}

/** 读索引缓存（只用来快速筛掉别的群；内容坏了就当没有）。 */
async function readIndexCache() {
  try {
    const raw = JSON.parse(await fsp.readFile(INDEX_CACHE_FILE, 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 找出该群在区间内的全部运行记录。
 * @returns {{sessions: Array, truncated: boolean, scanned: number}}
 */
async function collectSessions({ chatKey, range, maxSessions }) {
  const picked = new Map();   // id -> { id, startedAt, fallback }
  const cache = await readIndexCache();
  const cachedIds = new Set();

  for (const e of cache) {
    const id = String(e?.id || '');
    if (!id) continue;
    cachedIds.add(id);
    if (asChatKey(e.chatKey) !== chatKey) continue;
    const at = Number(e.startedAt) || decodeIdTime(id);
    if (!at || at < range.from || at > range.to) continue;
    picked.set(id, { id, startedAt: at, fallback: e });
  }

  // 缓存里没有的（区间内新产生的 / 正在运行的 / 缓存损坏缺失的）→ 从磁盘补
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { files = []; }
  const candidates = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (cachedIds.has(id) || picked.has(id)) continue;
    // 文件名能解出时间就先粗筛，省掉明显不在区间内的文件头读取
    const guess = decodeIdTime(id);
    if (guess && (guess < range.from || guess > range.to)) continue;
    candidates.push({ id, guess });
  }
  if (candidates.length) {
    const heads = await mapLimit(candidates, 16, async (item) => {
      const info = await headInfo(path.join(SESSIONS_DIR, `${item.id}.json`));
      if (info.chatKey && asChatKey(info.chatKey) !== chatKey) return null;
      const startedAt = info.startedAt || item.guess;
      if (!startedAt || startedAt < range.from || startedAt > range.to) return null;
      return { id: item.id, startedAt, fallback: null };
    });
    for (const item of heads) if (item) picked.set(item.id, item);
  }

  let list = [...picked.values()].sort((a, b) => b.startedAt - a.startedAt);
  const truncated = list.length > maxSessions;
  if (truncated) list = list.slice(0, maxSessions);

  const sessions = await mapLimit(list, READ_CONCURRENCY, async (item) => {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, `${item.id}.json`), 'utf8'));
      if (data && typeof data === 'object') {
        // 文件头粗筛出的时间/群号再按整份文件复核一次（文件正在写/缓存过期时更稳）
        if (data.chatKey && asChatKey(data.chatKey) !== chatKey) return null;
        const at = Number(data.startedAt) || item.startedAt || 0;
        if (at && (at < range.from || at > range.to)) return null;
        return { ...data, id: String(data.id || item.id), startedAt: at };
      }
    } catch { /* 单个文件坏了不影响整次统计 */ }
    // 回落到索引摘要（缺 vendor，价格按通用表算）
    return item.fallback
      ? { id: item.id, chatKey, startedAt: item.startedAt, usage: item.fallback.usage, model: item.fallback.model, vendor: '', trigger: null }
      : null;
  });

  return { sessions: sessions.filter(Boolean), truncated, scanned: list.length };
}

// ───────────────────────────── 归属与汇总 ─────────────────────────────

/** 触发条目里"不是机器人自己"的那条（心语字段 isSelf，老存档是 self）。 */
function isSelfEntry(entry) {
  return Boolean(entry && (entry.self === true || entry.isSelf === true));
}

/** 一次运行算谁的：优先被 @ 的那条消息，其次触发批里最早的一条。 */
function attributor(session) {
  const list = Array.isArray(session?.trigger) ? session.trigger.filter((e) => e && !isSelfEntry(e)) : [];
  const hit = list.find((e) => e.atMe === true) || list[0] || null;
  if (!hit) return { key: '', id: '', name: '（主动发言 / 未识别）' };
  const id = String(hit.senderId ?? hit.userId ?? '');
  const name = String(hit.senderName ?? hit.nickname ?? '').trim() || (id ? `QQ${id}` : '未知群友');
  return { key: id || `name:${name}`, id, name };
}

function fmtTokens(n) {
  return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v < 0.0001 && v > 0 ? '<0.0001' : v.toFixed(4);
}

function displayName(m) {
  return m.id ? `${m.name}(QQ:${m.id})` : m.name;
}

/**
 * 统计 + 渲染。纯函数式：不碰模块状态，便于离线验证。
 * @returns {{text: string, sessionCount: number, memberCount: number, truncated: boolean, totals: object}}
 */
async function buildReport({ chatKey, range, cfg }) {
  const settings = normalizeSettings(cfg?.settings || cfg || {});
  const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0 };
  const members = new Map();
  let sessionCount = 0;

  if (String(chatKey || '').startsWith('group:')) {
    const { sessions, truncated } = await collectSessions({
      chatKey, range, maxSessions: settings.maxSessions
    });
    for (const s of sessions) {
      const u = s.usage || {};
      const prompt = Number(u.promptTokens) || 0;
      const completion = Number(u.completionTokens) || 0;
      const total = Number(u.totalTokens) || prompt + completion;
      // 零消耗会话（从没真正调用过模型的等待/中止会话）不计 —— 与核心记账口径一致
      if (!total && !(Number(u.calls) || 0)) continue;

      const cost = costOfSession(s, cfg?.raw || undefined);
      const who = attributor(s);
      const at = Number(s.startedAt) || 0;
      if (!members.has(who.key)) {
        members.set(who.key, {
          key: who.key, id: who.id, name: who.name,
          runs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, lastAt: 0
        });
      }
      const m = members.get(who.key);
      if (who.name && !/^（/.test(who.name)) m.name = who.name;   // 用最近一次看到的名字
      m.runs += 1;
      m.promptTokens += prompt;
      m.completionTokens += completion;
      m.cachedTokens += Math.min(Number(u.cachedTokens) || 0, prompt);
      m.totalTokens += total;
      m.cost += cost;
      m.lastAt = Math.max(m.lastAt, at);

      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.cachedTokens += Math.min(Number(u.cachedTokens) || 0, prompt);
      totals.totalTokens += total;
      totals.cost += cost;
      sessionCount += 1;
    }

    const lines = [`💰 本群花费统计（${range.label}）`];
    const ordered = [...members.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    if (!sessionCount) {
      lines.push('这个区间里还没有任何 token 消耗记录（或者机器人还没在这个群跑过）。');
      if (settings.footer) lines.push('（口径：每次运行的花费归给触发它的人）');
      return { text: lines.join('\n'), sessionCount, memberCount: 0, truncated, totals };
    }

    for (const [i, m] of ordered.slice(0, settings.topN).entries()) {
      lines.push(`${i + 1}. ${displayName(m)}：${fmtTokens(m.totalTokens)} token ｜ ¥${fmtMoney(m.cost)} ｜ ${m.runs} 次`);
    }
    if (ordered.length > settings.topN) {
      const rest = ordered.slice(settings.topN);
      const sum = rest.reduce((a, m) => ({
        totalTokens: a.totalTokens + m.totalTokens, cost: a.cost + m.cost, runs: a.runs + m.runs
      }), { totalTokens: 0, cost: 0, runs: 0 });
      lines.push(`其余 ${rest.length} 人：${fmtTokens(sum.totalTokens)} token ｜ ¥${fmtMoney(sum.cost)} ｜ ${sum.runs} 次`);
    }
    lines.push(`合计：${fmtTokens(totals.totalTokens)} token ｜ ¥${fmtMoney(totals.cost)} ｜ ${sessionCount} 次运行`);
    lines.push(`进/出 token：${fmtTokens(totals.promptTokens)} / ${fmtTokens(totals.completionTokens)}（其中缓存命中 ${fmtTokens(totals.cachedTokens)}）`);
    if (truncated) lines.push(`（区间内运行较多，只统计了最近 ${settings.maxSessions} 次）`);
    if (settings.footer) lines.push('（口径：每次运行的花费归给触发它的人；金额与「用量」页同源）');
    return { text: lines.join('\n'), sessionCount, memberCount: ordered.length, truncated, totals };
  }

  return { text: '这个统计只在群聊里有意义，私聊里没有群友数据。', sessionCount: 0, memberCount: 0, truncated: false, totals };
}

// ───────────────────────────── 触发识别 ─────────────────────────────

function pruneTasks(now = Date.now()) {
  for (const [key, value] of tasks) {
    if (!value || now - (Number(value.at) || 0) > TASK_TTL_MS) tasks.delete(key);
  }
}

/**
 * 取本轮的统计任务。
 * ⚠️ 钩子拿到的上下文里有 sessionId，但**工具的 ctx 没有**（它只有 ctx.session）——
 *    只按 ctx.sessionId 查会让工具永远拿不到任务，区间就退回模型自己填的参数。
 */
function taskOf(ctx) {
  return tasks.get(ctx?.sessionId || ctx?.session?.id) || null;
}

/** 这条消息是不是在 @机器人（心语存档有 atMe 标记；老存档回落到名字匹配）。 */
function looksAtMe(entry, ctx) {
  if (!entry) return false;
  if (entry.atMe === true) return true;
  const text = String(entry.text || '');
  if (!text) return false;
  let names = [];
  try {
    const conf = getConfig() || {};
    const persona = conf.persona || {};
    names = [
      persona.selfNickname, persona.botName,
      conf.botName, conf.selfNickname, conf.botNickname,
      ctx?.onebot?.selfInfo?.nickname
    ];
  } catch {
    names = [ctx?.onebot?.selfInfo?.nickname];
  }
  return names
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .some((n) => text.includes(`@${n}`));
}

/**
 * 心语兼容层 getToolAvailability 返回 {ok}（原平台返回 {enabled}）。
 * 只有宿主明确说"不可用"时才放弃接管；拿不到信息就按可用处理，交给工具自己兜底。
 */
function toolUsable(availability) {
  if (!availability || typeof availability !== 'object') return true;
  if (availability.enabled === false) return false;
  if (availability.ok === false) return false;
  return true;
}

/** 工具名可能带扩展前缀（group-cost-report__group_cost_report），按后缀认更稳。 */
function isOurTool(name) {
  const n = String(name || '');
  return n === toolId || n === TOOL_ID || n === TOOL_ID_FALLBACK || n.endsWith(`__${TOOL_ID}`);
}

function isFinishTool(name) {
  const n = String(name || '');
  return n === FINISH_ID || n === `${EXTENSION_ID}__${FINISH_ID}` || n.endsWith(`__${FINISH_ID}`) || n.endsWith(`/${FINISH_ID}`);
}

/** 从本轮触发消息里认出统计请求；认不出返回 null。 */
function detect(ctx) {
  if (!ctx || ctx.kind !== 'group' || ctx.proactive || !ctx.sessionId) return null;
  const settings = currentSettings();
  const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];

  for (const entry of entries) {
    if (!entry || isSelfEntry(entry)) continue;
    const text = String(entry.text || '');
    if (!text) continue;
    const keyword = settings.triggerWords.find((k) => text.includes(k));
    if (!keyword) continue;
    if (!settings.allowWithoutAt && !looksAtMe(entry, ctx)) continue;

    // 工具被关掉（总开关 / 分类开关 / 单项开关）时**不要接管** —— 否则模型既没有
    // 工具可用、又会被我们拦住 finish，整轮只能空转。
    let availability = { ok: true };
    try {
      availability = getToolAvailability(toolId, {
        toolsCfg: getConfig()?.tools || {},
        runtimeContext: ctx
      }) ?? { ok: true };
    } catch {
      availability = { ok: true };
    }
    if (!toolUsable(availability)) {
      log('统计工具当前不可用（%s），本次不接管，按普通聊天处理。', availability?.reason || availability?.ok);
      return null;
    }

    return {
      sessionId: ctx.sessionId,
      chatKey: String(ctx.chatKey || ''),
      chatId: String(ctx.chatId || ''),
      requester: { id: String(entry.senderId || ''), name: String(entry.senderName || '') },
      mid: entry.mid ?? entry.messageId ?? null,
      range: parseRange(text, settings.defaultRange),
      keyword,
      at: Date.now(),
      attempts: 0,
      sent: false,
      blocks: 0
    };
  }
  return null;
}

// ───────────────────────────── 发送通道 ─────────────────────────────

/**
 * 心语的 ctx.sender.sendTextBatch(texts) 只发当前会话，返回值形如 {sent, messageIds}。
 * 这里把各种可能的返回形态归一成 {count, list}，用于判断"到底发没发出去"。
 */
function normalizeSendResult(result) {
  const o = result && typeof result === 'object' ? result : {};
  const ids = Array.isArray(o.messageIds) ? o.messageIds : [];
  const sentList = Array.isArray(o.sent) ? o.sent : [];
  const list = sentList.length ? sentList : ids.map((messageId) => ({ messageId }));
  let count = list.length;
  if (typeof o.sent === 'number' && Number.isFinite(o.sent)) count = o.sent;
  else if (!count && result == null) count = 1;   // 宿主没回值：只要没抛错就当发出去了
  return { count, list };
}

// ───────────────────────────── 工具注册 ─────────────────────────────

function registerTool() {
  const returned = api.registerTool({
    id: TOOL_ID,
    name: '发送本群花费统计',
    description: '统计当前群在指定日期区间内，各位群友触发的运行所消耗的 token 与折算人民币花费，并把报告直接发送到当前群聊。只在群聊里、被明确要求统计花费时调用一次；不需要参数，统计区间已经在触发时解析好。',
    category: 'query',
    icon: '💰',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: '可选，仅在自动解析失败时兜底。取值：today/yesterday/thisweek/lastweek/thismonth/lastmonth/7d/30d/all，或 "YYYY-MM-DD~YYYY-MM-DD"。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        if (String(ctx?.kind || '') !== 'group' || !String(ctx?.chatKey || '').startsWith('group:')) {
          return { content: '这个工具只在群聊里可用。', isError: true };
        }
        if (!ctx?.sender || typeof ctx.sender.sendTextBatch !== 'function') {
          return { content: '发送通道不可用，本次没有发送统计。', isError: true };
        }
        const task = taskOf(ctx);
        // 已经发出去过就绝不再发（重复播报比少发更糟）；只有"发失败"时才允许重试一次。
        if (task && (task.sent || task.attempts >= 2)) {
          return { content: '本轮已经统计并发送过了，请调用 finish 结束本轮。' };
        }
        if (task) task.attempts += 1;

        const settings = currentSettings();
        const range = task?.range || parseRange(String(args?.range || ''), settings.defaultRange);
        const report = await buildReport({
          chatKey: String(ctx.chatKey),
          range,
          cfg: { settings: settings, raw: getConfig() }
        });

        // replyToMessageId 作为可选参数带上，宿主不支持就忽略（不影响发送）。
        const result = await sendReportText(ctx, report.text, task);
        const outcome = normalizeSendResult(result);
        try {
          if (Array.isArray(ctx.session?.sent) && outcome.list.length) {
            ctx.session.sent.push(...outcome.list.map((x) => ({
              type: 'text',
              text: String(x?.text ?? x?.messageId ?? ''),
              at: x?.at ?? Date.now()
            })));
          }
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 只是留档，失败不影响已发出的消息 */ }

        if (!outcome.count) {
          return { content: '统计报告没能发出去（可能被限频或去重），请调用 finish 结束本轮。', isError: true };
        }
        if (task) task.sent = true;
        log('已发送花费统计：群 %s，区间 %s，%s 次运行，合计 %s token / ¥%s。',
          task?.chatId || '', range.label, report.sessionCount,
          fmtTokens(report.totals.totalTokens), fmtMoney(report.totals.cost));
        return { content: '统计报告已经直接发送到本群了。请调用 finish 结束本轮，不要再补充任何文字。' };
      } catch (error) {
        warn('花费统计发送失败：%s', error?.message ?? error);
        return { content: `统计失败：${error?.message ?? error}。请调用 finish 结束本轮。`, isError: true };
      }
    }
  });
  // 心语 registerTool 返回 {name（全名）, bareName, id}；原平台可能返回字符串。
  // 带前缀的全名最适合写进提示词，也最适合给 getToolAvailability 查。
  if (typeof returned === 'string' && returned.trim()) {
    toolId = returned.trim();
  } else if (returned && typeof returned === 'object') {
    if (typeof returned.name === 'string' && returned.name) toolId = returned.name;
    else if (typeof returned.id === 'string' && returned.id) toolId = returned.id;
  }
}

/**
 * 发送报告。心语给工具的 ctx.sender 有两种可能形态：
 *   · (texts, options)              —— 绑定当前会话（契约 §7 推荐）
 *   · (chatKey, texts, options)     —— 宿主原始 sender（兜底）
 * 用参数个数判断；只有明确是"发送目标不合法"时才换形态重试，避免真实发送失败被重发。
 */
async function sendReportText(ctx, text, task) {
  const sender = ctx.sender;
  const fn = sender.sendTextBatch.bind(sender);
  const options = { replyToMessageId: task?.mid ?? null };
  if (fn.length >= 2) return fn(String(ctx.chatKey || ''), [text], options);
  try {
    return await fn([text], options);
  } catch (error) {
    if (/发送目标|不合法|chatKey|scopeKey/i.test(String(error?.message ?? ''))) {
      return fn(String(ctx.chatKey || ''), [text], options);
    }
    throw error;
  }
}

export async function setup(a) {
  api = a;
  config = typeof a?.config === 'function' ? a.config : () => ({});
  log = typeof a?.log === 'function' ? a.log : () => {};
  warn = typeof a?.warn === 'function' ? a.warn : log;

  // 重复 setup 幂等：同一个宿主实例上工具只注册一次；换了新宿主实例才重新注册
  if (registeredFor !== a) {
    if (!api || typeof api.registerTool !== 'function') throw new Error('宿主没有提供 registerTool');
    registeredFor = a;
    toolId = TOOL_ID_FALLBACK;
    registerTool();
  }

  // 这里不能打印"当前触发词"：setup 阶段本插件还没进注册表，api.config() 拿不到用户在
  // 设置里改过的值，只会拿到默认值 —— 打了反而误导（要看实际触发词，看控制台里
  // 「识别到花费统计请求」那行日志，那里是运行时读的真实设置）。
  log('群友花费统计已加载：群里 @我 + 触发词（默认「金额统计」）即可统计花费，区间可写在触发词后面。');
}

// 宿主的统一入口（部分宿主只认 register）；重复调用由 registeredFor 兜住
export const register = setup;

// ───────────────────────────── 钩子 ─────────────────────────────

export const hooks = {
  /** ① 确定性识别请求。这里只记任务，绝不发消息、不发网络请求。 */
  'before-context'(ctx) {
    try {
      pruneTasks();
      const hit = detect(ctx);
      if (!hit) return;
      tasks.set(ctx.sessionId, hit);
      log('识别到花费统计请求：群 %s，请求人 %s，区间 %s。',
        hit.chatId, hit.requester.name || hit.requester.id || '未知', hit.range.label);
    } catch (error) {
      warn('识别统计请求失败：%s', error?.message ?? error);
    }
  },

  /** ② 把本轮对话压成一句指令：保留 system（人设与安全规则），其余历史全部丢掉。 */
  'before-llm-messages'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task || !Array.isArray(ctx.messages)) return;
      const kept = ctx.messages.filter((m) => m?.role === 'system' || m?.role === 'developer');
      ctx.messages.splice(0, ctx.messages.length, ...kept);
      ctx.messages.push({
        role: 'user',
        content: [
          '【本群花费统计任务】群里有人要求统计花费，统计区间已经解析好，不需要你判断、也不需要你计算。',
          `第一步：调用 ${toolId}，不要传参数。它会自己统计，并把报告**直接发送到本群**。`,
          '第二步：收到工具结果后调用 finish 结束本轮。',
          '严禁：自己算数字、自己写报告、用 send_message 发送任何统计内容（会造成重复发送）。',
          `本次区间：${task.range.label}；请求人：${task.requester.name || '群友'}${task.requester.id ? `(QQ:${task.requester.id})` : ''}。`
        ].join('\n')
      });
    } catch (error) {
      warn('改写本轮对话失败：%s', error?.message ?? error);
    }
  },

  /** ④ 拦住其它工具：没发报告之前不许 finish，发完之后只许 finish。 */
  'before-tool'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task) return;
      const wantFinish = (task.attempts || 0) > 0;
      const allowed = wantFinish ? isFinishTool(ctx.toolName) : isOurTool(ctx.toolName);
      if (allowed) return;
      task.blocks = (task.blocks || 0) + 1;
      if (task.blocks > 4) return;   // 兜底：模型太犟时放行，避免把一整轮卡死
      return { block: true, reason: `本轮只做花费统计：现在应当调用 ${wantFinish ? 'finish' : toolId}。` };
    } catch (error) {
      warn('工具拦截失败：%s', error?.message ?? error);
    }
  },

  /** 工具真发出去了才标记 sent（后续据此清正文、拦住重复发送）。 */
  'after-tool'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task) return;
      if (isOurTool(ctx.toolName) && !ctx.result?.isError) task.sent = true;
    } catch { /* ignore */ }
  },

  /** ⑥ 报告已由工具直接发出：清掉模型正文，避免任何"补一句"的重复。 */
  'after-response'(ctx) {
    try {
      const task = taskOf(ctx);
      if (task?.sent && ctx?.response?.message) ctx.response.message.content = '';
    } catch { /* ignore */ }
  }
};

// ───────────────────────────── 能力 ─────────────────────────────

export const providers = {
  /**
   * ③ 把本轮工具列表压到只剩本任务的工具（发完只剩 finish）。
   * 不绕过任何开关与限频，只是"本轮用不到的工具不发给模型"。
   */
  'llm.request-params'({ body, context } = {}) {
    try {
      const task = tasks.get(context?.sessionId || context?.session?.id);
      if (!task || !body || !Array.isArray(body.tools)) return body ? { body } : undefined;
      const wantFinish = (task.attempts || 0) > 0;
      const matches = wantFinish ? isFinishTool : isOurTool;
      // 用本轮工具列表里的真实名字（防止不同宿主的前缀规则不一样）
      let expected = '';
      for (const t of body.tools) {
        const name = t?.function?.name;
        if (typeof name === 'string' && matches(name)) { expected = name; break; }
      }
      if (!expected) {
        const want = wantFinish ? 'finish' : toolId;
        if (task.missingTool !== want) {
          task.missingTool = want;
          warn('无法推进统计任务：工具 %s 不在本轮可用工具列表里（检查「工具与技能」里的开关）。', want);
        }
        return { body };
      }
      const next = { ...body, tools: body.tools.filter((t) => matches(t?.function?.name)), tool_choice: 'auto' };
      delete next.parallel_tool_calls;   // 思考模式端点可能不接受这个字段
      return { body: next };
    } catch (error) {
      warn('请求改写失败：%s', error?.message ?? error);
      return undefined;   // 返回非对象 = 不改，宁可不动也不能弄坏请求
    }
  }
};

export function available() { return { ok: true }; }

export function deactivate() { tasks.clear(); }
export function dispose() { tasks.clear(); }

// 离线自检用（不参与运行时逻辑）
export const internals = {
  parseRange, normalizeSettings, buildReport, collectSessions, costOfSession, priceOf,
  attributor, detect, looksAtMe, fmtTokens, fmtMoney, decodeIdTime, headInfo,
  normalizeSendResult, isOurTool, isFinishTool, toolUsable, isSelfEntry,
  asChatKey, sendReportText,
  SESSIONS_DIR, SESSIONS_DIR_NAME: 'sessions', TOOL_ID, TOOL_ID_FALLBACK
};
