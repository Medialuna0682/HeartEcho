/**
 * 通用工具：Token 估算、文本清洗、时间格式化、作用域键、集合运算。
 * 全部纯函数，便于单元测试（规划书 18.1：单元层针对纯逻辑）。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

/** 粗略估算 token 数：CJK 约 1 字 1 token，拉丁文约 4 字符 1 token。 */
export function estimateTokens(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const message of messages ?? []) {
    const content = message?.content;
    if (typeof content === "string") total += estimateTokens(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text") total += estimateTokens(part.text);
        else total += 400; // 一张图按固定额度估算
      }
    }
    total += 4; // 每条消息的角色与分隔开销
  }
  return total;
}

export function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/** 去掉模型爱加的括号动作、markdown、前缀名，留下能直接发出去的文本。 */
export function cleanReply(text, { characterName = "" } = {}) {
  let out = String(text ?? "").trim();
  out = out.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```/g, ""));
  if (characterName) {
    out = out.replace(new RegExp(`^\\s*（?${escapeRegExp(characterName)}）?\\s*[:：]\\s*`, ""), "");
  }
  out = out.replace(/^\s*(助手|AI|assistant|机器人)\s*[:：]\s*/i, "");
  out = out.replace(/（[^（）]{0,60}）|\([^()]{0,60}\)/g, "");
  out = out.replace(/【[^【】]{0,20}】/g, "");
  out = out.replace(/\*\*|__|##+/g, "");
  out = out.replace(/\r/g, "");
  out = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return out.trim();
}

export function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 去掉 emoji / 颜文字（设置里关掉 emoji 时的硬兜底）。 */
export function stripEmoji(text) {
  return String(text ?? "")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\u2600-\u27BF]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。！？、；：）】」])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 全半角与大小写归一化（屏蔽词匹配用）。 */
export function normalizeForMatch(text) {
  let out = String(text ?? "");
  out = out.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  out = out.replace(/[\u3000]/g, " ");
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return out.toLowerCase();
}

/**
 * 把一段回复切成 1~N 条自然的短消息。
 * 先按换行分段，超长段按标点断句，多余的合并到最后一条，避免刷屏。
 */
export function splitBubbles(text, { maxChars = 180, maxBubbles = 3, enabled = true } = {}) {
  const cleaned = cleanReply(text);
  if (!cleaned) return [];
  if (!enabled) return [cleaned.slice(0, maxChars * maxBubbles)];

  const hardLimit = Math.max(20, Number(maxChars) || 180);
  const limit = Math.max(1, Number(maxBubbles) || 3);

  let parts = cleaned
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

  const expanded = [];
  for (const part of parts) {
    if (part.length <= hardLimit) {
      expanded.push(part);
      continue;
    }
    let rest = part;
    while (rest.length > hardLimit) {
      const window = rest.slice(0, hardLimit + 1);
      const cut = Math.max(
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf("～"),
        window.lastIndexOf("~"),
        window.lastIndexOf("，"),
      );
      const at = cut > hardLimit * 0.4 ? cut + 1 : hardLimit;
      expanded.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) expanded.push(rest);
  }

  parts = expanded.filter(Boolean);
  if (parts.length <= limit) return parts;
  const head = parts.slice(0, limit - 1);
  const tail = parts.slice(limit - 1).join(" ");
  return [...head, tail.slice(0, hardLimit * 2)];
}

export function formatNow(date = new Date()) {
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${week} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monthKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function monthDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 解析 "HH:MM" → 分钟数；解析不出来返回 null。 */
export function parseHm(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 判断当前时间是否落在 [from, to) 静默时段内，支持跨午夜。 */
export function inQuietHours(range, date = new Date()) {
  if (!range?.enabled) return false;
  const from = parseHm(range.from);
  const to = parseHm(range.to);
  if (from === null || to === null) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CJK 友好的分词：中文取二元组，西文按词，供倒排索引使用。 */
export function tokenize(text) {
  const value = String(text ?? "");
  const tokens = new Set();
  const cjkRuns = value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  const words = value.toLowerCase().match(/[a-z0-9_]{1,}/g) ?? [];
  for (const word of words) {
    tokens.add(word);
    if (word.length > 6) tokens.add(word.slice(0, 6));
  }
  const kana = value.match(/[\u3040-\u30ff]{2,}/g) ?? [];
  for (const run of kana) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens].filter((token) => token.length >= 1 && token.length <= 24).slice(0, 200);
}

export function unique(list) {
  return [...new Set(list)];
}

export function groupBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const key = keyFn(item);
    const bucket = out.get(key) ?? [];
    bucket.push(item);
    out.set(key, bucket);
  }
  return out;
}

export function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj && key in obj) out[key] = obj[key];
  return out;
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 从模型输出里抠出第一个 JSON 对象/数组（结构化输出解析失败时返回 null）。 */
export function extractJson(text) {
  const value = String(text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
  const candidate = fenced ? fenced[1] : value;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return safeJsonParse(candidate.slice(start, i + 1), null);
    }
  }
  return null;
}

/** 时间字符串 → 时间戳；失败返回 null。 */
export function parseTime(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const normalized = value.replace(/\//g, "-").replace(" ", "T");
  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime())) return direct.getTime();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]?(\d{1,2})?:?(\d{1,2})?/.exec(normalized);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 9),
    Number(match[5] ?? 0),
  );
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function formatTime(ts, { withDate = true } = {}) {
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (!withDate) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return "从未";
  const diff = now - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatTime(ts, { withDate: true });
}
