/**
 * 协议端管理（SnowLuma / NapCat 这类「把 QQ 变成 OneBot 接口」的独立组件）。
 *
 * 为什么需要这个模块：
 *   协议端是独立程序，用户很容易只启动了心语却忘了它，于是面板一直显示「未连接」，
 *   而人看到的只有一句红字，不知道下一步该做什么。这里负责：
 *     ① 判断协议端在不在（端口能不能连、进程在不在、配置全不全）
 *     ② 一键把它拉起来（在后台起，不弹窗口）
 *     ③ 把「到底卡在哪一步、该点哪个按钮」翻译成人话
 *
 * 多实例与 QQ 钩子（重要）：
 *   SnowLuma 不是普通的 OneBot 服务端——它靠往 QQ 客户端进程里注入 hook 才能收发消息，
 *   而一个 QQ 进程同一时间只认一份 hook。所以这台机器上**只能跑一份协议端**：
 *   多实例共用主实例目录下那一份（见 instances.sharedProtocolDir），
 *   每个实例只把自己的 QQ 号写进共用 config（onebot_<QQ>.json，各自的端口/令牌）。
 *   本模块负责：这份共用协议端在不在、有没有接管当前这个号、要不要（重新）拉起它，
 *   以及退出时只在「没有别的实例还在用」时才关掉，免得把还在线的实例一起断掉。
 *
 * 约定：本模块只负责「启动/诊断/重启」，绝不修改协议端自身的配置内容。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { paths, readJson } from "./paths.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { listInstances, protocolDirOf, sharedProtocolDir } from "./instances.mjs";

const log = createLogger("Protocol");

/** 协议端入口的候选文件名（不同发行版叫法不一样）。 */
const ENTRY_CANDIDATES = ["index.mjs", "main.mjs", "app.mjs", "index.js", "main.js", "launcher.bat", "start.bat"];

/** SnowLuma WebUI 的默认端口（config/runtime.json 里没写时用它）。 */
const DEFAULT_WEBUI_PORT = 5099;

/** 「正在拉起协议端」的跨进程互斥文件：多实例同时启动时只让一个去 spawn。 */
const SPAWN_LOCK_NAME = ".heartecho-spawn.lock";

let spawned = null;
let spawnedChild = null;

function ownedSpawnAlive() {
  return Boolean(spawned && spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null && isAlive(spawned.pid));
}

/* ------------------------------ 基础探测 ------------------------------ */

/** 探测某个 TCP 端口是否有程序在监听。 */
export function isPortListening(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(Number(port), host);
    } catch {
      done(false);
    }
  });
}

/** 把 onebotWsUrl 解析成 {port, path}，解析不出来返回 null。 */
export function parseWsUrl(url) {
  try {
    const parsed = new URL(String(url ?? ""));
    return { host: parsed.hostname || "127.0.0.1", port: Number(parsed.port || 80), path: parsed.pathname || "/" };
  } catch {
    return null;
  }
}

/** 协议端目录里有没有可执行的入口。 */
function findEntry(dir) {
  if (!dir) return "";
  for (const name of ENTRY_CANDIDATES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return "";
}

/** 这个目录像不像一个协议端（有入口 + 有 config 或 native）。 */
function looksLikeProtocolDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const hasEntry = Boolean(findEntry(dir));
  const hasConfig = fs.existsSync(path.join(dir, "config"));
  return hasEntry && (hasConfig || fs.existsSync(path.join(dir, "native")));
}

