// self-surf —— 机器人自己上网（确定性型插件，放 plugins/）
//
// ── 需求原话 ──────────────────────────────────────────────────────────────
//   「让机器人自己上网到处跑」「她可以凭自己的想法上网」
//
// ── 判定：为什么是「插件」而不是「技能」──────────────────────────────────
// 三问（规则能写死 → 插件；要理解人话 → 技能）：
//   ① 规则能写死吗？能。什么时候醒（定时间隔）、醒几轮、看几页，全是机械规则。
//   ② 要不要理解人话？要 —— 但这件事**在本插件内部自己起一次模型调用来解决**
//      （见 decideTopic / writePost），不需要把触发权交给外层对话。
//   ③ 何时执行由谁定？**必须由核心定时必然执行**。这正是技能做不到的地方：
//      技能只注册工具进模型的函数列表，而模型只有在"群里有人说话、轮到它思考"
//      时才会想起调用 —— 群聊安静时它永远不会动。而需求恰恰是"没人理它的时候
//      它自己想上网"。所以只能是插件：activate() 起定时器，核心管开关。
// 结论：plugins/。它靠 activate/deactivate/定时器 + 一个工具（被点名时立刻跑一轮）
// 工作，起模型调用与发送都走心语扩展宿主现成的通道。
//
// ── 一轮里它做了什么（这才是"自己想上网"）────────────────────────────────
//   ① 翻最近的聊天记录 → 起一次模型调用，让**它自己**挑一个值得深挖的话题，
//      连同搜索关键词一起给出来（话题必须来自群友真聊过的内容，不是凭空瞎逛）
//   ② 拿关键词去搜（固定 Bing RSS 搜索端点，走 api.fetch），挑 2~3 个
//      **不同域名**的结果页
//   ③ 抓这些页面的正文（剥掉脚本/样式/标签），交给模型
//   ④ 再起一次模型调用，让它写成一条**像群友说话**的短消息（带来源链接），
//      不确定的地方必须说不确定 —— 宁可说"没查明白"，也不许硬编
//   ⑤ 发到设置里指定的会话（默认私聊发给主人）
//
// ── 移植到心语时改了什么（只改通道，不改行为）────────────────────────────
//   · 网络出口：所有全局 fetch（原来的 OneBot HTTP、搜索、抓网页）全部改走
//     api.fetch（manifest 已声明 permissions: ["web_fetch"]，宿主自带内网拦截）
//   · 搜索：原平台用核心的 webSearch（会随设置切换 bing/deepseek/智谱…）；
//     心语没有对应能力，改成固定的 Bing RSS 端点（SEARCH_ENDPOINT），
//     解析用本地 parseBingRss，仍然是"搜索 → 结果列表"的同一形状
//   · 发送：原来直连 OneBot HTTP（find endpoint / 探活 / send_group_msg）；
//     现在定时轮走 api.sender.sendText(chatKey, text)，工具轮优先 ctx.sender；
//     目标**只**来自设置里的 targetChat（或 bot.masterId 兜底），严格校验，
//     绝不接受网页/模型给出的任意目标
//   · 会话记录：原来自己 new ChatStore；现在用宿主注入的 api.store.recent
//   · 模型调用：原来 import 核心 src/llm.js；现在走兼容层 ../../src/llm.js
//   · 状态文件：原来 data/self-surf.json（还会读环境变量）；现在固定
//     DATA_DIR/self-surf/state.json（旧状态读不到 = 从头开始，不影响行为）
//   · 定时器：activate 建、deactivate 清，语义保持不变
//
// ── 安全边界（都写在代码里，不靠提示词自觉）──────────────────────────────
//   · 发送目标只认「设置里填的那个会话」，不接受来自网页/模型的任意目标
//   · 抓取前用 validateFetchUrl 校验（挡住内网/本机地址，防 SSRF），
//     api.fetch 自己也再拦一层
//   · 域名黑名单：命中的域名整页跳过（内容与抓取都跳过）
//   · 单轮有时间上限与页数上限；一轮没跑完不允许再起一轮（running 闸）
//   · 抓不到任何正文时**不发**"内容"，只发一句诚实的"这轮没查到东西"
//   · 定时轮发送失败只记日志、等下一轮，不做无限重试

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { validateFetchUrl } from '../../src/safe-fetch.js';
import { chatCompletion } from '../../src/llm.js';

