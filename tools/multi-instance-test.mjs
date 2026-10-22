import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import vm from "node:vm";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-instances-"));
const app = path.join(tmp, "A");
const data = path.join(app, "data");
// 多实例共用的那一份协议端（主实例目录下）
const protocol = path.join(app, "protocol");
const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
// 用真实空闲端口，避免测试误判「协议端/WebUI 在跑」而真去重启用户机器上的那一份
const webuiPort = await freePort();
const parentPanelPort = await freePort();
const parentWsPort = await freePort();
const parentHttpPort = await freePort();
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: app,
  HEARTECHO_DATA_DIR: data,
  HEARTECHO_LOG_DIR: path.join(data, "logs"),
  HEARTECHO_SETTINGS: path.join(app, "心语设置.json"),
  HEARTECHO_SNOWLUMA_DIR: protocol,
  HEARTECHO_INSTANCES_HOME: app,
  HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"),
  HEARTECHO_API_KEY: "SYNTHETIC_ONLY",
  HEARTECHO_LOG_LEVEL: "error",
});
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const { ensureDirs } = await import("../lib/paths.mjs");
ensureDirs();
write(path.join(app, "心语设置.json"), { dataDir: "data", snowlumaDir: "protocol" });
write(path.join(protocol, "config", "runtime.json"), { webuiPort });
write(path.join(protocol, "config", "onebot_10000001.json"), { networks: {} });
write(path.join(protocol, "node_modules", "fixture", "package.json"), { name: "fixture" });
fs.writeFileSync(path.join(protocol, "index.mjs"), "// Inert fixture; never executed.\n");
const config = await import("../lib/config.mjs");
const instances = await import("../lib/instances.mjs");
const protocolMod = await import("../lib/protocol.mjs");
const auth = await import("../lib/panel-auth.mjs");
const { createApiServer } = await import("../lib/api.mjs");
const { APP_JS } = await import("../lib/ui-app.mjs");
config.saveCharacter("hatsuzuki", { name: "初月" });
config.saveConfig({
  activeCharacter: "hatsuzuki",
  bot: {
    selfId: 10000001,
    masterId: 10000009,
    accessToken: "SYNTHETIC_A",
    panelPort: parentPanelPort,
    onebotWsUrl: `ws://127.0.0.1:${parentWsPort}/`,
    onebotHttpUrl: `http://127.0.0.1:${parentHttpPort}/`,
  },
});
const api = createApiServer({
  client: { status: {}, queue: [] },
  llm: {},
  chat: {},
  log: { info() {}, warn() {}, error() {} },
  control: {},
});
await api.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${api.server.address().port}`;
const tokenA = auth.panelToken();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", "tests must not contact external services");
  return nativeFetch(url, options);
};
async function request(route, body) {
  const res = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
let laffey;
let b;
after(async () => {
  globalThis.fetch = nativeFetch;
  api.close();
  api.server.closeAllConnections();
  (await import("../lib/db.mjs")).closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.ok(path.basename(tmp).startsWith("heartecho-instances-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("creating a second character leaves the running role unchanged; activation is explicit", async () => {
  laffey = (await request("/api/characters/new", { name: "拉菲" })).character;
  assert.equal(config.activeCharacterId(), "hatsuzuki");
  assert.equal(config.listCharacters().length, 2);
  await request(`/api/characters/${laffey.id}/activate`, {});
  assert.equal(config.activeCharacterId(), laffey.id);
  await request("/api/characters/hatsuzuki/activate", {});
  await request("/api/characters/new", { name: "Explicit", activate: true });
  assert.equal(config.activeCharacter().name, "Explicit");
  await request("/api/characters/hatsuzuki/activate", {});
});

test("new instances put their account into the shared protocol bridge instead of copying it", async () => {
  b = await instances.createInstance({ name: "B", accountId: "10000002", characterId: laffey.id });
  assert.equal(b.protocolOk, true);
  assert.equal(b.protocolShared, true);
  assert.equal(b.webuiPort, webuiPort, "共用协议端后 WebUI 端口应该是主实例那一个");
  const child = read(path.join(b.dir, "data", "config.json"));
  const account = read(path.join(protocol, "config", "onebot_10000002.json"));
  assert.equal(account.networks.wsServers[0].port, Number(new URL(child.bot.onebotWsUrl).port));
  assert.equal(account.networks.httpServers[0].port, Number(new URL(child.bot.onebotHttpUrl).port));
  assert.equal(account.networks.wsServers[0].accessToken, child.bot.accessToken);
  assert.equal(account.networks.httpServers[0].accessToken, child.bot.accessToken);
  assert.notEqual(child.bot.accessToken, config.getConfig().bot.accessToken);
  // 不再复制一份协议端：SnowLuma 会 hook 这台机器上所有 QQ 客户端，两份会互相抢钩子
  assert.equal(fs.existsSync(path.join(b.dir, "protocol")), false, "实例目录里不该再有 protocol 副本");
  const settings = read(path.join(b.dir, "心语设置.json"));
  assert.equal(path.resolve(settings.snowlumaDir), path.resolve(protocol), "snowlumaDir 要指向共用那一份");
  // 共用目录里主实例自己的账号配置不能被动过
  assert.deepEqual(read(path.join(protocol, "config", "onebot_10000001.json")), { networks: {} });
  assert.equal(fs.existsSync(path.join(protocol, "node_modules", "fixture", "package.json")), true);
  assert.deepEqual(fs.readdirSync(path.join(b.dir, "data", "characters")), [`${laffey.id}.json`]);
  assert.equal(config.activeCharacterId(), "hatsuzuki");
});

test("multiple offline instances reserve their own panel/onebot ports and share the bridge webui", async () => {
  const c = await instances.createInstance({ name: "C", accountId: "10000003", characterId: laffey.id });
  const ports = [b, c].flatMap((x) => [x.panelPort, x.wsPort, x.httpPort]);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(b.webuiPort, webuiPort);
  assert.equal(c.webuiPort, webuiPort);
  const parent = config.getConfig().bot;
  for (const port of [
    parent.panelPort,
    Number(new URL(parent.onebotWsUrl).port),
    Number(new URL(parent.onebotHttpUrl).port),
    webuiPort,
  ]) {
    assert.ok(!ports.includes(port));
  }
});

test("a child shares the registry while keeping its own data, and identifies the actual current instance", () => {
  const probe = path.join(tmp, "probe.mjs");
  fs.writeFileSync(
    probe,
    [
      `import ${JSON.stringify(new URL("../lib/boot-env.mjs", import.meta.url).href)};`,
      `import { paths } from ${JSON.stringify(new URL("../lib/paths.mjs", import.meta.url).href)};`,
      `import { registryFile, listInstances } from ${JSON.stringify(new URL("../lib/instances.mjs", import.meta.url).href)};`,
      "console.log(JSON.stringify({ data: paths.data, registry: registryFile(), list: await listInstances() }));",
    ].join("\n"),
  );
  const env = { ...process.env };
  for (const key of [
    "HEARTECHO_APP_DIR",
    "HEARTECHO_DATA_DIR",
    "HEARTECHO_LOG_DIR",
    "HEARTECHO_SETTINGS",
    "HEARTECHO_SNOWLUMA_DIR",
    "HEARTECHO_INSTANCES_HOME",
  ])
    delete env[key];
  const run = childProcess.spawnSync(process.execPath, [probe, "--instance", b.dir], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(got.registry, instances.registryFile());
  assert.equal(got.data, path.join(b.dir, "data"));
  assert.equal(got.list.filter((x) => x.current).length, 1);
  assert.equal(got.list.find((x) => x.current).dir, b.dir);
  assert.ok(got.list.some((x) => x.dir === app));
});

test("opening B through A retains B credentials and uses B browser storage", async () => {
  const tokenB = "b".repeat(64);
  fs.writeFileSync(path.join(b.dir, "data", "panel-token"), tokenB);
  const server = http.createServer((req, res) => {
    const denied = auth.checkPanelRequest(req, { host: "127.0.0.1", port: server.address().port, token: tokenB });
    res.writeHead(denied?.code ?? 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        denied ? { ok: false, message: denied.message } : { ok: true, character: { name: "拉菲" }, onebot: {} },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(b.dir, "data", "config.json");
  const cfg = read(file);
  cfg.bot.panelPort = server.address().port;
  write(file, cfg);
  const original = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (exe, args) => {
    calls.push({ exe, args });
    return { pid: 12345, unref() {} };
  };
  syncBuiltinESMExports();
  try {
    await request("/api/instances/open", { dir: b.dir });
    const args = calls[0].args;
    const urlArg = args.find((x) => x.startsWith("--app=")) ?? args.find((x) => x.startsWith("http://"));
    const opened = new URL(urlArg.replace(/^--app=/, ""));
    const token = new URLSearchParams(opened.hash.slice(1)).get("panelToken");
    assert.equal(token, tokenB);
    if (args.some((x) => x.startsWith("--app=")))
      assert.ok(args.includes(`--user-data-dir=${path.join(b.dir, "data", "cache", "window-profile")}`));
    const session = (credential) =>
      fetch(opened.origin + "/api/panel/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: "{}",
      });
    assert.equal((await session(token)).status, 200);
    assert.equal((await session(tokenA)).status, 401);
    assert.equal(
      (
        await fetch(opened.origin + "/api/panel/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("starting an existing child repairs its shared protocol config and removes inherited directory overrides", async () => {
  const accountFile = path.join(protocol, "config", "onebot_10000002.json");
  if (fs.existsSync(accountFile)) fs.unlinkSync(accountFile);
  const original = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    return { pid: 12345, unref() {} };
  };
  syncBuiltinESMExports();
  try {
    const result = await instances.startInstance(b.dir);
    assert.equal(result.ok, true, result.reason);
    assert.ok(fs.existsSync(accountFile));
    const settings = read(path.join(b.dir, "心语设置.json"));
    assert.equal(path.resolve(settings.snowlumaDir), path.resolve(protocol));
    const env = calls[0].options.env;
    assert.equal(env.HEARTECHO_INSTANCES_HOME, app);
    for (const key of ["HEARTECHO_DATA_DIR", "HEARTECHO_LOG_DIR", "HEARTECHO_SNOWLUMA_DIR"])
      assert.equal(env[key], undefined);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("repair preserves unrelated protocol options and refuses malformed configuration", async () => {
  const file = path.join(protocol, "config", "onebot_10000002.json");
  const original = childProcess.spawn;
  childProcess.spawn = () => ({ pid: 12345, unref() {} });
  syncBuiltinESMExports();
  try {
    const account = read(file);
    account.historySync = { enabled: true };
    account.networks.wsServers[0].port = 2999;
    account.networks.wsServers[0].accessToken = "STALE_SYNTHETIC";
    account.networks.wsServers.push({ name: "unrelated", port: 2998, path: "/custom" });
    write(file, account);
    assert.equal((await instances.startInstance(b.dir)).ok, true);
    const fixed = read(file);
    const cfg = read(path.join(b.dir, "data", "config.json"));
    assert.equal(fixed.networks.wsServers[0].port, Number(new URL(cfg.bot.onebotWsUrl).port));
    assert.equal(fixed.networks.wsServers[0].accessToken, cfg.bot.accessToken);
    assert.deepEqual(fixed.networks.wsServers[1], account.networks.wsServers[1]);
    assert.deepEqual(fixed.historySync, account.historySync);
    fs.writeFileSync(file, "{broken");
    assert.equal((await instances.startInstance(b.dir)).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
    write(file, fixed);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("a legacy per-instance protocol copy is migrated onto the shared bridge when started", async () => {
  const legacy = await instances.createInstance({ name: "Legacy", accountId: "10000004", characterId: laffey.id });
  // 模拟老版本留下的实例：设置指回自己目录，目录里还躺着一份协议端副本
  write(path.join(legacy.dir, "心语设置.json"), {
    dataDir: "data",
    logDir: "logs",
    snowlumaDir: "protocol",
    instancesHome: app,
    instancesMainDataDir: data,
  });
  fs.mkdirSync(path.join(legacy.dir, "protocol", "config"), { recursive: true });
  const original = childProcess.spawn;
  childProcess.spawn = () => ({ pid: 12345, unref() {} });
  syncBuiltinESMExports();
  try {
    const result = await instances.startInstance(legacy.dir);
    assert.equal(result.ok, true, result.reason);
    const settings = read(path.join(legacy.dir, "心语设置.json"));
    assert.equal(path.resolve(settings.snowlumaDir), path.resolve(protocol), "旧实例启动时要改指向共用协议端");
    const account = read(path.join(protocol, "config", "onebot_10000004.json"));
    const childCfg = read(path.join(legacy.dir, "data", "config.json"));
    assert.equal(account.networks.wsServers[0].port, Number(new URL(childCfg.bot.onebotWsUrl).port));
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("protocol spawn lock is exclusive, survives a stale holder and is taken over when its owner is gone", () => {
  const lockFile = path.join(protocol, ".heartecho-spawn.lock");
  fs.rmSync(lockFile, { force: true });
  const first = protocolMod.acquireProtocolSpawnLock();
  assert.equal(first.ok, true);
  assert.equal(protocolMod.acquireProtocolSpawnLock().ok, false, "同一时刻不允许第二个调用者拉起协议端");
  protocolMod.releaseProtocolSpawnLock(first.file);
  assert.equal(fs.existsSync(lockFile), false);

  // 另一个活进程占着：抢不到
  write(lockFile, { pid: process.ppid, at: Date.now() });
  assert.equal(protocolMod.acquireProtocolSpawnLock().ok, false, "另一个活着的实例正在启动时不能重复拉起");
  // 占着的进程已经没了：接管
  write(lockFile, { pid: 999999, at: Date.now() - 120000 });
  const takeover = protocolMod.acquireProtocolSpawnLock();
  assert.equal(takeover.ok, true);
  assert.equal(takeover.tookOver, true);
  protocolMod.releaseProtocolSpawnLock(takeover.file);
  fs.rmSync(lockFile, { force: true });
});

test("diagnosis tells the difference between 'bridge running but this account is not adopted' and 'not running'", async () => {
  const reportOffline = await protocolMod.diagnoseProtocol();
  assert.equal(reportOffline.shared, true, "多实例下协议端就是共用的");
  assert.equal(reportOffline.webuiPort, webuiPort);
  assert.equal(reportOffline.bridgeRunning, false);

  // 在 WebUI 端口上起一个「像 SnowLuma」的服务，模拟共用协议端在跑、却没接管这个号
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>SnowLuma 控制台</title>");
  });
  await new Promise((resolve) => server.listen(webuiPort, "127.0.0.1", resolve));
  try {
    const report = await protocolMod.diagnoseProtocol();
    assert.equal(report.running, false, "当前这个号的端口没监听");
    assert.equal(report.bridgeRunning, true, "但共用协议端整体在跑");
    assert.match(report.nextAction, /重启协议端/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("studio can select a draft without activating it, then explicitly activate it", async () => {
  const handlers = new Map();
  const ctx = vm.createContext({
    console,
    ICONS: {},
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => tokenA },
    document: { documentElement: { setAttribute() {} }, addEventListener() {} },
    window: { addEventListener() {} },
    fetch: (route, options) => fetch(base + route, options),
  });
  vm.runInContext(APP_JS + "\nglobalThis.studio={S,loadCharacters,pageStudio};", ctx);
  await ctx.studio.loadCharacters(laffey.id);
  const html = await ctx.studio.pageStudio();
  assert.match(html, /btnActivateChar/);
  assert.equal(ctx.studio.S.activeCharacter.id, "hatsuzuki");
  assert.equal(ctx.studio.S.editingCharacter.id, laffey.id);
  assert.equal(config.activeCharacterId(), "hatsuzuki");
  // Bind the real event handlers, with only the DOM controls needed by this scenario.
  ctx.document.getElementById = (id) =>
    id === "btnActivateChar" ? { addEventListener: (event, handler) => handlers.set(event, handler) } : null;
  ctx.document.querySelectorAll = () => [];
  ctx.document.querySelector = () => null;
  vm.runInContext("render=async()=>{};toast=()=>{};wire();", ctx);
  await handlers.get("click")();
  assert.equal(config.activeCharacterId(), laffey.id);
  await request("/api/characters/hatsuzuki/activate", {});
});
