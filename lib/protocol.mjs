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
 * 约定：本模块只负责「启动/诊断」，绝不修改协议端自身的配置内容。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { paths } from "./paths.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("Protocol");

/** 协议端入口的候选文件名（不同发行版叫法不一样）。 */
const ENTRY_CANDIDATES = ["index.mjs", "main.mjs", "app.mjs", "index.js", "main.js", "launcher.bat", "start.bat"];

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

/** 找 node 可执行文件（打包成 exe 时 process.execPath 是我们自己，不能用）。 */
function findNode() {
  const candidates = [
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
    configFile: "",
    configFound: false,
    configHasAccount: false,
    account: String(cfg.bot.selfId ?? ""),
    running: false,
    blockers: [],
    nextAction: "",
  };

  // ① 端口通不通（最直接的判据）
  if (probePort && port) report.portListening = await isPortListening(port);
  report.running = report.portListening;

  // ② 协议端自己的配置文件
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
      if (!matched) {
        report.blockers.push({
          id: "port-mismatch",
          title: "协议端端口和心语对不上",
          detail: `协议端里没有监听 ${port} 的 WebSocket 服务（现有：${wsServers.map((s) => s.port).join("、") || "无"}）。`,
          fix: "在「运行环境」页点「把端口写进协议端配置」，然后重启协议端。",
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

  // ③ 把结论翻译成「下一步该干什么」
  if (report.running) {
    if (report.blockers.length === 0) {
      report.nextAction = "协议端在正常运行。如果面板还是显示未连接，点「重新连接 QQ」";
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
  } else {
    report.blockers.push({
      id: "not-running",
      title: "协议端没在运行",
      detail: `没有任何程序在监听 ${port} 端口。`,
      fix: "点下面的「启动协议端」按钮，心语会帮你在后台把它拉起来。",
    });
    report.nextAction = "点「启动协议端」";
  }

  return report;
}

/* ------------------------------ 启动 / 停止 ------------------------------ */

let spawned = null;

/** 判断进程还活着。 */
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
 * 在后台启动协议端。
 * 不用 shell、用独立 detached 进程，所以关掉面板窗口它也继续跑。
 */
export async function startProtocol({ waitMs = 25000 } = {}) {
  const cfg = getConfig();
  const ws = parseWsUrl(cfg.bot.onebotWsUrl);
  const port = ws?.port ?? 0;

  if (port && (await isPortListening(port))) {
    return { ok: true, alreadyRunning: true, message: `协议端已经在跑了（端口 ${port} 可连）` };
  }

  const dir = paths.snowluma;
  const entry = findEntry(dir);
  if (!entry) {
    return { ok: false, message: `协议端目录里没有入口文件：${dir}` };
  }

  const node = findNode();
  if (!node) {
    return { ok: false, message: "找不到 node.exe，无法自动拉起协议端（需要装 Node.js 22+）" };
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
  log.info(`已尝试在后台启动协议端（pid=${child.pid}，入口 ${path.basename(entry)}）`);

  // 等它把端口监听起来
  const deadline = Date.now() + waitMs;
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
  }

  return {
    ok: false,
    message: `协议端进程起来了（pid=${child.pid}），但 ${waitMs / 1000} 秒内端口 ${port} 还没监听。可能还在等 QQ 登录。`,
    logFile,
    pid: child.pid,
  };
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
  return { spawned: spawned && isAlive(spawned.pid) ? spawned : null };
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

/** 这个协议端目录是不是「心语自带的那份」（在程序目录下面）。 */
function isBundledProtocol() {
  try {
    const dir = path.resolve(paths.snowluma).toLowerCase();
    const app = path.resolve(paths.app).toLowerCase();
    return Boolean(dir && app && dir.startsWith(app));
  } catch {
    return false;
  }
}

/**
 * 停掉协议端。
 *
 * 为什么需要它：退出心语之后如果协议端还在后台跑，用户会看到 QQ 还连着、
 * 任务管理器里还挂着一个 node.exe，然后不知道该怎么收场。
 *
 * 只关两种：① 我们这次亲手拉起来的；② 心语自带的那份（在程序目录下）。
 * 用户自己装的 NapCat 之类一律不碰，免得把人家的东西关掉。
 */
export async function stopProtocol({ waitMs = 6000 } = {}) {
  const cfg = getConfig();
  const port = parseWsUrl(cfg.bot.onebotWsUrl)?.port ?? 0;

  let pid = 0;
  let reason = "";
  if (spawned && isAlive(spawned.pid)) {
    pid = spawned.pid;
    reason = "心语这次启动的";
  } else if (isBundledProtocol()) {
    const found = findListenPid(port);
    if (found && found !== process.pid) {
      pid = found;
      reason = `自带协议端（端口 ${port}）`;
    }
  }

  if (!pid) {
    return { ok: true, stopped: false, message: isBundledProtocol() ? "协议端本来就没在运行" : "协议端不是心语自带的，保持原状" };
  }

  const waitGone = async () => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return !isAlive(pid);
  };

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

/** 一个「尽量修好」的组合动作：诊断 → 需要就启动 → 报告结果。 */
export async function ensureProtocol({ autoStart = true } = {}) {
  const before = await diagnoseProtocol();
  if (before.running) {
    return { ok: true, action: "none", before, message: "协议端本来就在运行" };
  }
  if (!autoStart) {
    return { ok: false, action: "none", before, message: before.nextAction };
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