const STATE_FILE = path.join(DATA_DIR, 'self-surf', 'state.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 固定的搜索端点（Bing 的 RSS 输出；不随用户设置切换，避免依赖心语内核接口）。 */
const SEARCH_ENDPOINT = 'https://www.bing.com/search';
const SEARCH_COUNT = 10;

const DEFAULTS = {
  enabled: true,
  targetChat: '',            // 空 = 用主人 QQ（从心语配置 bot.masterId 找）；形如 123 或 group:123
  minMinutes: 120,           // 醒来间隔下限
  maxMinutes: 300,           // 上限（区间内随机，别像定时任务）
  quietHours: '0-7',         // 静默时段（这段时间内不打扰）
  maxPages: 3,               // 一轮最多抓几个页面
  maxChars: 6000,            // 单页正文最多取多少字喂给模型
  maxTurns: 4,               // 一轮最多换几个关键词重搜
  includeSources: true,      // 消息结尾附上来源链接
  domainBlock: '',           // 域名黑名单，逗号分隔（命中整页跳过）
  dryRun: false              // 只演练：不发出去，只写日志（调试用）
};

let api = null;
let log = () => {};
let warn = () => {};
let timer = null;
let running = false;
let lastRunAt = 0;
let lastResult = null;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });

/* ── 日志：心语宿主的 api.log 本身就会落主日志，所以这里不再另写一份 ─────── */

function setupLogging() {
  const write = (level, ...a) => {
    try {
      if (level === 'warn') api?.warn?.(...a);
      else api?.log?.(...a);
    } catch { /* 日志失败不影响主流程 */ }
  };
  log = (...a) => write('info', ...a);
  warn = (...a) => write('warn', ...a);
}

/* ── 状态落盘（只记"上次什么时候跑的、跑了什么"，用于跨重启不过度打扰）──── */

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadState() {
  const raw = readJson(STATE_FILE, null);
  lastRunAt = Number(raw?.lastRunAt) || 0;
  lastResult = raw?.lastResult || null;
  return { lastRunAt, lastResult };
}

function saveState(patch = {}) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const next = {
      lastRunAt: patch.lastRunAt ?? lastRunAt,
      lastResult: patch.lastResult ?? lastResult,
      updatedAt: Date.now()
    };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { warn(`状态写入失败：${e?.message ?? e}`); }
}

/* ── 配置与发送目标（心语版：目标固定来自设置，绝不接受任意目标）────────── */

function coreConfig() {
  try {
    return getConfig() || null;
  } catch {
    return null;
  }
}

/**
 * 把设置里的发送目标归一化成宿主认识的 chatKey。
 * 接受 `group:123456` / `private:789012` / 纯数字（按私聊算，沿用原实现）。
 * 其它写法一律返回 ''（= 设置不合法，这一轮不发）。
 * @returns {'group:123456'|'private:789012'|''}
 */
export function normalizeTarget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const matched = text.match(/^(group|private)\s*[:：]\s*(\d{5,12})$/i);
  if (matched) return `${matched[1].toLowerCase()}:${matched[2]}`;
  if (/^\d{5,12}$/.test(text)) return `private:${text}`;
  return '';
}

/** 从设置（其次心语配置里的主人 QQ）推出发送目标；拿不到返回 ''。 */
export function defaultTarget(cfg) {
  const s = settings();
  const configured = String(s.targetChat ?? '').trim();
  if (configured) return normalizeTarget(configured);
  const selfId = String(cfg?.bot?.selfId ?? '').replace(/\D/g, '');
  const masterId = String(cfg?.bot?.masterId ?? '').replace(/\D/g, '');
  if (/^\d{5,12}$/.test(masterId) && masterId !== selfId) return `private:${masterId}`;
  return '';
}

/**
 * 发一条消息到固定目标（目标必须严格等于当前设置算出来的那个会话）。
 * 工具轮且目标就是当前会话时走 ctx.sender；否则走宿主级 api.sender；
 * 最后兜底走宿主中转的 OneBot 调用（不是 HTTP 直连，不碰协议端地址）。
 */
