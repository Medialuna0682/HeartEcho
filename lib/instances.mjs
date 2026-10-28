/**
 * 多实例（一个 QQ 账号 = 一个实例 = 一个角色）。
 *
 * 为什么要做成「一个实例」而不是「一个进程里挂多个账号」：
 *   心语整条链路都是围绕「当前机器人号 + 当前角色卡」写的——
 *   记忆作用域、关系值、日记作用域、配置、面板端口、协议端登录态，
 *   全都是单份的。在一个进程里塞两个账号，等于把这些东西全部改成多路复用，
 *   任何一个地方漏掉隔离都会串台（把 A 的私聊记忆喂给 B 的角色）。
 *   而进程级的隔离本来是天然存在的：数据目录、配置、端口、锁、协议端登录，
 *   按目录分开就互不干扰。所以这里选「新账号 = 新实例」。
 *
 * 实例的形态：
 *   <程序目录>/instances/<id>/
 *     心语设置.json          ← 指向实例自己的 data；协议端指向主实例那一份（共用）
 *     data/config.json       ← 独立的配置（自己的端口、自己的账号）
 *     data/characters/*.json ← 独立的角色卡
 *
 * 协议端为什么必须共用：
 *   SnowLuma 靠往 QQ 客户端进程里注入 hook 收发消息，一个 QQ 进程只认一份 hook。
 *   如果每个实例各跑一份协议端，后启动的那份会抢不到钩子、先启动的那份被抢掉，
 *   表现就是「A 好好的，启动 B 之后 A 掉线」。所以整台机器只跑一份协议端
 *   （放在主实例目录下），每个实例只把自己的 QQ 号写进它的 config。
 *
 * 启动方式是 `心语.exe --instance <目录>`，见 lib/boot-env.mjs。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { paths, isSea, loadSettings } from "./paths.mjs";
import { getConfig, activeCharacterId, loadCharacter } from "./config.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("Instances");

/**
 * 实例的「家」目录：登记表和 instances/ 都放在这里。
 * 默认就是程序目录（打包后是 exe 旁边），自检时会用环境变量指到临时目录，
 * 免得把测试实例写进用户真正的程序目录里。
 */
const instanceSettings = loadSettings();
const HOME = path.resolve(process.env.HEARTECHO_INSTANCES_HOME || instanceSettings.instancesHome || paths.app);
const MAIN_DATA_DIR = path.resolve(process.env.HEARTECHO_INSTANCES_MAIN_DATA_DIR || instanceSettings.instancesMainDataDir ||
  (HOME === path.resolve(paths.app) ? paths.data : path.join(HOME, "data")));
const REGISTRY_FILE = path.join(HOME, "instances.json");
const INSTANCES_DIR = path.join(HOME, "instances");
// paths.root 在子实例里是数据/配置的根，不是源码入口所在目录。
const SOURCE_ENTRY = isSea ? "" : fileURLToPath(new URL("../index.mjs", import.meta.url));

const DEFAULT_PANEL_BASE = 5311;
const DEFAULT_ONEBOT_BASE = 3101;
const DEFAULT_WEBUI_BASE = 5099;

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 读纯文本文件（panel-token 就是 64 个十六进制字符，不是 JSON）。 */
function readTextSafe(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return fallback;
  }
}

export function registryFile() {
  return REGISTRY_FILE;
}

export function readRegistry() {
  const raw = readJsonSafe(REGISTRY_FILE, { instances: [] });
  const list = Array.isArray(raw?.instances) ? raw.instances : [];
  return list
    .filter((item) => item && typeof item.dir === "string" && item.dir)
    .map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
      dir: path.resolve(String(item.dir)),
      accountId: String(item.accountId ?? ""),
      createdAt: Number(item.createdAt) || 0,
      note: String(item.note ?? ""),
    }));
}

function writeRegistry(list) {
  writeJsonSafe(REGISTRY_FILE, { version: 1, instances: list });
}

/** 实例目录下的设置文件路径（主实例就是常规位置）。 */
export function settingsFileOf(dir) {
  return path.join(path.resolve(dir), "心语设置.json");
}

export function dataDirOf(dir) {
  if (path.resolve(dir) === path.resolve(paths.app)) return paths.data;
  if (path.resolve(dir) === HOME) return MAIN_DATA_DIR;
  const settings = readJsonSafe(settingsFileOf(dir), {});
  const value = String(settings.dataDir ?? "").trim();
  if (!value) return path.join(dir, "data");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(dir, value);
}

