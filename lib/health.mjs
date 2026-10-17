/**
 * OneBot 连接健康检查与凭据查看（规划书 17.3、16.3）。
 * 只读诊断：不做任何修改，方便用户自己判断「哪一步没通」。
 */
import fs from "node:fs";
import path from "node:path";
import { paths, readJson } from "./paths.mjs";
import { getConfig } from "./config.mjs";
import { formatTime } from "./util.mjs";

export function protocolStatus() {
  const cfg = getConfig();
  const dir = paths.snowluma;
  const configDir = path.join(dir, "config");
  const info = {
    dir,
    dirExists: fs.existsSync(dir),
    configDirExists: fs.existsSync(configDir),
    selfId: String(cfg.bot.selfId ?? ""),
    masterId: String(cfg.bot.masterId ?? ""),
    wsUrl: cfg.bot.onebotWsUrl,
    httpUrl: cfg.bot.onebotHttpUrl,
    hasToken: Boolean(cfg.bot.accessToken),
    configFile: "",
    configFound: false,
    adapters: [],
    warnings: [],
  };
  if (!info.dirExists) {
    info.warnings.push(`协议端目录不存在：${dir}。请把 SnowLuma / NapCat 装好后在「运行环境」里改这个路径。`);
    return info;
  }
  const candidate = path.join(configDir, `onebot_${info.selfId}.json`);
  info.configFile = candidate;
  const json = readJson(candidate, null);
  if (!json) {
    info.warnings.push(`没有找到协议端配置文件 ${candidate}。通常是「这个 QQ 号还没被协议端接管」——先启动协议端并确认 QQ 已登录。`);
    // 顺手列出目录里有什么，方便用户判断
    try {
      info.availableConfigs = fs
        .readdirSync(configDir)
        .filter((name) => name.startsWith("onebot_"))
        .map((name) => name);
    } catch {
      info.availableConfigs = [];
    }
    return info;
  }
  info.configFound = true;
  for (const server of json.networks?.wsServers ?? []) {
    info.adapters.push({ type: "ws", name: server.name, host: server.host, port: server.port, path: server.path, token: Boolean(server.accessToken) });
  }
  for (const server of json.networks?.httpServers ?? []) {
    info.adapters.push({ type: "http", name: server.name, host: server.host, port: server.port, path: server.path, token: Boolean(server.accessToken) });
  }
  const wsPort = Number(new URL(cfg.bot.onebotWsUrl).port || 0);
  const wsServer = info.adapters.find((item) => item.type === "ws" && Number(item.port) === wsPort);
  if (!wsServer) {
    info.warnings.push(`协议端里没有监听 ${wsPort} 端口的 WebSocket 服务，机器人连不上。面板「运行环境」可以一键把端口写进协议端配置。`);
  }
  return info;
}

/** 把机器人的端口与令牌写进协议端配置，省得用户两边手改。 */
export function syncProtocolConfig() {
  const cfg = getConfig();
  const file = path.join(paths.snowluma, "config", `onebot_${cfg.bot.selfId}.json`);
  const json = readJson(file, null);
  if (!json) return { ok: false, reason: `没找到 ${file}` };
  const wsUrl = new URL(cfg.bot.onebotWsUrl);
  const httpUrl = new URL(cfg.bot.onebotHttpUrl);
  let changed = false;
  for (const server of json.networks?.wsServers ?? []) {
    const want = Number(wsUrl.port || 80);
    if (server.port !== want || server.accessToken !== cfg.bot.accessToken) {
      server.port = want;
      server.accessToken = cfg.bot.accessToken;
      changed = true;
    }
  }
  for (const server of json.networks?.httpServers ?? []) {
    const want = Number(httpUrl.port || 80);
    if (server.port !== want || server.accessToken !== cfg.bot.accessToken) {
      server.port = want;
      server.accessToken = cfg.bot.accessToken;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    } catch (error) {
      return { ok: false, reason: `写入失败：${error?.message ?? error}` };
    }
  }
  return { ok: true, changed, file };
}

/* --------------------------- 机器人 QQ 号（账号切换） --------------------------- */

/**
 * 协议端里已经被接管的 QQ 号：每个号对应 config\onebot_<QQ>.json。
 *
 * 「换机器人 QQ 号」这件事必须两边一起改：
 *   心语这边改 bot.selfId（决定连哪个号、记忆按哪个号隔离）；
 *   协议端那边要有这个号的 onebot_<QQ>.json（决定它用什么端口把 QQ 变成接口）。
 * 少改任何一边，用户看到的现象就是「改了数字但没用」。这里把协议端那边也一起处理。
 */