export async function sendTextTo(target, text, { ctx = null } = {}) {
  const wanted = String(target ?? '').trim();
  if (!wanted) throw new Error('没有设置发送目标');
  const allowed = defaultTarget(coreConfig());
  if (!allowed || allowed !== wanted) throw new Error(`发送目标不合法：${wanted}`);
  const chatKey = allowed;
  try {
    if (ctx && String(ctx.chatKey ?? '') === chatKey && typeof ctx.sender?.sendText === 'function') {
      await ctx.sender.sendText(text);
      return { ok: true, via: 'ctx.sender', chatKey };
    }
    if (typeof api?.sender?.sendText === 'function') {
      await api.sender.sendText(chatKey, text);
      return { ok: true, via: 'api.sender', chatKey };
    }
    if (typeof api?.onebot?.call === 'function') {
      const [kind, id] = chatKey.split(':');
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      const message = [{ type: 'text', data: { text: String(text ?? '') } }];
      const params = kind === 'group'
        ? { group_id: Number(id), message }
        : { user_id: Number(id), message };
      const result = await api.onebot.call(action, params, 60000);
      if (result && typeof result === 'object'
        && (result.status === 'failed' || (result.retcode != null && Number(result.retcode) !== 0))) {
        throw new Error(`协议端拒绝发送：${result.message || result.wording || result.retcode}`);
      }
      return { ok: true, via: 'api.onebot', chatKey };
    }
    throw new Error('宿主没有可用的发送通道');
  } catch (e) {
    warn(`发送失败（目标 ${chatKey}）：${e?.message ?? e}`);
    throw e;
  }
}

/* ── 模型调用（走兼容层：心语自己的模型网关）─────────────────────────────── */

async function callLLM({ system, user, maxTokens = 700, temperature = 0.8 }) {
  const res = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    maxTokens,
    reasoningOff: true
  });
  const raw = res?.text ?? res?.message?.content;
  return Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
}

/** 网络类错误才重试；鉴权/额度错误直接抛（重试只是白等）。 */
async function callLLMRetry(args, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0) await sleep(1200 * i);
    try { return await callLLM(args); } catch (e) {
      last = e;
      const m = String(e?.message ?? e);
      if (/401|403|invalid|unauthor|api key|鉴权|无效|quota|余额|额度|insufficient/i.test(m)) break;
    }
  }
  throw last;
}

/* ── 网页正文提取（纯函数，便于自测）────────────────────────────────────── */

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·', '&times;': '×'
};

