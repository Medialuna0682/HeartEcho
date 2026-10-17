/**
 * 日志：分级、内存环形缓冲（面板实时日志用）、按天轮转落盘、敏感字段脱敏、保留期清理。
 *
 * 契约（对应规划书 14.5 可观察性）：
 *   - 统一 traceId 贯穿 OneBot 事件 → 规则判定 → 记忆检索 → 模型调用 → 出站投递
 *   - DEBUG/INFO/WARN/ERROR 分级，日志可按 scope/关键词检索
 *   - API Key、accessToken、Cookie 一律脱敏后才允许写出
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 1200;

/** 需要脱敏的键名（大小写不敏感）。 */
const SECRET_KEYS = /^(api_?key|access_?token|authorization|password|secret|cookie|skey|p_skey|token)$/i;

/** 形如 sk-xxxx / 32 位以上不透明串的密钥，直接打码。 */
const SECRET_INLINE = [
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}\b/g, "$1…"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1***"],
  [/\b(accessToken"?\s*[:=]\s*"?)([A-Za-z0-9._~+/-]{6})[A-Za-z0-9._~+/-]*/gi, "$1$2…"],
];

export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function redact(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let out = value;
    for (const [pattern, replacement] of SECRET_INLINE) out = out.replace(pattern, replacement);
    return out;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? (item ? maskSecret(item) : item) : redact(item, depth + 1);
  }
  return out;
}

export function redactText(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRET_INLINE) out = out.replace(pattern, replacement);
  return out;
}

const ring = [];
const listeners = new Set();

export function recentLogs(limit = 300) {
  return ring.slice(-limit);
}

/** 订阅实时日志（面板 SSE 用），返回取消订阅函数。 */
export function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let currentLevel = LEVELS[(process.env.HEARTECHO_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
export function setLogLevel(name) {
  currentLevel = LEVELS[String(name || "").toLowerCase()] ?? currentLevel;
  return Object.keys(LEVELS).find((key) => LEVELS[key] === currentLevel) ?? "info";
}
export function getLogLevel() {
  return Object.keys(LEVELS).find((key) => LEVELS[key] === currentLevel) ?? "info";
}

function dayStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function writeLine(line) {
  try {
    const file = path.join(paths.logs, `heartecho-${dayStamp()}.log`);
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    /* 磁盘写不进去也不能让业务挂掉 */
  }
}

/** 按保留天数清理旧日志（规划书附录 A：默认 14 天）。 */
export function pruneLogs(keepDays = 14) {
  try {
    const cutoff = Date.now() - Math.max(1, keepDays) * 86400000;
    for (const name of fs.readdirSync(paths.logs)) {
      if (!/^heartecho-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = path.join(paths.logs, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    /* ignore */
  }
}

export function createLogger(scope = "App") {
  const emit = (level, message, meta) => {
    if (LEVELS[level] < currentLevel) return undefined;
    const at = new Date();
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}:${String(at.getSeconds()).padStart(2, "0")}`;
    const entry = {
      at: at.getTime(),
      time,
      level,
      scope,
      message: redactText(message),
      meta: meta === undefined ? undefined : redact(meta),
    };
    if (entry.meta !== undefined && typeof entry.meta === "object" && entry.meta !== null) {
      // 把结构化 meta 摘成一行，便于人看也便于检索
      const flat = Object.entries(entry.meta)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
        .join(" ");
      if (flat) entry.line = `${entry.time} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}｜${flat}`;
    }
    entry.line ??= `${entry.time} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}`;
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        /* 某个订阅者出错不影响别人 */
      }
    }
    // 打包成 GUI 子系统的 exe 后没有控制台，往 stdout 写可能失败；
    // 这不算错误（日志本来就落盘了），绝不能让日志本身把业务带崩。
    try {
      const console_ = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      console_(entry.line);
    } catch {
      /* 没有可写的控制台 */
    }
    writeLine(entry.line);
    return entry;
  };

  return {
    scope,
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    /** 带 traceId 的子日志器：一次对话链路的所有日志都能串起来。 */
    trace: (traceId) => {
      const child = createLogger(`${scope}:${String(traceId).slice(0, 8)}`);
      return child;
    },
    entry: emit,
  };
}

export { LEVELS };