// SnowLuma 1.14.22 首次启动和无效配置恢复会将初始 WebUI 密码写到 stdout。
// 心语将 stdout 保存到日志，因此要求先由用户在官方控制台完成首次设置。
function snowlumaSetupProblem(dir) {
  const pkg = readJson(path.join(dir, "package.json"), null);
  if (pkg?.name !== "@snowluma/runtime" || pkg?.version !== "1.14.22") return "";
  const auth = readJson(path.join(dir, "config", "webui.json"), null);
  const valid = auth && typeof auth === "object" && !Array.isArray(auth)
    && Object.keys(auth).every((key) => ["passwordHash", "passwordSalt", "mustChangePassword", "generatedAt", "updatedAt", "totp"].includes(key))
    && typeof auth.passwordHash === "string" && /^[0-9a-f]{128}$/i.test(auth.passwordHash)
    && typeof auth.passwordSalt === "string" && /^[0-9a-f]{32}$/i.test(auth.passwordSalt)
    && auth.mustChangePassword === false
    && typeof auth.generatedAt === "string" && Number.isFinite(Date.parse(auth.generatedAt))
    && typeof auth.updatedAt === "string" && Number.isFinite(Date.parse(auth.updatedAt));
  return valid ? "" : "请先手动启动 SnowLuma，在其控制台查看初始凭据并完成 WebUI 密码修改和协议确认；完成后再让心语启动。这样可避免初始密码写入心语日志。";
}

