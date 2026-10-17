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

/**
 * 「只有开场白、没有正文」的回复。
 *
 * 这是实测出来的真实故障：角色卡里写着「不会说教式的长篇大论」「句子之间有停顿感，但整体仍然简短」，
 * 模型被问到「你怎么看」「你说吧」时，会只回一句
 *   「嗯，我按我理解的说哦，不专业的地方你别笑我呀。」
 * 然后停在那里——正文一个字都没有。更糟的是它会照抄自己历史里的这类回复，越陷越深：
 * 用户催了三次，三次都只得到新的开场白，只是每次换个说法（「按我知道的说一点」「不一定准」「没医生那么准」）。
 *
 * 往提示词里加「必须说正文」压不住（A/B 实测：加了规则仍然 0/3 给出正文），
 * 所以这里做确定性识别，识别出来之后由 chat.mjs 用「接着说」把正文补回来。
 *
 * 判据分两档，因为「免责声明」这种话本身也可能出现在一句正常的软话里
 * （「我也不会说什么漂亮话，你别笑我呀」）：
 *   ① 硬判据：明确在推迟（「等你想听我再讲」「让我想想」）或只宣布「那我讲啦」 —— 永远算卡壳；
 *   ② 软判据：既有「宣布要讲」又有「免责/谦虚」—— 只有对方确实在要内容时才算卡壳。
 */
const STALL_POSTPONE = /(等你想听|以后再(慢慢)?(讲|说|聊)|慢慢(讲|说)给你听|让我(先)?想想|我想想(看)?|让我组织一下|整理一下(思路)?)/;
const STALL_ANNOUNCE = /(说说|讲讲|我说|我讲|直接讲|直接说|按.{0,6}理解|按.{0,6}知道|把我知道的|我知道的|说一点|讲一点)/;
const STALL_HEDGE = /(别笑|不准|不一定|不专业|说得不对|讲错|不太懂|不敢说|不保证|不确定|仅供参考|知道一点点|知道一点|懂一点|懂得不多|说得笨|说得浅)/;
/** 「那我讲啦」「我直接说了哦」——没有正面词表，靠「讲话动词 + 语气词收尾」兜住。 */
const STALL_TAIL = /(讲|说|告诉你|讲给你)(啦|了|哦|呀|呢|吧)?$/;
/** 对方这句话是不是在要内容（要看法、要解释、让你接着讲）。 */
const CONTENT_REQUEST =
  /(说说|讲讲|讲一讲|说一说|看法|你觉得|你怎么想|怎么想|怎么看|为什么|是什么|啥意思|了解|解释|分析|介绍|科普|评价|告诉我|接着|然后呢|继续|你说|说吧|讲吧)/;

/**
 * 判断一次回复是不是「卡在开场白」。
 * text 可以是字符串，也可以是已经拆好的气泡数组。
 * userText 传对方那句话——「要内容却没有内容」只能对着问题判断。
 *
 * 光靠词表不行：模型每次换一种说法（「按我理解的说」→「按我知道的说一点」→「说得笨你别笑」），
 * 所以最可靠的一条是「对方在要内容，而她只回了很短一句」——这不管怎么措辞都不算回答。
 */
export function isStallReply(text, { userText = "" } = {}) {
  const parts = Array.isArray(text) ? text : String(text ?? "").split("\n");
  const joined = parts.map((item) => String(item ?? "").trim()).filter(Boolean).join("");
  // 去掉标点与省略号后再判断，避免「……」「～」把长度和结尾锚点搞乱
  const compact = joined.replace(/[\s，,。.…~～!！?？、；;：:]/g, "");
  if (!compact) return false;
  // 抓到正文的回复不会这么短（实测卡壳都在 30 字以内，有正文的回复都超过 40 字）
  if (compact.length > 60) return false;

  if (STALL_POSTPONE.test(compact)) return true;
  if (compact.length <= 16 && STALL_TAIL.test(compact)) return true;
  if (compact.length <= 22 && /知道(一点点|一点|的不多)/.test(compact)) return true;
  // 又宣布要讲、又先打预防针，却一句正文都没展开
  if (compact.length <= 45 && STALL_ANNOUNCE.test(compact) && STALL_HEDGE.test(compact)) return true;
  // 对方在要内容，她只回了很短一句「那我讲讲哦」这种纯宣布
  if (compact.length <= 14 && STALL_ANNOUNCE.test(compact) && CONTENT_REQUEST.test(String(userText ?? ""))) return true;
  return false;
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
