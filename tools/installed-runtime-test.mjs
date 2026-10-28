import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = fileURLToPath(new URL("..", import.meta.url));
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function removeFixture(tmp) {
  for (let attempt = 0; attempt < 30 && fs.existsSync(tmp); attempt++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (error) { if (attempt === 29) throw error; await wait(200); }
  }
}

test("安装布局：启动器、数据隔离、扩展与子实例", { timeout: 40000, skip: process.platform !== "win32" || !fs.existsSync(csc) }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "心语 安装测试-"));
  const root = path.join(tmp, "安装目录");
  const app = path.join(root, "app");
  const local = path.join(tmp, "local");
  const data = path.join(local, "心语");
  const tbData = path.join(local, "心语TB", "data");
  const childDir = path.join(root, "instances", "子 实例");
  const childData = path.join(childDir, "data");
  const children = [];
  const running = [];
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(tbData, { recursive: true });
  fs.mkdirSync(childData, { recursive: true });
  try {
    for (const name of ["index.mjs", "package.json", "lib", "extensions", "examples"]) {
      fs.cpSync(path.join(repo, name), path.join(app, name), { recursive: true });
    }
    fs.copyFileSync(process.execPath, path.join(root, "runtime", "node.exe"));
    const exe = path.join(root, "心语.exe");
    const compiled = spawnSync(csc, ["/nologo", "/target:winexe", "/reference:System.Windows.Forms.dll", `/out:${exe}`, path.join(repo, "installer", "Launcher.cs")], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    const tbExe = path.join(root, "领航员终端.exe");
    const tbCompiled = spawnSync(csc, ["/nologo", "/target:winexe", "/define:TB_EDITION", "/reference:System.Windows.Forms.dll", `/out:${tbExe}`, path.join(repo, "installer", "Launcher.cs")], { encoding: "utf8" });
    assert.equal(tbCompiled.status, 0, `${tbCompiled.stdout}\n${tbCompiled.stderr}`);
    const ports = [await freePort(), await freePort(), await freePort()];
    const config = (port) => JSON.stringify({ bot: { selfId: 0, panelPort: port }, weather: { enabled: false } });
    fs.writeFileSync(path.join(data, "config.json"), config(ports[0]));
    fs.writeFileSync(path.join(childData, "config.json"), config(ports[1]));
    fs.writeFileSync(path.join(tbData, "config.json"), JSON.stringify({ bot: { selfId: 0, panelPort: ports[2] }, weather: { enabled: false }, tb: { initialized: true, enabled: true } }));
    fs.writeFileSync(path.join(childDir, "心语设置.json"), JSON.stringify({ dataDir: "data", autoStartProtocol: false }));
    const env = { ...process.env, LOCALAPPDATA: local, APPDATA: path.join(tmp, "roaming") };
    for (const key of Object.keys(env)) if (key.startsWith("HEARTECHO_")) delete env[key];

    async function start(args, expectedData, port, launcher = exe) {
      const proc = spawn(launcher, [...args, "--no-panel", "--no-tray", "--no-autostart"], { env, stdio: "ignore" });
      children.push(proc);
      const deadline = Date.now() + 12000;
      let ok = false;
      while (Date.now() < deadline && proc.exitCode === null) {
        try { ok = (await fetch(`http://127.0.0.1:${port}/`)).ok; if (ok) break; } catch { /* 等待启动 */ }
        await wait(150);
      }
      assert.ok(ok, "安装版没有启动面板");
      const token = fs.readFileSync(path.join(expectedData, "panel-token"), "utf8").trim();
      const headers = { Authorization: `Bearer ${token}` };
      const status = await fetch(`http://127.0.0.1:${port}/api/extensions`, { headers }).then((r) => r.json());
      assert.equal(status.extensions.length, 16, JSON.stringify(status.errors));
      const system = await fetch(`http://127.0.0.1:${port}/api/system`, { headers }).then((r) => r.json());
      assert.equal(system.settings.autoStartProtocol, false);
      assert.equal(system.runtime.version, JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version);
      assert.equal(system.runtime.installed, true);
      const instance = { proc, port, headers };
      running.push(instance);
      return instance;
    }
    const main = await start([], data, ports[0]);
    const child = await start(["--instance", childDir], childData, ports[1]);
    const tb = await start([], tbData, ports[2], tbExe);
    for (const [instance, name] of [[main, "领航员终端"], [tb, "心语"]]) {
      const status = await fetch(`http://127.0.0.1:${instance.port}/api/status`, { headers: instance.headers }).then((res) => res.json());
      assert.deepEqual(status.otherEdition, { running: true, name });
    }
    assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
    assert.ok(fs.existsSync(path.join(childData, "database", "main.db")));
    assert.notEqual(fs.readFileSync(path.join(data, "panel-token"), "utf8"), fs.readFileSync(path.join(childData, "panel-token"), "utf8"));
    assert.notEqual(fs.readFileSync(path.join(data, "panel-token"), "utf8"), fs.readFileSync(path.join(tbData, "panel-token"), "utf8"));
    const toggleAutostart = (instance, enabled) => fetch(`http://127.0.0.1:${instance.port}/api/system/autostart`, {
      method: "POST", headers: { ...instance.headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
    }).then((res) => res.json());
    const startupMain = await toggleAutostart(main, true);
    const startupChild = await toggleAutostart(child, true);
    const startupTb = await toggleAutostart(tb, true);
    for (const startup of [startupMain, startupChild, startupTb]) {
      assert.equal(startup.ok, true, startup.message);
      assert.ok(startup.file.startsWith(path.join(tmp, "roaming")));
    }
    assert.equal(startupMain.target, exe);
    assert.equal(startupChild.target, exe);
    assert.equal(startupTb.target, tbExe);
    assert.ok(startupChild.args.includes(childDir));
    assert.notEqual(startupMain.file, startupChild.file);
    assert.equal((await toggleAutostart(child, false)).ok, true);
    assert.ok(fs.existsSync(startupMain.file));
    assert.ok(fs.existsSync(startupTb.file));
    for (const instance of [child, tb, main]) {
      await fetch(`http://127.0.0.1:${instance.port}/api/system/restart`, {
        method: "POST", headers: { ...instance.headers, "Content-Type": "application/json" }, body: "{}",
      });
      if (instance.proc.exitCode === null) await new Promise((resolve) => instance.proc.once("exit", resolve));
      let restarted = false;
      const restartDeadline = Date.now() + 20000;
      while (Date.now() < restartDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${instance.port}/api/extensions`, { headers: instance.headers });
          if (res.ok && (await res.json()).extensions.length === 16) { restarted = true; break; }
        } catch { /* 等待接管 */ }
        await wait(250);
      }
      assert.ok(restarted, `端口 ${instance.port} 的实例重启后没有恢复其面板与扩展`);
    }
    for (const instance of [child, tb, main]) {
      await fetch(`http://127.0.0.1:${instance.port}/api/system/quit`, {
        method: "POST", headers: { ...instance.headers, "Content-Type": "application/json" }, body: "{}",
      });
      if (instance.proc.exitCode === null) await new Promise((resolve) => instance.proc.once("exit", resolve));
      assert.equal(instance.proc.exitCode, 0);
    }
  } finally {
    for (const instance of running) {
      try {
        await fetch(`http://127.0.0.1:${instance.port}/api/system/quit`, {
          method: "POST", headers: { ...instance.headers, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1000),
        });
      } catch { /* 实例已退出 */ }
    }
    for (const child of children) if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    // 通过面板退出的重启实例不再是测试进程的子进程；等它释放 exe 和 SQLite 文件。
    await removeFixture(tmp);
  }
});