/** 找 node 可执行文件（打包成 exe 时 process.execPath 是我们自己，不能用）。 */
function findNode() {
  const candidates = [
    paths.installed ? path.join(paths.installRoot, "runtime", "node.exe") : "",
    path.join(paths.app, "runtime", "node.exe"),
    path.join(paths.app, "node.exe"),
    path.join(paths.snowluma, "node.exe"),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "node.exe") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
  ].filter(Boolean);
  for (const item of candidates) if (fs.existsSync(item)) return item;
  try {
    const out = execFileSync("where", ["node.exe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    /* 没有 */
  }
  return "";
}

/** 读协议端自己记的 WebUI 端口（多实例共用同一份，所以这个端口也只有一个）。 */
export function webuiPortOf(dir = paths.snowluma) {
  try {
    const runtime = readJson(path.join(dir, "config", "runtime.json"), {});
    return Number(runtime?.webuiPort) || DEFAULT_WEBUI_PORT;
  } catch {
    return DEFAULT_WEBUI_PORT;
  }
}

/** 这个实例用的协议端目录，是不是「多实例共用的那一份」。 */
export function isSharedProtocol() {
  try {
    return path.resolve(paths.snowluma) === path.resolve(sharedProtocolDir());
  } catch {
    return false;
  }
}

/**
 * 确认某个端口上跑的是 SnowLuma，而不是别的程序碰巧占了同一个端口。
 * 页面上有「SnowLuma」字样就算；端口明明在 listen 却读不到（比如还在启动）时保守当作是它，
 * 宁可少拉起一次，也不要在同一台机器上跑出两份互相抢钩子的协议端。
 */
async function isSnowLumaWebui(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}/`, { signal: AbortSignal.timeout(1500) });
    const text = await res.text();
    return String(text).includes("SnowLuma");
  } catch {
    return true;
  }
}

/**
 * 协议端在不在跑。
 *
 * 不能只看「当前这个号的 WebSocket 端口可不可连」：共用协议端可能已经跑着，
 * 只是还没接管当前这个 QQ 号。只要它整体在跑，就绝不能再 spawn 第二份。
 */
export async function bridgeRunning() {
  if (ownedSpawnAlive()) return true;
  const port = webuiPortOf();
  if (!port || !(await isPortListening(port))) return false;
  return isSnowLumaWebui(port);
}

/** 只看协议端自己的 WebUI 是否已经起来（不把「本进程刚 spawn 的」算进来）。 */
async function bridgeWebuiServing() {
  const port = webuiPortOf();
  if (!port || !(await isPortListening(port))) return false;
  return isSnowLumaWebui(port);
}

/* ------------------------- 跨进程启动互斥（避免双开） ------------------------- */

function spawnLockPath() {
  return path.join(paths.snowluma, SPAWN_LOCK_NAME);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 抢一份「我要启动协议端」的跨进程锁。
 *
 * 两个实例同时启动时，如果都去 spawn，就会又变回「两份协议端抢 QQ 钩子」的老问题。
 * 谁抢到谁负责拉起，另一个只等结果。
 */
export function acquireProtocolSpawnLock({ staleMs = 60000 } = {}) {
  const file = spawnLockPath();
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  const writeLock = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, { encoding: "utf8", flag: "wx" });
  };
  try {
    writeLock();
    return { ok: true, file };
  } catch (error) {
    if (error?.code !== "EEXIST") return { ok: false, reason: String(error?.message ?? error), file };
    const existing = readJson(file, null) || {};
    const age = Date.now() - (Number(existing.at) || 0);
    if (Number(existing.pid) === process.pid) return { ok: false, holder: existing, file, mine: true };
    const holderAlive = isAlive(Number(existing.pid) || 0);
    if (holderAlive && age < staleMs) return { ok: false, holder: existing, file };
    // 进程已经不在了（或锁太旧）：接管它
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 继续尝试抢 */
    }
    try {
      writeLock();
      return { ok: true, file, tookOver: true };
    } catch (retryError) {
      return { ok: false, reason: String(retryError?.message ?? retryError), file };
    }
  }
}

export function releaseProtocolSpawnLock(file = "") {
  const target = file || spawnLockPath();
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* 删不掉就算了，过期后会被接管 */
  }
}

/* --------------------------------- 诊断 --------------------------------- */

/**
 * 完整的协议端诊断。
 * 返回的结构会直接给面板用，所以每条都带「人能看懂的原因 + 建议动作」。
 */
export async function diagnoseProtocol({ probePort = true } = {}) {
  const cfg = getConfig();
  const dir = paths.snowluma;
  const ws = parseWsUrl(cfg.bot.onebotWsUrl);
  const port = ws?.port ?? 0;

  const report = {
    at: Date.now(),
    dir,
    dirExists: fs.existsSync(dir),
    looksLikeProtocol: looksLikeProtocolDir(dir),
    entry: findEntry(dir),
    node: findNode(),
    wsUrl: cfg.bot.onebotWsUrl,
    port,
    portListening: false,
    webuiPort: webuiPortOf(dir),
    /** 共用协议端整体在不在跑（哪怕还没接管当前这个号） */
    bridgeRunning: false,
    /** 这一次用的协议端是不是多实例共用的那一份 */
    shared: isSharedProtocol(),
    configFile: "",
    configFound: false,
    configHasAccount: false,
    /** 配置里的 WebSocket 端口和心语要连的端口是否一致 */
    configMatchesOwnPort: false,
    account: String(cfg.bot.selfId ?? ""),
    running: false,
    blockers: [],
    nextAction: "",
  };

  // ① 当前这个号的接口通不通（最直接的判据）
  if (probePort && port) report.portListening = await isPortListening(port);
  report.running = report.portListening;

  // ② 共用协议端整体在不在跑
  if (probePort && report.dirExists) report.bridgeRunning = await bridgeRunning();

  // ③ 协议端自己的账号配置文件
  const configFile = path.join(dir, "config", `onebot_${report.account}.json`);
  report.configFile = configFile;
  if (fs.existsSync(configFile)) {
    report.configFound = true;
    try {
      const json = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
      const wsServers = json?.networks?.wsServers ?? [];
      report.configHasAccount = true;
      report.wsServers = wsServers.map((item) => ({ name: item.name, host: item.host, port: item.port }));
      const matched = wsServers.some((item) => Number(item.port) === Number(port));
      report.configMatchesOwnPort = matched;
      if (!matched) {
        report.blockers.push({
          id: "port-mismatch",
          title: "协议端端口和心语对不上",
          detail: `协议端里没有监听 ${port} 的 WebSocket 服务（现有：${wsServers.map((s) => s.port).join("、") || "无"}）。`,
          fix: "点「把端口写进协议端配置」，然后点「重启协议端」。",
        });
      }
    } catch (error) {
      report.blockers.push({
        id: "config-broken",
        title: "协议端配置文件读不出来",
        detail: String(error?.message ?? error),
        fix: "检查 config 目录下的 onebot_<QQ号>.json 是否是合法 JSON。",
      });
    }
  }

  // ④ 共用协议端跑着、却没接管这个号：这是多实例最常见的「看着像没启动」
  if (report.bridgeRunning && !report.running && report.blockers.length === 0) {
    if (!report.configFound) {
      report.blockers.push({
        id: "account-not-adopted",
        title: `协议端还没接管 QQ ${report.account || "（未设置）"}`,
        detail: `协议端在跑，但 config 目录里没有 onebot_${report.account}.json。通常是这个 QQ 号还没登录过。`,
        fix: `先在 QQ 客户端登录 ${report.account || "这个号"}，再点「重启协议端」。`,
      });
    } else if (report.configMatchesOwnPort) {
      report.blockers.push({
        id: "port-not-served",
        title: "协议端在跑，但还没监听这个号的端口",
        detail: `配置里写着 ${port} 端口，但协议端现在没有监听它。多数是协议端启动时这个号还没登录，或者配置刚改过。`,
        fix: "点「重启协议端」，让它重新读一次配置；如果 QQ 还没登录，先在 QQ 客户端登录这个号。",
      });
    }
  }

  // ⑤ 把结论翻译成「下一步该干什么」
  if (report.running) {
    if (report.blockers.length === 0) {
      report.nextAction = "账号端口可以连接；请在面板确认 QQ 是否已连接。若未连接，请检查协议端后点「重新连接 QQ」";
    } else {
      report.nextAction = report.blockers[0].fix;
    }
  } else if (!report.dirExists) {
    report.blockers.push({
      id: "no-dir",
      title: "找不到协议端目录",
      detail: `配置的协议端目录是：${dir || "（空）"}`,
      fix: "在「运行环境」页把「协议端目录」改成 SnowLuma / NapCat 实际所在的目录。",
    });
    report.nextAction = "去「运行环境」页设置协议端目录";
  } else if (!report.looksLikeProtocol) {
    report.blockers.push({
      id: "no-entry",
      title: "这个目录不像协议端",
      detail: `${dir} 里没找到入口文件（index.mjs / main.mjs / launcher.bat…）。`,
      fix: "确认协议端目录选对了；或者手动启动协议端后回到面板点「重新连接 QQ」。",
    });
    report.nextAction = "检查协议端目录，或手动启动协议端";
  } else if (!report.node) {
    report.blockers.push({
      id: "no-node",
      title: "找不到 node，无法自动拉起协议端",
      detail: "协议端需要 Node.js 才能跑，但这台机器上没找到 node.exe。",
      fix: "装一个 Node.js（22 以上），或者手动启动协议端。",
    });
    report.nextAction = "安装 Node.js，或手动启动协议端";
  } else if (report.bridgeRunning) {
    report.nextAction = "协议端已经跑着（多实例共用一份），只是没接管这个号：确认 QQ 已登录，然后点「重启协议端」";
  } else {
    report.blockers.push({
      id: "not-running",
      title: "协议端没在运行",
      detail: `没有任何程序在监听 ${port} 端口，协议端整体也没在跑。`,
      fix: "点下面的「启动协议端」按钮，心语会帮你在后台把它拉起来。",
    });
    report.nextAction = "点「启动协议端」";
  }

  return report;
}

/* ------------------------------ 启动 / 停止 ------------------------------ */

async function waitWhile(check, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

/**
 * 在后台启动协议端。
 * 不用 shell、用独立 detached 进程，所以关掉面板窗口它也继续跑。
 *
 * 共用协议端已经在跑时不重复拉起，只告诉调用方「它跑着，只是没接管这个号」。
 * allowRunning=false 用于「先杀掉旧的、再原地重启」：刚杀完端口可能还没释放，
 * 不能因为探测到「端口可连」就以为不用重启了。
 */
export async function startProtocol({ waitMs = 25000, allowRunning = true, holdLock = true } = {}) {
  const cfg = getConfig();
  const ws = parseWsUrl(cfg.bot.onebotWsUrl);
  const port = ws?.port ?? 0;

  if (allowRunning && port && (await isPortListening(port))) {
    return { ok: true, alreadyRunning: true, message: `协议端已经在跑了（端口 ${port} 可连）` };
  }

  const dir = paths.snowluma;
  const entry = findEntry(dir);
  if (!entry) {
    return { ok: false, message: `协议端目录里没有入口文件：${dir}` };
  }
  const setupProblem = snowlumaSetupProblem(dir);
  if (setupProblem) return { ok: false, message: setupProblem };

  if (allowRunning && (await bridgeRunning())) {
    return {
      ok: false,
      bridgeRunning: true,
      message: "协议端已经在运行（多实例共用同一份），但还没有接管当前这个 QQ 号。确认 QQ 已登录；如果刚改过端口，点「重启协议端」。",
    };
  }

  const node = findNode();
  if (!node) {
    return { ok: false, message: "找不到 node.exe，无法自动拉起协议端（需要装 Node.js 22+）" };
  }

  // 另一个实例可能正在拉起：等它，而不是再 spawn 一份
  const lock = holdLock ? acquireProtocolSpawnLock() : null;
  if (holdLock && !lock.ok) {
    log.info(`另一个实例正在启动协议端（pid=${lock.holder?.pid ?? "?"}），等它起来`);
    const ready = await waitWhile(() => bridgeRunning(), 20000, 500);
    return ready
      ? { ok: false, bridgeRunning: true, message: "另一个实例已经把协议端启动起来了，但它还没接管当前这个 QQ 号。确认 QQ 已登录，或点「重启协议端」。" }
      : { ok: false, message: `另一个实例正在启动协议端（pid ${lock.holder?.pid ?? "?"}），稍等几秒再点一次` };
  }

  try {
    // 抢到锁之后再确认一次：等的这会儿别人可能已经拉起来了
    if (await bridgeRunning()) {
      return { ok: false, bridgeRunning: true, message: "协议端已经在运行（多实例共用同一份），但还没有接管当前这个 QQ 号。" };
    }

    const logFile = path.join(paths.logs, "protocol.out.log");
    let child;
    try {
      const fd = fs.openSync(logFile, "a");
      const isBat = /\.(bat|cmd)$/i.test(entry);
      const command = isBat ? "cmd" : node;
      const args = isBat ? ["/c", entry] : [entry];
      child = spawn(command, args, {
        cwd: dir,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(fd);
    } catch (error) {
      return { ok: false, message: `启动失败：${error?.message ?? error}` };
    }

    spawned = { pid: child.pid, at: Date.now(), entry, logFile };
    spawnedChild = child;
    child.once("error", (error) => log.warn(`协议端启动失败：${error?.message ?? error}`));
    child.once("exit", () => { if (spawnedChild === child) { spawned = null; spawnedChild = null; } });
    log.info(`已尝试在后台启动协议端（pid=${child.pid}，入口 ${path.basename(entry)}）`);

    // 等它把当前这个号的端口监听起来；如果协议端整体先起来了但这个号没被接管，也提前给个准话
    const deadline = Date.now() + waitMs;
    let webuiUpAt = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (port && (await isPortListening(port))) {
        log.info(`协议端已就绪：端口 ${port} 可以连了`);
        return { ok: true, started: true, pid: child.pid, message: `协议端已启动，端口 ${port} 可以连了`, logFile };
      }
      if (!isAlive(child.pid)) {
        const tail = readLogTail(logFile, 12);
        return {
          ok: false,
          message: `协议端启动后立刻退出了（多半是 QQ 没登录，或者端口被占）。日志：\n${tail}`,
          logFile,
        };
      }
      if (!webuiUpAt && (await bridgeWebuiServing())) webuiUpAt = Date.now();
      if (webuiUpAt && Date.now() - webuiUpAt > 8000) {
        return {
          ok: false,
          bridgeRunning: true,
          pid: child.pid,
          message: `协议端进程起来了（pid=${child.pid}），但还没有监听 ${port} 端口——多半是这个 QQ 号还没登录。登录后点「重启协议端」。`,
          logFile,
        };
      }
    }

    return {
      ok: false,
      message: `协议端进程起来了（pid=${child.pid}），但 ${waitMs / 1000} 秒内端口 ${port} 还没监听。可能还在等 QQ 登录。`,
      logFile,
      pid: child.pid,
    };
  } finally {
    if (lock?.file) releaseProtocolSpawnLock(lock.file);
  }
}

/** 读协议端日志尾部，用于告诉用户为什么没起来。 */
export function readLogTail(file, lines = 20) {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function protocolRuntimeInfo() {
  return { spawned: ownedSpawnAlive() ? spawned : null };
}

/** 找出监听某个端口的进程号（没有就返回 0）。 */
export function findListenPid(port) {
  if (!port) return 0;
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || "";
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (pid > 0) return pid;
    }
  } catch {
    /* netstat 不可用就当找不到 */
  }
  return 0;
}

/**
 * 重启协议端。
 *
 * 什么时候需要它：共用协议端启动得比某个号早，那个号当时的配置还没写好，
 * 协议端就会一直按旧端口（甚至是默认 3000/3001）服务；只有让它重新读一次配置才会切过来。
 * 重启期间所有实例会短暂掉线，但 OneBot 客户端会自动重连，不需要人工操作。
 */
export async function restartProtocol({ waitForPort = 0, waitMs = 20000 } = {}) {
  const webuiPort = webuiPortOf();
  const ownPort = parseWsUrl(getConfig().bot.onebotWsUrl)?.port ?? 0;
  let pid = ownedSpawnAlive() ? spawned.pid : 0;
  if (!pid) {
    return { ok: false, stoppedPid: 0, message: "无法确认协议端进程由当前心语启动，请手动重启协议端后再点「重新连接 QQ」。" };
  }

  // 两个实例可能同时想重启：谁抢到锁谁重启，另一个等结果，避免互相把对方刚起来的进程杀掉
  const lock = acquireProtocolSpawnLock();
  if (!lock.ok) {
    const ready = await waitWhile(() => bridgeRunning(), 20000, 500);
    return {
      ok: Boolean(ready),
      stoppedPid: 0,
      portReady: false,
      message: ready ? "另一个实例已经在重启协议端了，它起来后这个号会自动接管" : `另一个实例正在启动协议端（pid ${lock.holder?.pid ?? "?"}），稍等几秒再试`,
    };
  }

  try {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      log.warn(`停止协议端失败（pid=${pid}）：${error?.message ?? error}`);
    }
    let gone = await waitWhile(() => !isAlive(pid), 8000, 200);
    if (!gone) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      gone = await waitWhile(() => !isAlive(pid), 2000, 200);
    }
    if (!gone) return { ok: false, stoppedPid: 0, message: "无法确认旧协议端已退出，请手动检查后再重启。" };
    // 进程刚退出时端口可能还要一会儿才从 LISTENING 消失：等干净了再起，
    // 否则 startProtocol 会误以为「已经在跑」而直接返回，结果两边都没协议端。
    const portsFree = await waitWhile(async () => {
      if (webuiPort && (await isPortListening(webuiPort))) return false;
      if (ownPort && (await isPortListening(ownPort))) return false;
      return true;
    }, 8000, 200);
    spawned = null;
    if (!portsFree) return { ok: false, stoppedPid: pid, message: "旧进程已停止，但端口仍被占用；请检查占用程序后再启动协议端。" };
    log.warn(`准备重启协议端（旧进程 pid=${pid}）`);

    const started = await startProtocol({ waitMs, allowRunning: false, holdLock: false });
    const portReady = waitForPort ? await waitWhile(() => isPortListening(waitForPort), 10000, 400) : true;
    const after = await bridgeRunning();
    return {
      ok: Boolean(started.ok || (after && portReady)),
      stoppedPid: pid,
      started: Boolean(started.started),
      portReady,
      message: started.message + (waitForPort && !portReady ? `（${waitForPort} 端口还没监听，多半是这个 QQ 号还没登录）` : ""),
      logFile: started.logFile,
    };
  } finally {
    if (lock?.file) releaseProtocolSpawnLock(lock.file);
  }
}

/**
 * 这个协议端还有没有别的实例在用（还活着的）。
 *
 * 退出时用：主实例先退、子实例还在跑，不能把人家正用着的协议端一起关掉。
 */
async function otherSharedUsersAlive() {
  try {
    const want = path.resolve(paths.snowluma);
    const list = await listInstances();
    return list
      .filter((item) => path.resolve(item.dir) !== path.resolve(paths.app))
      .filter((item) => item.alive)
      .filter((item) => {
        try {
          return path.resolve(protocolDirOf(item.dir)) === want;
        } catch {
          return false;
        }
      });
  } catch (error) {
    log.debug(`检查其它实例是否在用协议端失败：${error?.message ?? error}`);
    return [];
  }
}

/**
 * 停掉协议端。
 *
 * 为什么需要它：退出心语之后如果协议端还在后台跑，用户会看到 QQ 还连着、
 * 任务管理器里还挂着一个 node.exe，然后不知道该怎么收场。
 *
 * 只关闭当前心语进程亲手拉起来的协议端；不能仅凭端口确认进程身份。
 * 而且只要还有别的实例活着、用的又是同一份协议端，就先留着——不然会把别人断线。
 */
export async function stopProtocol({ waitMs = 6000 } = {}) {
  let pid = 0;
  let reason = "";
  if (ownedSpawnAlive()) {
    pid = spawned.pid;
    reason = "心语这次启动的";
  }

  if (!pid) {
    return {
      ok: true,
      stopped: false,
      message: "当前心语没有可确认的自启协议端进程，保持现有进程原状",
    };
  }

  const others = await otherSharedUsersAlive();
  if (others.length) {
    const names = others.map((item) => item.name).join("、");
    log.info(`还有实例在用协议端（${names}），先留着不关`);
    return { ok: true, stopped: false, kept: true, sharedUsers: others.map((item) => item.name), message: `还有「${names}」在用这份协议端，先留着让它继续服务` };
  }

  const waitGone = async () => waitWhile(() => !isAlive(pid), waitMs, 200);

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, stopped: false, message: `停止协议端失败：${error?.message ?? error}` };
  }
  if (await waitGone()) {
    log.info(`已停止协议端（${reason}，pid=${pid}）`);
    spawned = null;
    return { ok: true, stopped: true, pid, reason };
  }
  try {
    process.kill(pid, "SIGKILL");
    log.warn(`协议端没有正常退出，已强制结束（pid=${pid}）`);
  } catch {
    /* ignore */
  }
  spawned = null;
  return { ok: true, stopped: true, pid, reason, forced: true };
}

/**
 * 一个「尽量修好」的组合动作：诊断 → 需要就启动/重启 → 报告结果。
 *
 * autoRestart 只在**人点了按钮**时打开：共用协议端跑着却没接管这个号时，
 * 重启一次让它重新读配置。启动时（index.mjs）不自动重启——
 * 那可能只是这个 QQ 号还没登录，重启协议端会把别的实例白白断线几秒。
 */
export async function ensureProtocol({ autoStart = true, autoRestart = false } = {}) {
  const before = await diagnoseProtocol();
  if (before.running) {
    return { ok: true, action: "none", before, message: "协议端本来就在运行" };
  }
  if (!autoStart) {
    return { ok: false, action: "none", before, message: before.nextAction };
  }

  // 共用协议端已经在跑、配置也对，但这个号的口没监听：重启一次让它重新读配置
  if (before.bridgeRunning) {
    if (autoRestart && before.configFound && before.configMatchesOwnPort) {
      const restarted = await restartProtocol({ waitForPort: before.port });
      const after = await diagnoseProtocol();
      return {
        ok: Boolean(restarted.ok && after.running),
        action: "restart",
        before,
        after,
        message: restarted.message,
        logFile: restarted.logFile ?? path.join(paths.logs, "protocol.out.log"),
      };
    }
    return { ok: false, action: "none", before, after: before, message: before.nextAction };
  }

  const started = await startProtocol();
  const after = await diagnoseProtocol();
  return {
    ok: started.ok && after.running,
    action: started.alreadyRunning ? "none" : "start",
    before,
    after,
    message: started.message,
    logFile: started.logFile ?? path.join(paths.logs, "protocol.out.log"),
  };
}