export function configFileOf(dir) {
  return path.join(dataDirOf(dir), "config.json");
}

export function protocolDirOf(dir) {
  if (path.resolve(dir) === path.resolve(paths.app)) return paths.snowluma;
  const settings = readJsonSafe(settingsFileOf(dir), {});
  return path.resolve(dir, settings.snowlumaDir || "protocol");
}

/**
 * 多实例的「管理根目录」（登记表、instances/、共用的协议端都在它下面）。
 * 主实例里通常就是程序目录，子实例通过环境变量继承。
 */
export function instancesHome() {
  return HOME;
}

/**
 * 这台机器上所有实例共用的那一份协议端目录。
 *
 * 就是「管理根目录」下面那份（主实例的 protocol/）。子实例的 snowlumaDir
 * 会被写成这个绝对路径，因此它们读写的是同一份 config（一个 QQ 号一个文件），
 * 但数据、日志、端口仍然各自独立。
 */
export function sharedProtocolDir() {
  return protocolDirOf(HOME);
}

/** 只维护心语使用的服务；保留协议端的其它设置和额外网络服务。 */
function syncInstanceProtocol(dir) {
  const protocolDir = protocolDirOf(dir);
  if (!fs.existsSync(protocolDir)) return { ok: false, reason: "协议端目录还不存在" };
  const config = readJsonSafe(configFileOf(dir), null);
  if (!config?.bot?.selfId) throw new Error("实例缺少机器人 QQ 配置");
  const ws = new URL(config.bot.onebotWsUrl);
  const http = new URL(config.bot.onebotHttpUrl);
  const file = path.join(protocolDir, "config", `onebot_${config.bot.selfId}.json`);
  const existing = readJsonSafe(file, null);
  // 配置损坏时不能静默覆盖用户原文件。
  if (!existing && fs.existsSync(file)) throw new Error(`协议端账号配置读不出来：${file}`);
  const beforeText = existing ? JSON.stringify(existing) : "";
  const account = existing || {};
  const networks = account.networks || {};
  const upsert = (servers, server) => {
    const list = Array.isArray(servers) ? [...servers] : [];
    let index = list.findIndex((item) => item.name === server.name || Number(item.port) === server.port);
    if (index < 0 && list.length === 1) index = 0;
    if (index < 0) list.push(server);
    else list[index] = { ...list[index], ...server };
    return list;
  };
  const common = { host: "127.0.0.1", accessToken: config.bot.accessToken, messageFormat: "array", reportSelfMessage: false };
  account.networks = {
    httpClients: [], wsClients: [], ...networks,
    wsServers: upsert(networks.wsServers, { ...common, name: "ws-heartecho", port: Number(ws.port || 80), path: ws.pathname, role: "Universal" }),
    httpServers: upsert(networks.httpServers, { ...common, name: "http-heartecho", port: Number(http.port || 80), path: http.pathname, enableWebSocket: false }),
  };
  const changed = beforeText !== JSON.stringify(account);
  if (changed) writeJsonSafe(file, account);
  return { ok: true, file, changed, created: !existing };
}

/** 端口是否已经有人在听（用来挑一个空闲端口）。 */
export function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function pickPort(start, taken = new Set()) {
  for (let port = start; port < start + 200; port += 1) {
    if (taken.has(port)) continue;
    if (!(await portInUse(port))) return port;
  }
  throw new Error(`从 ${start} 开始连着 200 个端口都被占用了，请手动指定`);
}

/**
 * 探测一个实例是不是活着：直接打它的面板。
 * 用面板而不是 pid，是因为面板能同时告诉我们「哪个角色在线」。
 */
export async function probeInstance(dir, { timeoutMs = 900 } = {}) {
  const dataDir = dataDirOf(dir);
  const token = readTextSafe(path.join(dataDir, "panel-token"));
  const config = readJsonSafe(configFileOf(dir), {});
  const port = Number(config?.bot?.panelPort) || DEFAULT_PANEL_BASE;
  if (!token) return { alive: false, port, reason: "还没启动过" };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { alive: false, port, reason: `面板返回 ${res.status}` };
    const status = await res.json();
    return {
      alive: true,
      port,
      selfId: String(status?.bot?.selfId ?? config?.bot?.selfId ?? ""),
      character: status?.character?.name ?? "",
      model: status?.llm?.model ?? "",
      online: Boolean(status?.onebot?.online),
    };
  } catch (error) {
    return { alive: false, port, reason: String(error?.message ?? error).slice(0, 80) };
  }
}

