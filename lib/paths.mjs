/**
 * 目录解析（规划书 17.2 数据目录布局）。
 *
 * 优先级：
 *   1. 环境变量 HEARTECHO_APP_DIR / HEARTECHO_DATA_DIR / HEARTECHO_LOG_DIR / HEARTECHO_SETTINGS
 *   2. 程序目录下的「心语设置.json」
 *   3. 默认：跑源码时用 <程序目录>\data，打包成单文件时用 <exe 同级>\data
 *
 * 数据目录与程序目录彻底分离：把 exe 放到任意可写目录都能跑，用户数据不需要跟着程序走。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function detectSea() {
  try {
    const sea = process.getBuiltinModule?.("node:sea");
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

export const isSea = detectSea();
export const isInstalled = process.env.HEARTECHO_INSTALLED === "1";
export const installRoot = isInstalled ? path.resolve(process.env.HEARTECHO_INSTALL_ROOT || process.env.HEARTECHO_APP_DIR || ".") : "";

/**
 * 是不是跑在「打包好的单文件」里。
 * 打包时 import.meta.url 会被 esbuild 改写成 CJS shim（值不可靠），
 * 所以打包脚本会注入 globalThis.__HEARTECHO_BUNDLED__ = true，这里优先看它。
 */
const BUNDLED = process.env.HEARTECHO_BUNDLED === "1" || globalThis.__HEARTECHO_BUNDLED === true || isSea;

/** 代码根目录（跑源码时是 lib 的上一级；打包后就是 exe 所在目录）。 */
export const ROOT = (() => {
  if (process.env.HEARTECHO_APP_DIR) return path.resolve(process.env.HEARTECHO_APP_DIR);
  if (BUNDLED) return path.dirname(process.execPath);
  try {
    if (typeof __dirname === "string" && __dirname) return path.resolve(__dirname, "..");
  } catch {
    /* 继续往下试 */
  }
  try {
    return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return process.cwd();
  }
})();

export const APP_DIR = process.env.HEARTECHO_APP_DIR
  ? path.resolve(process.env.HEARTECHO_APP_DIR)
  : BUNDLED
    ? path.dirname(process.execPath)
    : ROOT;

export const SETTINGS_FILE = process.env.HEARTECHO_SETTINGS
  ? path.resolve(process.env.HEARTECHO_SETTINGS)
  : path.join(APP_DIR, "心语设置.json");

export const DEFAULT_SETTINGS = {
  dataDir: "",
  logDir: "",
  snowlumaDir: "",
  /**
   * 启动心语时如果协议端没在跑，自动把它拉起来。
   * 安装版默认关闭，等用户自行安装并确认协议端条款后再选择开启。
   */
  autoStartProtocol: !isInstalled,
  openPanelOnStart: true,
  closeWindowTo: "ask",
};

/**
 * 默认的协议端目录。
 *
 * 默认检查程序目录附近的协议端；安装包不包含协议端，用户需自行准备。
 */
function defaultProtocolDir() {
  const candidates = [
    // ① 首选：用户放在程序目录下的协议端
    path.join(APP_DIR, "protocol"),
    SOURCE_MODE ? path.join(ROOT, "protocol") : "",
    // ② 打包后 exe 旁边可能也放了一份
    process.execPath ? path.join(path.dirname(process.execPath), "protocol") : "",
  ].filter(Boolean);
  for (const item of candidates) {
    try {
      if (fs.existsSync(path.join(item, "index.mjs")) || fs.existsSync(path.join(item, "config"))) return item;
    } catch {
      /* ignore */
    }
  }
  // ③ 兜底：同级目录里如果已经有一份协议端（比如从别的项目迁过来的），顺着用
  for (const legacy of [process.env.HEARTECHO_LEGACY_PROTOCOL || "", SOURCE_MODE ? path.resolve(APP_DIR, "..") : ""].filter(Boolean)) {
    try {
      if (fs.existsSync(path.join(legacy, "config"))) return legacy;
    } catch {
      /* ignore */
    }
  }
  return path.join(APP_DIR, "protocol");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function loadSettings() {
  return { ...structuredClone(DEFAULT_SETTINGS), ...readJson(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...(patch ?? {}) };
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

export const settings = loadSettings();

function resolveDir(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(APP_DIR, text);
}

const SOURCE_MODE = !BUNDLED && !isInstalled && APP_DIR === ROOT;

/**
 * 默认数据目录。
 *   跑源码：<项目>\data（开发最直观）
 *   跑打包好的 exe：%LOCALAPPDATA%\心语 —— 符合 Windows 单机软件习惯，
 *   也不会因为 exe 被放在只读目录（比如 Program Files）而写不进去。
 *   「心语设置.json」里的 dataDir 一旦填了，就以它为准。
 */
function defaultDataDir() {
  if (isInstalled && process.env.HEARTECHO_INSTANCE === "1") return path.join(APP_DIR, "data");
  if (process.env.HEARTECHO_EDITION === "tb" && process.env.HEARTECHO_TB_DATA_DEFAULT && process.env.HEARTECHO_INSTANCE !== "1") return path.resolve(process.env.HEARTECHO_TB_DATA_DEFAULT);
  if (SOURCE_MODE) return path.join(APP_DIR, "data");
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "心语");
}

const DATA_DIR = resolveDir(
  process.env.HEARTECHO_DATA_DIR || settings.dataDir,
  defaultDataDir(),
);
const LOG_DIR = resolveDir(
  process.env.HEARTECHO_LOG_DIR || settings.logDir,
  process.env.HEARTECHO_EDITION === "tb" && process.env.HEARTECHO_INSTANCE !== "1" && process.env.HEARTECHO_TB_LOG_DEFAULT ? path.resolve(process.env.HEARTECHO_TB_LOG_DEFAULT) : path.join(DATA_DIR, "logs"),
);

export const paths = {
  root: ROOT,
  app: APP_DIR,
  sourceMode: SOURCE_MODE,
  installed: isInstalled,
  installRoot,
  settings: SETTINGS_FILE,
  data: DATA_DIR,
  config: path.join(DATA_DIR, "config.json"),
  characters: path.join(DATA_DIR, "characters"),
  database: path.join(DATA_DIR, "database"),
  mainDb: path.join(DATA_DIR, "database", "main.db"),
  logs: LOG_DIR,
  exports: path.join(DATA_DIR, "exports"),
  backups: path.join(DATA_DIR, "backups"),
  cache: path.join(DATA_DIR, "cache"),
  media: path.join(DATA_DIR, "media"),
  state: path.join(DATA_DIR, "state"),
  snowluma: resolveDir(
    process.env.HEARTECHO_SNOWLUMA_DIR || settings.snowlumaDir,
    defaultProtocolDir(),
  ),
};

export function ensureDirs() {
  for (const dir of [
    paths.data,
    paths.characters,
    paths.database,
    paths.logs,
    paths.exports,
    paths.backups,
    paths.cache,
    paths.media,
    paths.state,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export { readJson, writeJsonAtomic as writeJson };