for (const payload of String(process.env.HEARTECHO_TEST_PAYLOADS || "").split(path.delimiter).filter(Boolean)) {
  test(`实际安装负载：${path.basename(payload)}`, { timeout: 20000 }, async () => {
    const root = path.resolve(payload);
    const info = JSON.parse(fs.readFileSync(path.join(root, "VERSION.json"), "utf8"));
    const launcher = path.join(root, info.edition === "tb" ? "领航员终端.exe" : "心语.exe");
    assert.equal(fs.existsSync(path.join(root, "protocol")), false);
    assert.equal(fs.existsSync(path.join(root, "data")), false);
    const lines = fs.readFileSync(path.join(root, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/);
    for (const line of lines) {
      const [digest, relative] = line.split("  ");
      assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex"), digest, relative);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-payload-check-"));
    const local = path.join(tmp, "local");
    const data = info.edition === "tb" ? path.join(local, "心语TB", "data") : path.join(local, "心语");
    const port = await freePort();
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ bot: { selfId: 0, panelPort: port }, weather: { enabled: false },
      ...(info.edition === "tb" ? { tb: { initialized: true, enabled: true } } : {}) }));
    const env = { ...process.env, LOCALAPPDATA: local, APPDATA: path.join(tmp, "roaming") };
    for (const key of Object.keys(env)) if (key.startsWith("HEARTECHO_")) delete env[key];
    const child = spawn(launcher, ["--no-panel", "--no-tray", "--no-autostart"], { env, stdio: "ignore" });
    let headers;
    try {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && child.exitCode === null && !headers) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) headers = { Authorization: `Bearer ${fs.readFileSync(path.join(data, "panel-token"), "utf8").trim()}` };
        } catch { /* 等待启动 */ }
        if (!headers) await wait(150);
      }
      assert.ok(headers, "实际安装负载没有启动面板");
      const status = await fetch(`http://127.0.0.1:${port}/api/extensions`, { headers }).then((res) => res.json());
      assert.equal(status.extensions.length, 16, JSON.stringify(status.errors));
    } finally {
      if (headers) {
        try { await fetch(`http://127.0.0.1:${port}/api/system/quit`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1000) }); } catch { /* 已停止 */ }
      }
      if (child.exitCode === null) {
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(5000)]);
        if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      }
      await removeFixture(tmp);
    }
  });
}