/** HTML → 可读文本：去掉脚本/样式/注释，块级标签转换行，压缩空白，解常见实体。 */
export function htmlToText(html, maxChars = 6000) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|td)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n· ');
  s = s.replace(/<[^>]+>/g, ' ');
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_, d) => {
    const n = Number(d);
    return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
  });
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map((l) => l.trim()).join('\n').trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 域名黑名单：命中返回 true（整页跳过）。 */
export function blockedByDomain(url, blockList) {
  const list = String(blockList || '').split(/[,，;；\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ── 搜索（固定 Bing RSS 端点，走 api.fetch）─────────────────────────────── */

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = Number(dec);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripCdata(text) {
  return String(text ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function pickTag(chunk, tag) {
  const matched = String(chunk ?? '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return matched ? matched[1] : '';
}

/** 解析 Bing RSS 的 <item> 列表 → [{title,url,snippet}]（纯函数，便于自测）。 */
export function parseBingRss(xml) {
  const out = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let matched;
  while ((matched = re.exec(String(xml ?? '')))) {
    const chunk = matched[1];
    const url = decodeXml(stripCdata(pickTag(chunk, 'link'))).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToText(decodeXml(stripCdata(pickTag(chunk, 'title'))), 300).replace(/\n+/g, ' ').trim();
    const snippet = htmlToText(decodeXml(stripCdata(pickTag(chunk, 'description'))), 500).replace(/\n+/g, ' ').trim();
    out.push({ title, url, snippet });
  }
  return out;
}

/** 搜关键词 → {query, results}；没结果是抛错（沿用原实现 webSearch 的语义）。 */
export async function webSearch(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  if (typeof api?.fetch !== 'function') throw new Error('宿主没有提供联网能力（manifest 缺少 web_fetch）');
  const url = `${SEARCH_ENDPOINT}?format=rss&count=${SEARCH_COUNT}&q=${encodeURIComponent(q)}`;
  const res = await api.fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`搜索 HTTP ${res.status}`);
  const xml = await res.text();
  const results = parseBingRss(xml);
  if (!results.length) throw new Error('搜索没有返回结果');
  return { query: q, results };
}

/** 抓一个页面并抽出正文。validateFetchUrl 先挡内网地址，api.fetch 再挡一次。 */
async function fetchPageText(url, { timeoutMs = 15000, maxChars = 6000 } = {}) {
  validateFetchUrl(url);
  if (typeof api?.fetch !== 'function') throw new Error('宿主没有提供联网能力（manifest 缺少 web_fetch）');
  const init = {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    redirect: 'follow'
  };
  if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
  const res = await api.fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '');
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`不是网页（${type || '未知类型'}）`);
  const html = await res.text();
  return htmlToText(html, maxChars);
}

/* ── 让「它自己」决定查什么 ──────────────────────────────────────────────── */

/**
 * 从最近的群聊记录里挑一个它自己感兴趣、又确实有信息量的话题。
 * 返回 { topic, query, why } —— 拿不到就返回 null（这一轮就不发）。
 */
export async function decideTopic(recentLines, settingsNow = {}) {
  const text = (Array.isArray(recentLines) ? recentLines : []).join('\n').slice(-4000);
  if (!text.trim()) return null;
  const system = '你是一个中文 QQ 群里的机器人，性格好奇、爱较真、说话像群友。'
    + '现在没人跟你说话，你自己想上网看点东西。'
    + '请从下面这段最近群聊里，挑一个**你自己想弄明白**的话题去查。'
    + '要求：'
    + '① 必须跟群友真聊过的内容有关（人名/游戏/番剧/事件/某个说法都行），不要凭空乱逛；'
    + '② 必须是"查一下能得到信息"的东西（某个东西是什么、某件事进展如何、某个说法的来龙去脉），'
    + '不要选纯情绪或私事；'
    + '③ 搜索关键词要能真的搜到东西：如果是动画/游戏/日本相关的内容，优先给日文原名关键词；'
    + '④ 只输出一个 JSON，不要任何解释、不要代码块围栏。'
    + '格式：{"topic":"一句话说明你想弄明白什么","query":"搜索关键词","why":"为什么想查它（一句话）"}'
    + '如果这段聊天里实在没有值得查的东西，就输出 {"topic":"","query":"","why":""}。';
  const out = await callLLMRetry({ system, user: `最近的群聊：\n${text}`, maxTokens: 400, temperature: 0.9 });
  return parseTopicJson(out);
}

/** 从模型输出里抠出 {topic,query,why}；解析不出来返回 null。 */
export function parseTopicJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const candidates = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const topic = String(j?.topic ?? '').trim();
      const query = String(j?.query ?? '').trim();
      if (!topic || !query) return null;
      return { topic, query, why: String(j?.why ?? '').trim() };
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 把查到的资料写成像群友说话的短消息（不许硬编，不确定要说不确定）。 */
export async function writePost(topic, sources, settingsNow = {}) {
  const body = sources.map((s, i) => `【资料${i + 1}】${s.title}\n${s.url}\n${s.text}`).join('\n\n---\n\n');
  const system = '你是一个中文 QQ 群里的机器人，现在自己上网查了点东西，想跟群友说一声。'
    + '要求：'
    + '① 说人话：像群友分享见闻，不要写报告、不要用"首先/其次/综上所述"、不要列一堆小标题；'
    + '② 长度控制在 120~320 字，只讲最有意思、最有信息量的那几点，不要复述所有细节；'
    + '③ **只根据给你的资料说**。资料里没有的、或者你拿不准的，必须明说"这个我没查明白"或'
    + '"资料里没写"，**绝对不许自己编**；'
    + '④ 不要提"资料1/资料2""网页""搜索""接口""模型"这类字眼，就当是你自己看到的；'
    + '⑤ 不要向群友复述内部细节（域名、抓取过程、超时等）。'
    + '直接输出要发的那段话本身，不要任何前后缀、不要引号。';
  const user = `你想弄明白的是：${topic}\n\n查到的资料：\n${body}`;
  const text = await callLLMRetry({ system, user, maxTokens: 900, temperature: 0.85 });
  return String(text ?? '').trim();
}

/* ── 静默时段 ─────────────────────────────────────────────────────────────── */

export function inQuietHours(rangeStr, now = new Date()) {
  const m = String(rangeStr || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return false;
  const from = Number(m[1]) % 24;
  const to = Number(m[2]) % 24;
  const h = now.getHours();
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

/** 下一次唤醒延迟：区间内随机，落在静默时段就推到静默结束。 */
export function nextDelayMs(s, now = new Date()) {
  const lo = clamp(Number(s.minMinutes) || DEFAULTS.minMinutes, 5, 24 * 60);
  const hi = Math.max(lo, clamp(Number(s.maxMinutes) || DEFAULTS.maxMinutes, 5, 24 * 60));
  const base = (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60 * 1000;
  const at = new Date(now.getTime() + base);
  if (!inQuietHours(s.quietHours, at)) return base;
  const mm = String(s.quietHours || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  const to = mm ? Number(mm[2]) % 24 : 7;
  const end = new Date(at);
  end.setHours(to, 0, 0, 0);
  if (end <= at) end.setDate(end.getDate() + 1);
  return end.getTime() - now.getTime() + Math.floor(Math.random() * 15 * 60 * 1000);
}

/* ── 从会话仓里取最近的聊天（决定话题的原料）────────────────────────────── */

async function recentChatLines(chatKey, limit = 60) {
  try {
    const key = String(chatKey ?? '').trim();
    if (!key) return { lines: [], chatKey: '' };
    const store = api?.store;
    if (!store || typeof store.recent !== 'function') return { lines: [], chatKey: key };
    const recent = store.recent(key, { limit });
    const lines = (Array.isArray(recent) ? recent : [])
      .slice(-limit)
      .map((e) => `${e?.senderName || e?.senderId || '某人'}：${String(e?.text || '').replace(/\s+/g, ' ').slice(0, 120)}`)
      .filter((x) => x.length > 4);
    return { lines, chatKey: key };
  } catch (e) {
    warn(`读会话记录失败：${e?.message ?? e}`);
    return { lines: [], chatKey: '' };
  }
}

/* ── 一轮完整流程 ─────────────────────────────────────────────────────────── */

async function runCycle({ dry = false, manual = false, reason = 'timer', ctx = null } = {}) {
  if (running) return { ok: false, error: '上一轮还在跑' };
  running = true;
  const s = settings();
  const notes = [];
  try {
    if (!s.enabled && !manual) return { ok: false, error: '插件是关着的' };
    const cfg = coreConfig();
    const target = defaultTarget(cfg);
    if (!target) return { ok: false, error: '没有可用的发送目标：请在设置里填「发给谁」（格式 group:群号 / private:QQ号 / 纯数字私聊）' };

    // ① 决定查什么
    const { lines, chatKey } = await recentChatLines(target);
    if (!lines.length) return { ok: false, error: `最近的聊天记录读不到内容（会话 ${chatKey || '未知'}），这轮先不动` };
    const topic = await decideTopic(lines, s);
    if (!topic) { log('这轮没挑出值得查的话题，跳过'); return { ok: true, skipped: true, reason: '没有值得查的话题' }; }
    log(`自己想查：「${topic.topic}」（关键词 ${topic.query}）—— ${topic.why}`);

    // ② 搜索（固定 Bing RSS 端点；没结果时 webSearch 抛错，所以必须 try 包住）
    const found = [];
    const searchErrors = [];
    for (let turn = 0; turn < clamp(Number(s.maxTurns) || DEFAULTS.maxTurns, 1, 6); turn += 1) {
      const q = turn === 0 ? topic.query : `${topic.query} ${topic.topic}`.slice(0, 60);
      try {
        const r = await webSearch(q);
        const list = Array.isArray(r?.results) ? r.results : (Array.isArray(r) ? r : []);
        for (const x of list) {
          const url = String(x?.url || x?.link || '');
          if (!/^https?:\/\//i.test(url)) continue;
          if (found.some((f) => f.url === url)) continue;
          found.push({ url, title: String(x?.title || ''), snippet: String(x?.snippet || x?.summary || '') });
        }
      } catch (e) {
        searchErrors.push(`${q}：${e?.message ?? e}`);
      }
      if (found.length >= 6) break;                       // 够挑了，别把请求数堆上去
    }
    const links = found.filter((r) => !blockedByDomain(r.url, s.domainBlock));
    if (!links.length) {
      notes.push(searchErrors[0] || '搜索没返回可用链接');
      const msg = `我刚才想查一下「${topic.topic}」，但没搜到能看的东西，回头再试试。`;
      if (!dry && !s.dryRun) await sendTextTo(target, msg, { ctx });
      saveState({ lastRunAt: Date.now(), lastResult: { topic: topic.topic, sent: !dry && !s.dryRun, ok: false, note: '无搜索结果' } });
      return { ok: true, sent: false, notes, message: msg };
    }

    // ③ 抓正文（不同域名优先，页数与时间都有上限）
    const maxPages = clamp(Number(s.maxPages) || DEFAULTS.maxPages, 1, 5);
    const seenHost = new Set();
    const sources = [];
    const errors = [];
    for (const l of links) {
      if (sources.length >= maxPages) break;
      let host = '';
      try { host = new URL(l.url).hostname; } catch { continue; }
      if (seenHost.has(host)) continue;                 // 每个域名只取一页，避免同一站刷屏
      seenHost.add(host);
      try {
        const text = await fetchPageText(l.url, { maxChars: clamp(Number(s.maxChars) || DEFAULTS.maxChars, 800, 20000) });
        if (text.length < 200) { errors.push(`${host}：正文太短`); continue; }
        sources.push({ url: l.url, title: l.title || host, text });
      } catch (e) {
        errors.push(`${host}：${e?.message ?? e}`);
      }
    }
    if (errors.length) log(`抓取失败/跳过：${errors.slice(0, 4).join('；')}`);
    if (!sources.length) {
      const msg = `我刚才想查一下「${topic.topic}」，但那几个页面都没打开，没看成。`;
      if (!dry && !s.dryRun) await sendTextTo(target, msg, { ctx });
      saveState({ lastRunAt: Date.now(), lastResult: { topic: topic.topic, sent: false, ok: false, note: '页面都没抓到' } });
      return { ok: true, sent: false, notes: errors, message: msg };
    }

    // ④ 写成人话
    let post = await writePost(topic.topic, sources, s);
    if (!post) post = `我刚才去查了「${topic.topic}」，但没整理出什么有用的东西。`;
    if (s.includeSources !== false) {
      const uniq = [...new Set(sources.map((x) => x.url))].slice(0, 3);
      post = `${post}\n\n${uniq.join('\n')}`;
    }

    // ⑤ 发送（dry / dryRun 时不发）
    const willSend = !dry && !s.dryRun;
    if (willSend) await sendTextTo(target, post, { ctx });
    log(`本轮${willSend ? '已发送' : '（演练，未发送）'}：话题「${topic.topic}」，用了 ${sources.length} 个页面`);
    saveState({
      lastRunAt: Date.now(),
      lastResult: { topic: topic.topic, query: topic.query, sent: willSend, ok: true, pages: sources.map((x) => x.url), at: Date.now() }
    });
    return { ok: true, sent: willSend, topic: topic.topic, pages: sources.length, message: post, notes };
  } catch (e) {
    const msg = `自己上网这轮失败了：${e?.message ?? e}`;
    warn(msg);
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    running = false;
  }
}

/* ── 定时器 ───────────────────────────────────────────────────────────────── */

function scheduleNext() {
  if (timer) { clearTimeout(timer); timer = null; }
  const s = settings();
  if (!s.enabled) return;
  const delay = nextDelayMs(s);
  const at = new Date(Date.now() + delay);
  log(`下次自己上网：${Math.round(delay / 60000)} 分钟后（约 ${at.toLocaleTimeString('zh-CN', { hour12: false })}）`);
  timer = setTimeout(async () => {
    timer = null;
    try {
      if (!inQuietHours(settings().quietHours)) await runCycle({ reason: 'timer' });
      else log('现在是静默时段，跳过这轮');
    } catch (e) {
      warn(`定时这轮出错：${e?.message ?? e}`);
    } finally {
      scheduleNext();
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/* ── 生命周期与工具 ───────────────────────────────────────────────────────── */

function registerTools() {
  api.registerTool({
    id: 'surf_now',
    name: '现在自己上网看点东西',
    category: 'web',
    icon: '🌐',
    description: '让机器人**立刻**自己上网逛一圈：从最近的群聊里挑一个它想弄明白的话题，去搜、去翻几个网页，'
      + '然后把结果说给群友。用在：群友说「你自己去查查」「你自己看着办」「随便找点东西讲讲」「你不是能上网吗」这类时候。\n'
      + '它会把结果**直接发到会话里**，所以调用之后你只需要配一句短话，**不要**复述它查了什么细节、也不要编造它查到的东西。'
      + '如果返回里说没查到，就如实说一句没查到。',
    parameters: {
      type: 'object',
      properties: {
        dry: { type: 'boolean', description: 'true = 只演练：查到什么就回报什么，但不真的发消息（群友说「先看看你会发什么」时用）' }
      },
      required: []
    },
    async execute(ctx, args) {
      const r = await runCycle({ dry: !!args?.dry, manual: true, reason: 'tool', ctx });
      if (!r.ok) return { content: `这轮没跑成：${r.error}`, isError: true };
      if (r.skipped) return { content: `这轮没找到值得查的东西（${r.reason}），什么都没发。` };
      if (r.sent === false && r.message) {
        return { content: `（演练模式，没有真的发出去）本来会发这条：\n${r.message}` };
      }
      return {
        content: `已经自己上网查过「${r.topic}」并把结果发到会话里了（翻了 ${r.pages} 个页面）。\n`
          + '配一句短话就行，**不要**复述查到的内容细节，也不要补充你没查过的东西。'
      };
    }
  });

  api.registerTool({
    id: 'surf_status',
    name: '看自己上网的排班',
    category: 'web',
    icon: '🕒',
    description: '查看机器人"自己上网"的当前状态：开没开、下次大概什么时候醒、上一轮查了什么。群友问「你多久自己上一次网」「你上次看了啥」时用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const s = settings();
      const parts = [
        `状态：${s.enabled ? '开着' : '关着'}`,
        `间隔：${s.minMinutes}~${s.maxMinutes} 分钟随机`,
        `静默时段：${s.quietHours || '无'}`,
        `一次最多看：${s.maxPages} 个页面`,
        `上次跑：${lastRunAt ? new Date(lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '还没跑过'}`
      ];
      if (lastResult?.topic) parts.push(`上次查的：${lastResult.topic}（${lastResult.sent ? '发出去了' : '没发出去'}）`);
      return { content: `${parts.join('\n')}\n（不要向群友复述这些内部设置细节，用一两句话概括就行。）` };
    }
  });
}

export function setup(hostApi) {
  api = hostApi;
  setupLogging();
  loadState();
  registerTools();
  scheduleNext();
  log(`自己上网已加载（间隔 ${settings().minMinutes}~${settings().maxMinutes} 分钟，静默 ${settings().quietHours || '无'}）`);
}

/**
 * 心语宿主关闭扩展时会清空已注册工具，而重新启用只调 activate() 不再走 setup()；
 * 这里检查工具表，缺了就补注册（正常首次加载时工具已在，直接跳过，不会重复注册）。
 */
function reensureTools() {
  try {
    if (typeof api?.tools?.get === 'function' && api.tools.get('surf_now') && api.tools.get('surf_status')) return;
  } catch { /* 拿不到工具表就按需要重注册 */ }
  try { registerTools(); } catch (e) { warn(`重新注册工具失败：${e?.message ?? e}`); }
}

export function activate() {
  // 开关被重新打开时，重新排班（避免"关掉再打开后定时器不再启动"）
  if (api) {
    reensureTools();
    log('已被启用，重新排班');
    scheduleNext();
  }
}

export function deactivate() {
  // 必须清掉定时器：否则"开关关了但定时器还在"（加载器明确按这个语义设计生命周期）
  if (timer) { clearTimeout(timer); timer = null; }
  running = false;
  log('已被关闭，定时器已清除');
}

export function available() {
  return { ok: true };
}

/* ── 给自检脚本用的内部出口（不影响运行）────────────────────────────────── */
export const internals = {
  settings, runCycle, decideTopic, writePost, parseTopicJson,
  htmlToText, blockedByDomain, fetchPageText, inQuietHours, nextDelayMs,
  normalizeTarget, defaultTarget, sendTextTo, webSearch, parseBingRss,
  recentChatLines, coreConfig, loadState, saveState,
  __setApi: (a) => { api = a; },
  __state: () => ({ lastRunAt, lastResult, running, hasTimer: !!timer })
};