/**
 * 列出所有实例（主实例 + 登记过的子实例），带活着的状态。
 *
 * 主实例就是程序目录本身——用户现在正在用的那个，
 * 它不在登记表里，但必须出现在列表里，否则「新增一个」会看起来像只有一份。
 */
export async function listInstances() {
  const registry = readRegistry();
  const currentDir = path.resolve(paths.app);
  const entries = [
    { id: "main", name: "主实例", dir: HOME, accountId: "", createdAt: 0, note: "" },
    ...registry,
    { id: "current", name: "当前实例", dir: currentDir, accountId: "", createdAt: 0, note: "" },
  ].filter((item, index, arr) => arr.findIndex((x) => path.resolve(x.dir) === path.resolve(item.dir)) === index)
    .map((item) => ({ ...item, current: path.resolve(item.dir) === currentDir }));

  const out = [];
  for (const item of entries) {
    const config = readJsonSafe(configFileOf(item.dir), {});
    const probe = await probeInstance(item.dir);
    out.push({
      id: item.id,
      name: item.name || path.basename(item.dir),
      dir: item.dir,
      current: Boolean(item.current),
      accountId: String(config?.bot?.selfId ?? item.accountId ?? ""),
      masterId: String(config?.bot?.masterId ?? ""),
      panelPort: Number(config?.bot?.panelPort) || DEFAULT_PANEL_BASE,
      characterId: String(config?.activeCharacter ?? ""),
      character: probe.character || "",
      online: Boolean(probe.online),
      alive: probe.alive,
      reason: probe.reason || "",
      note: item.note || "",
    });
  }
  return out;
}

/** 这个 QQ 号在别的实例里被占用了吗？（同账号只能开一个实例） */
export async function findAccountConflict(accountId, { excludeDir = "" } = {}) {
  const target = String(accountId ?? "").trim();
  if (!target) return null;
  const others = await listInstances();
  for (const item of others) {
    if (path.resolve(item.dir) === path.resolve(excludeDir)) continue;
    if (String(item.accountId) !== target) continue;
    if (!item.alive) continue;
    return item;
  }
  return null;
}

/* ---------------------------- 账号占位（跨目录） ---------------------------- */

/**
 * 登记表只记得「从面板建出来的实例」，管不到用户手动复制出来的目录。
 * 所以再加一份**按 QQ 号**的占位文件，放在这台机器上所有实例都能看到的地方：
 *   %LOCALAPPDATA%\HeartEcho\accounts\<QQ>.json
 * 里面记着 pid / 数据目录 / 面板端口。启动时先看这个号有没有活着的占位，
 * 退出时删掉自己的；占位里的进程已经死了就当作没占（避免崩溃后永远起不来）。
 */
function claimDir() {
  if (process.env.HEARTECHO_CLAIM_DIR) return path.resolve(process.env.HEARTECHO_CLAIM_DIR);
  const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".heartecho");
  return path.join(base, "HeartEcho", "accounts");
}

export function accountClaimPath(selfId) {
  return path.join(claimDir(), `${String(selfId).replace(/[^0-9]/g, "")}.json`);
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但没权限发信号，也算活着
    return error?.code === "EPERM";
  }
}

export function readAccountClaim(selfId) {
  const claim = readJsonSafe(accountClaimPath(selfId), null);
  if (!claim || typeof claim !== "object") return null;
  const startedAt = Number(claim.startedAt) || 0;
  // 进程还在 + 占位不是太旧 —— 两个条件都满足才算「真的被占着」。
  // 只看 pid 会被 Windows 的 pid 复用坑到：老占位里的 pid 后来被别的程序占了，
  // 这个号就永远起不来。所以再加一条「超过 7 天当作没占」的兜底。
  const fresh = startedAt > 0 && Date.now() - startedAt < 7 * 86400000;
  return {
    pid: Number(claim.pid) || 0,
    dir: String(claim.dir ?? ""),
    dataDir: String(claim.dataDir ?? ""),
    panelPort: Number(claim.panelPort) || 0,
    startedAt,
    alive: pidAlive(claim.pid) && fresh,
  };
}

