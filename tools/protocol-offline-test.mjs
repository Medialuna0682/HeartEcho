import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("安装版用随包 Node 启动用户选择的模拟协议端", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-protocol-mock-"));
  const app = path.join(tmp, "app"), data = path.join(tmp, "data"), protocolDir = path.join(tmp, "app-other", "protocol");
  const port = await freePort(), webuiPort = await freePort();
  fs.mkdirSync(path.join(app, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(protocolDir, "config"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(app, "runtime", "node.exe"));
  fs.writeFileSync(path.join(protocolDir, "config", "runtime.json"), JSON.stringify({ webuiPort }));
  fs.writeFileSync(path.join(protocolDir, "package.json"), JSON.stringify({ name: "@snowluma/runtime", version: "1.14.22" }));
  fs.writeFileSync(path.join(protocolDir, "index.mjs"), `import net from 'node:net';net.createServer().listen(${port},'127.0.0.1');`);
  const settings = path.join(tmp, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ snowlumaDir: protocolDir, autoStartProtocol: false }));
  for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
  Object.assign(process.env, { HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: app, HEARTECHO_APP_DIR: app,
    HEARTECHO_DATA_DIR: data, HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: settings });
  const { ensureDirs } = await import("../lib/paths.mjs");
  ensureDirs();
  const { saveConfig } = await import("../lib/config.mjs");
  saveConfig({ bot: { selfId: 12345, onebotWsUrl: `ws://127.0.0.1:${port}/` } });
  const { diagnoseProtocol, startProtocol, stopProtocol, restartProtocol, protocolRuntimeInfo } = await import("../lib/protocol.mjs");
  let pid = 0;
  let unrelated;
  try {
    const before = await diagnoseProtocol();
    assert.equal(before.node.toLowerCase(), path.join(app, "runtime", "node.exe").toLowerCase());
    assert.equal(before.dir, protocolDir);
    const authFile = path.join(protocolDir, "config", "webui.json");
    const initialized = { passwordHash: "a".repeat(128), passwordSalt: "b".repeat(32), mustChangePassword: false, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    for (const contents of [null, "{}", "{broken", JSON.stringify({ ...initialized, mustChangePassword: true }), JSON.stringify({ ...initialized, unknown: true })]) {
      if (contents !== null) fs.writeFileSync(authFile, contents);
      const blocked = await startProtocol({ waitMs: 1000 });
      assert.equal(blocked.ok, false);
      assert.match(blocked.message, /手动启动 SnowLuma/);
      assert.equal(fs.existsSync(path.join(tmp, "logs", "protocol.out.log")), false);
    }
    fs.writeFileSync(authFile, JSON.stringify(initialized));
    unrelated = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(${webuiPort},'127.0.0.1',()=>console.log('ready'))`], { stdio: ["ignore", "pipe", "pipe"] });
    await Promise.race([new Promise((resolve, reject) => { unrelated.stdout.once("data", resolve); unrelated.once("error", reject); }), new Promise((_, reject) => setTimeout(() => reject(new Error("模拟占用端口的进程未就绪")), 5000))]);
    assert.equal((await stopProtocol()).stopped, false);
    assert.equal((await restartProtocol()).ok, false);
    assert.equal(unrelated.exitCode, null, "端口被其他程序占用时不能结束它");
    unrelated.kill();
    await new Promise((resolve) => unrelated.once("exit", resolve));
    unrelated = null;
    const result = await startProtocol({ waitMs: 8000 });
    pid = result.pid || 0;
    assert.ok(result.ok && pid, result.message);
    assert.equal((await diagnoseProtocol()).running, true);
    const oldPid = pid;
    const restarted = await restartProtocol({ waitMs: 8000 });
    pid = protocolRuntimeInfo().spawned?.pid || 0;
    assert.ok(restarted.ok && restarted.started, restarted.message);
    assert.equal(restarted.stoppedPid, oldPid);
    assert.ok(pid && pid !== oldPid);
    unrelated = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(${webuiPort},'127.0.0.1',()=>console.log('ready'))`], { stdio: ["ignore", "pipe", "pipe"] });
    await Promise.race([new Promise((resolve, reject) => { unrelated.stdout.once("data", resolve); unrelated.once("error", reject); }), new Promise((_, reject) => setTimeout(() => reject(new Error("模拟占用端口的进程未就绪")), 5000))]);
    const blocked = await restartProtocol({ waitMs: 8000 });
    assert.equal(blocked.ok, false, "端口仍被占用时不能再启动");
    assert.equal(unrelated.exitCode, null, "不能结束占用端口的其他进程");
    assert.equal(protocolRuntimeInfo().spawned, null);
    pid = 0;
    unrelated.kill();
    await new Promise((resolve) => unrelated.once("exit", resolve));
    unrelated = null;
    const last = await startProtocol({ waitMs: 8000 });
    pid = last.pid || 0;
    assert.ok(last.ok && pid, last.message);
    assert.equal((await stopProtocol()).stopped, true);
    pid = 0;
  } finally {
    if (unrelated) unrelated.kill();
    if (pid) { try { process.kill(pid); } catch { /* 测试进程已退出 */ } }
    for (let attempt = 0; attempt < 30 && fs.existsSync(tmp); attempt++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});