export function listAccountConfigs() {
  const dir = path.join(paths.snowluma, "config");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const match = /^onebot_(\d{5,12})\.json$/.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const json = readJson(file, null);
    let at = 0;
    try {
      at = Math.round(fs.statSync(file).mtimeMs);
    } catch {
      at = 0;
    }
    out.push({
      selfId: match[1],
      name,
      file,
      wsPorts: (json?.networks?.wsServers ?? []).map((item) => Number(item.port)).filter(Boolean),
      httpPorts: (json?.networks?.httpServers ?? []).map((item) => Number(item.port)).filter(Boolean),
      readable: Boolean(json),
      at,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 一份最小可用的协议端账号配置（复制不到模板时兜底用）。 */
function defaultAccountConfig() {
  const cfg = getConfig();
  const wsPort = Number(new URL(cfg.bot.onebotWsUrl).port || 3101);
  const httpPort = Number(new URL(cfg.bot.onebotHttpUrl).port || 3100);
  const token = cfg.bot.accessToken || "";
  return {
    networks: {
      httpServers: [
        { name: "http-heartecho", host: "127.0.0.1", port: httpPort, path: "/", enableWebSocket: false, accessToken: token, messageFormat: "array", reportSelfMessage: false },
      ],
      httpClients: [],
      wsServers: [
        { name: "ws-heartecho", host: "127.0.0.1", port: wsPort, path: "/", role: "Universal", accessToken: token, messageFormat: "array", reportSelfMessage: false },
      ],
      wsClients: [],
    },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: "#sl" },
    historySync: { enabled: false },
    notifications: { channelIds: [] },
  };
}

/**
 * 让协议端接管一个新 QQ 号。
 * 优先复制现成的配置（端口、令牌都跟心语对得上），没有模板就写一份默认的。
 * 只是写文件，不重启协议端——重启是「运行环境」页那个按钮的事。
 */
export function ensureAccountConfig(selfId) {
  const id = String(selfId ?? "").trim();
  if (!/^\d{5,12}$/.test(id)) return { ok: false, reason: `QQ 号不对：${id || "（空）"}（应该是 5-12 位数字）` };
  const dir = path.join(paths.snowluma, "config");
  const target = path.join(dir, `onebot_${id}.json`);
  if (fs.existsSync(target)) return { ok: true, created: false, file: target };
  if (!fs.existsSync(paths.snowluma)) return { ok: false, reason: `协议端目录不存在：${paths.snowluma}` };
  const template = listAccountConfigs().find((item) => item.readable);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (template) {
      const json = readJson(template.file, null);
      if (!json) return { ok: false, reason: `模板配置读不出来：${template.file}` };
      fs.writeFileSync(target, JSON.stringify(json, null, 2), "utf8");
      return { ok: true, created: true, clonedFrom: template.file, file: target };
    }
    fs.writeFileSync(target, JSON.stringify(defaultAccountConfig(), null, 2), "utf8");
    return { ok: true, created: true, clonedFrom: "", file: target };
  } catch (error) {
    return { ok: false, reason: `写入失败：${error?.message ?? error}` };
  }
}

export function recentProtocolLogs(limit = 40) {
  const dir = path.join(paths.snowluma, "logs");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files.length) return { file: "", lines: [] };
    const file = path.join(dir, files[0].name);
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-limit);
    return { file, lines };
  } catch (error) {
    return { file: "", lines: [], error: String(error?.message ?? error) };
  }
}

export function describeHealth({ onebotStatus, llmStatus, budget }) {
  const checks = [];
  checks.push({
    id: "qq",
    label: "QQ 连接",
    ok: Boolean(onebotStatus?.online),
    detail: onebotStatus?.online
      ? `已接管 ${onebotStatus.nickname || onebotStatus.selfId}（${formatTime(onebotStatus.connectedAt, { withDate: false })} 起）`
      : onebotStatus?.lastError || "还没连上：确认 QQ 已登录、协议端已启动、端口与令牌一致",
  });
  checks.push({
    id: "llm",
    label: "模型接口",
    ok: Boolean(llmStatus?.ready),
    detail: llmStatus?.ready ? `${llmStatus.providerName} · ${llmStatus.model}` : "还没有可用的 API Key / 模型",
  });
  checks.push({
    id: "budget",
    label: "预算",
    ok: budget?.ok !== false,
    detail: budget?.exceeded?.length ? `${budget.exceeded[0].label}已用尽` : `今日已用 ${(Number(budget?.ratio ?? 0) * 100).toFixed(0)}%`,
  });
  return { checks, ok: checks.every((item) => item.ok) };
}