export function claimAccount(selfId, { dir = paths.app, dataDir = paths.data, panelPort = 0 } = {}) {
  const self = String(selfId ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(self)) return { ok: false, reason: "机器人 QQ 号还没设置" };
  const file = accountClaimPath(self);
  const existing = readAccountClaim(self);
  if (existing && existing.alive && existing.pid !== process.pid) {
    const where = existing.panelPort ? `（面板端口 ${existing.panelPort}）` : "";
    return { ok: false, reason: `QQ ${self} 已经被另一个实例${where}占着，同一个账号只能开一个实例` };
  }
  writeJsonSafe(file, {
    pid: process.pid,
    dir: path.resolve(dir),
    dataDir: path.resolve(dataDir),
    panelPort: Number(panelPort) || 0,
    startedAt: Date.now(),
  });
  return { ok: true, file };
}

export function releaseAccountClaim(selfId) {
  const file = accountClaimPath(selfId);
  const claim = readJsonSafe(file, null);
  // 只删自己的那份：万一别人已经接管了这个号，别把别人的占位删掉
  if (claim && Number(claim.pid) !== process.pid) return { ok: false, reason: "不是本进程的占位" };
  try {
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 启动前检查：这个号是不是已经在别处跑着了。
 * 两条来源都查——登记表里的实例（能问出名字）和占位文件（包括手动复制的目录）。
 */
export async function findAccountHolder(accountId, { excludeDir = "", excludeDataDir = "" } = {}) {
  const self = String(accountId ?? "").trim();
  if (!self) return null;
  const claim = readAccountClaim(self);
  if (claim && claim.alive) {
    /*
     * 「自己占自己」要同时满足：程序目录一样**并且**数据目录一样。
     * 只比程序目录是不够的——跑源码时两个实例的程序目录都是仓库根，
     * 数据目录才是它们的真正身份标记。
     */
    const sameProgramDir = Boolean(excludeDir) && Boolean(claim.dir) && path.resolve(claim.dir) === path.resolve(excludeDir);
    const sameDataDir = !excludeDataDir || (Boolean(claim.dataDir) && path.resolve(claim.dataDir) === path.resolve(excludeDataDir));
    const sameInstance = sameProgramDir && sameDataDir;
    if (!sameInstance) {
      return {
        name: path.basename(claim.dataDir || claim.dir) || "另一个实例",
        dir: claim.dir,
        dataDir: claim.dataDir,
        panelPort: claim.panelPort,
        source: "claim",
        pid: claim.pid,
      };
    }
  }
  const registered = await findAccountConflict(self, { excludeDir });
  return registered ? { ...registered, source: "registry" } : null;
}

function slugify(name) {
  const base = String(name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-");
  return (base || "instance").slice(0, 40);
}

/**
 * 复制一份协议端程序，但**不带别人的登录态**。
 *
 * 必须清掉的东西：
 *   config/onebot_<qq>.json —— 那是某个 QQ 的登录配置，带过去就会顶替别人的号
 *   data/ logs/             —— QQ 会话、缓存、日志，都属于上一个账号
 *   config/webui.json       —— WebUI 密码哈希，新实例应该自己生成
 * runtime.json 只保留，但把 WebUI 端口换成自己的，否则两个协议端会抢 5099。
 */
function copyProtocol(sourceDir, targetDir, { webuiPort }) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return { ok: false, reason: "没有可复制的协议端目录" };
  fs.mkdirSync(targetDir, { recursive: true });
  // node_modules 是协议端的运行依赖，不是登录态，必须一起复制。
  const skipTop = new Set(["data", "logs"]);
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(sourceDir, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (skipTop.has(top)) return false;
      if (rel === path.join("config", "webui.json")) return false;
      if (/^onebot_\d+\.json$/.test(path.basename(rel)) && path.dirname(rel) === "config") return false;
      return true;
    },
  });
  const runtimeFile = path.join(targetDir, "config", "runtime.json");
  const runtime = readJsonSafe(runtimeFile, {});
  runtime.webuiPort = Number(webuiPort);
  runtime.webuiHost = runtime.webuiHost || "127.0.0.1";
  writeJsonSafe(runtimeFile, runtime);
  const configDir = path.join(targetDir, "config");
  if (fs.existsSync(configDir)) {
    for (const name of fs.readdirSync(configDir)) {
      if (/^onebot_\d+\.json$/.test(name)) fs.rmSync(path.join(configDir, name), { force: true });
    }
  }
  return { ok: true, dir: targetDir, webuiPort: Number(webuiPort) };
}

/**
 * 新建一个实例。
 *
 * 只做「把目录和配置准备好」这件事：
 *   - 端口自动挑空闲的（面板 / OneBot WS+HTTP / 协议端 WebUI 各一个）；
 *   - 角色卡从当前实例复制一张过去（用户也可以之后在面板里改）；
 *   - 协议端复制一份干净副本，登录那个 QQ 仍然需要用户自己扫码
 *     （QQ 登录没有可以自动化的接口，这一步只能人来）。
 */
export async function createInstance({ name, accountId, masterId = "", masterName = "", characterId = "", copyProtocolDir = true } = {}) {
  const selfId = String(accountId ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(selfId)) throw new Error("机器人 QQ 号必须是有效数字");
  const master = String(masterId ?? "").trim();
  if (master && !/^[1-9][0-9]*$/.test(master)) throw new Error("对方 QQ 号必须是有效数字");
  const label = String(name ?? "").trim() || `实例-${selfId}`;

  const registry = readRegistry();
  if (registry.some((item) => String(item.accountId) === selfId)) {
    throw new Error(`QQ ${selfId} 已经有一个实例了。同一个账号只能开一个实例——另一个角色请用另一个 QQ 号。`);
  }
  const currentCfg = getConfig();
  if (String(currentCfg.bot.selfId) === selfId) {
    throw new Error(`QQ ${selfId} 就是当前这个实例正在用的号。同一个账号只能开一个实例。`);
  }
  const conflict = await findAccountConflict(selfId);
  if (conflict) throw new Error(`QQ ${selfId} 正在「${conflict.name}」里跑着，先把它停掉。`);

  const slug = slugify(label);
  let id = slug;
  let seq = 2;
  while ( registry.some((item) => item.id === id) || fs.existsSync(path.join(INSTANCES_DIR, id))) {
    id = `${slug}-${seq}`;
    seq += 1;
  }
  const dir = path.join(INSTANCES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  // 没启动的实例也占着配置里的端口；各实例的端口同样不能重号。
  const taken = new Set();
  const rememberPorts = (cfg, protocolDir) => {
    taken.add(Number(cfg?.bot?.panelPort) || DEFAULT_PANEL_BASE);
    for (const value of [cfg?.bot?.onebotWsUrl, cfg?.bot?.onebotHttpUrl]) {
      try { taken.add(Number(new URL(value).port || 80)); } catch { /* 没配地址 */ }
    }
    taken.add(Number(readJsonSafe(path.join(protocolDir, "config", "runtime.json"), {}).webuiPort) || DEFAULT_WEBUI_BASE);
  };
  rememberPorts(currentCfg, paths.snowluma);
  for (const item of [{ dir: HOME }, ...registry]) rememberPorts(readJsonSafe(configFileOf(item.dir), {}), protocolDirOf(item.dir));
  const panelPort = await pickPort(DEFAULT_PANEL_BASE + 1, taken);
  taken.add(panelPort);
  const wsPort = await pickPort(DEFAULT_ONEBOT_BASE + 1, taken);
  taken.add(wsPort);
  const httpPort = await pickPort(wsPort + 1, taken);
  taken.add(httpPort);
  const accessToken = `he-${randomBytes(18).toString("hex")}`;

  // 协议端全机器共用一份（SnowLuma 会接管这台机器上所有 QQ 客户端，各跑一份会互相抢钩子）。
  // 所以新实例不再单独复制/占用一个协议端，只把「这个号用哪个端口」写进共用 config。
  const sharedProtocol = sharedProtocolDir();
  const sharedReady = fs.existsSync(path.join(sharedProtocol, "config"));
  const sharedRuntime = sharedReady ? readJsonSafe(path.join(sharedProtocol, "config", "runtime.json"), {}) : {};
  let webuiPort = Number(sharedRuntime.webuiPort) || DEFAULT_WEBUI_BASE;

  // ① 实例自己的设置文件（数据独立，协议端指向共用那一份）
  writeJsonSafe(path.join(dir, "心语设置.json"), {
    dataDir: "data",
    logDir: "logs",
    snowlumaDir: sharedReady ? sharedProtocol : "protocol",
    autoStartProtocol: instanceSettings.autoStartProtocol !== false,
    openPanelOnStart: false,
    closeWindowTo:"ask",
    instancesHome: HOME,
    instancesMainDataDir: MAIN_DATA_DIR,
  });

  // ② 配置：沿用当前实例的模型/风格等，只换账号、端口、令牌
  const seed = readJsonSafe(path.join(paths.data, "config.json"), {});
  const config = JSON.parse(JSON.stringify(seed || {}));
  config.bot = {
    ...(config.bot || {}),
    selfId: Number(selfId),
    masterId: master ? Number(master) : 0,
    masterName: String(masterName ?? "").trim() || (config.bot?.masterName ?? ""),
    panelPort,
    panelHost: "127.0.0.1",
    onebotWsUrl: `ws://127.0.0.1:${wsPort}/`,
    onebotHttpUrl: `http://127.0.0.1:${httpPort}/`,
    accessToken,
  };
  config.activeCharacter = String(characterId || config.activeCharacter || "example");
  writeJsonSafe(path.join(dataDirOf(dir), "config.json"), config);

  // ③ 角色卡：把选中的那张复制过去（直接写文件，不能用 saveCharacter——那个只会写当前实例）
  let copiedCharacter = "";
  try {
    const pick = String(characterId || activeCharacterId());
    const card = loadCharacter(pick);
    if (card) {
      writeJsonSafe(path.join(dataDirOf(dir), "characters", `${pick}.json`), card);
      copiedCharacter = card.name || pick;
    }
  } catch (error) {
    log.warn(`复制角色卡失败（新实例可以之后再建角色）：${error?.message ?? error}`);
  }

  // ④ 协议端的账号配置：写进共用的 config 目录（一个 QQ 号一个文件，各用各的端口/令牌）。
  //    只有连共用协议端目录都找不到时，才退回「复制一份独立的」老做法，保证还能跑。
  let protocol = { ok: false, reason: "没有找到可用的协议端目录" };
  if (sharedReady) {
    try {
      protocol = { ...syncInstanceProtocol(dir), shared: true };
    } catch (error) {
      protocol = { ok: false, reason: String(error?.message ?? error) };
    }
  } else if (copyProtocolDir) {
    try {
      webuiPort = await pickPort(DEFAULT_WEBUI_BASE + 1, taken);
      const copied = copyProtocol(paths.snowluma, path.join(dir, "protocol"), { webuiPort });
      protocol = copied.ok ? syncInstanceProtocol(dir) : copied;
    } catch (error) {
      protocol = { ok: false, reason: String(error?.message ?? error) };
    }
  }

  const entry = {
    id,
    name: label,
    dir,
    accountId: selfId,
    createdAt: Date.now(),
    note: copiedCharacter ? `角色：${copiedCharacter}` : "",
  };
  writeRegistry([...registry, entry]);
  log.info(`已新建实例「${label}」（QQ ${selfId}，面板端口 ${panelPort}）`);

  return {
    ...entry,
    panelPort,
    wsPort,
    httpPort,
    webuiPort,
    character: copiedCharacter,
    protocolOk: protocol.ok,
    protocolShared: Boolean(protocol.shared),
    protocolReason: protocol.reason || "",
    /** 第一次启动必须由人扫码登录这个 QQ，自动化不了 */
    needLogin: true,
  };
}

/** 从登记表里删掉一个实例（只删登记，不动磁盘文件）。 */
export function forgetInstance(id) {
  const registry = readRegistry();
  const next = registry.filter((item) => item.id !== id);
  if (next.length === registry.length) return { ok: false, reason: "没有这个实例" };
  writeRegistry(next);
  return { ok: true, removed: id };
}

/** 删除实例目录（连数据一起删，调用方必须二次确认）。 */
export async function deleteInstance(id, { deleteFiles = false } = {}) {
  const registry = readRegistry();
  const item = registry.find((entry) => entry.id === id);
  if (!item) return { ok: false, reason: "没有这个实例" };
  const probe = await probeInstance(item.dir);
  if (probe.alive) return { ok: false, reason: "这个实例还在运行，先退出它再删" };
  if (deleteFiles) {
    const target = path.resolve(item.dir);
    if (path.resolve(paths.app) === target) return { ok: false, reason: "不能删当前实例" };
    if (!target.startsWith(path.resolve(INSTANCES_DIR))) return { ok: false, reason: "这个目录不在 instances 下面，不敢删" };
    fs.rmSync(target, { recursive: true, force: true });
    log.warn(`已删除实例目录：${target}`);
  }
  forgetInstance(id);
  return { ok: true, deletedFiles: deleteFiles };
}

/**
 * 启动一个实例（后台，不接管当前进程）。
 * 打包后直接再跑一次 exe；跑源码时用同一个 node 跑 index.mjs。
 *
 * 顺带做了三件「让旧实例也能直接用」的事（不需要用户重建）：
 *   ① 旧实例的 snowlumaDir 还指向自己目录 → 改成共用的那份协议端；
 *   ② 把它这个号的端口/令牌写进共用协议端的 config；
 *   ③ 共用协议端如果已经跑着、但还没认这个号（历史上它按默认端口接管过），
 *      在这里重启一次协议端让它重新读配置。不然新实例会一直「未连接」。
 */
export async function startInstance(dir) {
  const target = path.resolve(dir);
  if (!fs.existsSync(settingsFileOf(target))) return { ok: false, reason: "这个实例目录下没有 心语设置.json" };

  // 已经在跑就别再拉一份（重复点「启动」不该变成两个进程）
  const probe = await probeInstance(target);
  if (probe.alive) return { ok: true, alreadyRunning: true, pid: 0, restarted: false, reason: "" };

  const sharedProtocol = sharedProtocolDir();
  const sharedReady = fs.existsSync(path.join(sharedProtocol, "config"));
  const settings = readJsonSafe(settingsFileOf(target), {});
  writeJsonSafe(settingsFileOf(target), {
    ...settings,
    snowlumaDir: sharedReady ? sharedProtocol : (settings.snowlumaDir || "protocol"),
    instancesHome: HOME,
    instancesMainDataDir: MAIN_DATA_DIR,
  });

  let sync;
  try {
    sync = syncInstanceProtocol(target);
  } catch (error) {
    // 协议端配置损坏时不静默覆盖：报错、不启动（PR #7 的行为，保护用户原文件）
    return { ok: false, reason: String(error?.message ?? error) };
  }

  // 共用协议端可能在我们写配置之前就已经接管了这个号（还在用默认端口），
  // 只有重启一次它才会重新读配置。这会让别的实例也短暂掉线几秒，OneBot 会自动重连。
  let restarted = false;
  if (sharedReady) {
    try {
      const childCfg = readJsonSafe(configFileOf(target), {});
      const port = Number(new URL(String(childCfg?.bot?.onebotWsUrl ?? "")).port || 0);
      const protocolMod = await import("./protocol.mjs");
      if (port && !(await protocolMod.isPortListening(port)) && (await protocolMod.bridgeRunning())) {
        log.info(`协议端还没接管 QQ ${childCfg?.bot?.selfId ?? "?"}，重启一次让它读配置`);
        const result = await protocolMod.restartProtocol({ waitForPort: port });
        restarted = Boolean(result.ok);
      }
    } catch (error) {
      log.warn(`启动前检查和重启协议端失败（不影响实例启动）：${error?.message ?? error}`);
    }
  }

  const args = ["--instance", target, "--no-panel"];
  // 打包后 process.execPath 就是心语.exe；跑源码时它是 node，要多给一个入口文件
  const argv = isSea ? args : [SOURCE_ENTRY, ...args];
  try {
    const env = { ...process.env };
    for (const key of ["HEARTECHO_DATA_DIR", "HEARTECHO_LOG_DIR", "HEARTECHO_SNOWLUMA_DIR"]) delete env[key];
    const child = spawn(process.execPath, argv, {
      cwd: target,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, HEARTECHO_SETTINGS: settingsFileOf(target), HEARTECHO_APP_DIR: target, HEARTECHO_INSTANCES_HOME: HOME, HEARTECHO_INSTANCES_MAIN_DATA_DIR: MAIN_DATA_DIR },
    });
    child.unref();
    log.info(`已拉起实例：${target}（pid=${child.pid}）`);
    return { ok: true, pid: child.pid, restarted, protocolChanged: Boolean(sync?.changed) };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 给「打开面板」用的地址（带授权令牌，不然会被 401 挡住）。 */
export async function instancePanelUrl(dir) {
  const dataDir = dataDirOf(dir);
  const token = readTextSafe(path.join(dataDir, "panel-token"));
  const config = readJsonSafe(configFileOf(dir), {});
  const port = Number(config?.bot?.panelPort) || DEFAULT_PANEL_BASE;
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (token) url.hash = `panelToken=${token}`;
  return url.href;
}

