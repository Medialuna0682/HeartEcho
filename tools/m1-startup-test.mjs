import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const tb of [false, true]) test(`${tb ? "TB" : "通用版"}首次配置时保持面板可访问`, { timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-setup-"));
  const data = path.join(tmp, "data");
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  const settings = path.join(tmp, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ autoStartProtocol: false }));
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({
    bot: { selfId: 0, panelPort: port }, weather: { enabled: false },
  }));
  const env = { ...process.env, HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: data,
    HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: settings };
  if (tb) {
    const init = spawnSync(process.execPath, ["index.mjs", "--tb", "--panel-url"], { env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const configFile = path.join(data, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(config.tb.initialized, true);
    assert.equal(config.activeCharacter, "navigator-tb");
    config.bot.panelPort = port;
    fs.writeFileSync(configFile, JSON.stringify(config));
  }
  const child = spawn(process.execPath, ["index.mjs", ...(tb ? ["--tb"] : []), "--no-panel", "--no-tray", "--no-autostart"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  try {
    let response;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) break; } catch { /* 等待面板启动 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(response?.ok, `面板未启动：${output}`);
    assert.equal(child.exitCode, null, output);
    assert.match(output, /首次配置模式/);
    assert.doesNotMatch(output, /机器人 QQ 号必须是有效数字/);
    const token = fs.readFileSync(path.join(data, "panel-token"), "utf8").trim();
    const denied = await fetch(`http://127.0.0.1:${port}/api/characters`);
    assert.equal(denied.status, 401);
    const authenticated = await fetch(`http://127.0.0.1:${port}/api/characters`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).ok, true);
    const create = async (name) => {
      const result = await fetch(`http://127.0.0.1:${port}/api/characters/new`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      assert.equal(result.status, 200);
      return (await result.json()).character;
    };
    const first = await create("CaseTest");
    const second = await create("casetest");
    assert.notEqual(first.id.toLowerCase(), second.id.toLowerCase());
    const list = await fetch(`http://127.0.0.1:${port}/api/characters`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((result) => result.json());
    assert.ok(list.list.some((item) => item.id === first.id));
    assert.ok(list.list.some((item) => item.id === second.id));
    const characterUrl = `http://127.0.0.1:${port}/api/characters/${encodeURIComponent(second.id)}`;
    const deleted = await fetch(characterUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(deleted.status, 200);
    const saveDeleted = await fetch(characterUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "不应重建" }) });
    assert.equal(saveDeleted.ok, false);
    assert.equal(fs.existsSync(path.join(data, "characters", `${second.id}.json`)), false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const exe = fileURLToPath(new URL("../dist/心语.exe", import.meta.url));
test("便携 exe 自检不会使用现有数据目录", { timeout: 30000, skip: !fs.existsSync(exe) }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-sea-selftest-"));
  try {
    const data = path.join(tmp, "existing-data"), temp = path.join(tmp, "temp");
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
    const sentinel = path.join(data, "config.json");
    fs.writeFileSync(sentinel, '{"marker":"must-not-change"}');
    const env = { ...process.env, TEMP: temp, TMP: temp, LOCALAPPDATA: path.join(tmp, "local"), HEARTECHO_APP_DIR: tmp,
      HEARTECHO_DATA_DIR: data, HEARTECHO_SELFTEST_TMP: data, HEARTECHO_SETTINGS: path.join(tmp, "settings.json") };
    const result = spawnSync(exe, ["--selftest", "--no-autostart"], { env, encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, String(result.error || result.stderr || result.stdout));
    assert.equal(fs.readFileSync(sentinel, "utf8"), '{"marker":"must-not-change"}');
    assert.deepEqual(fs.readdirSync(data), ["config.json"]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("TB 设置中的自定义数据目录优先于默认路径", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-tb-custom-"));
  try {
    const local = path.join(tmp, "local"), custom = path.join(tmp, "custom"), tbHome = path.join(local, "心语TB");
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(tbHome, { recursive: true });
    fs.writeFileSync(path.join(tbHome, "心语TB设置.json"), JSON.stringify({ dataDir: custom }));
    fs.writeFileSync(path.join(custom, "config.json"), JSON.stringify({ tb: { initialized: true } }));
    const env = { ...process.env, LOCALAPPDATA: local, HEARTECHO_APP_DIR: tmp };
    for (const key of ["HEARTECHO_DATA_DIR", "HEARTECHO_SETTINGS", "HEARTECHO_LOG_DIR"]) delete env[key];
    const result = spawnSync(process.execPath, ["index.mjs", "--tb", "--panel-url"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(custom, "panel-token")));
    assert.equal(fs.existsSync(path.join(tbHome, "data", "panel-token")), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("自检在加载配置前隔离数据与设置", { timeout: 30000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-selftest-boundary-"));
  try {
    const local = path.join(tmp, "local"), temp = path.join(tmp, "temp"), actualData = path.join(local, "心语");
    fs.mkdirSync(actualData, { recursive: true });
    fs.mkdirSync(temp, { recursive: true });
    const sentinel = path.join(actualData, "config.json");
    fs.writeFileSync(sentinel, '{"marker":"must-not-change"}');
    const realSettings = path.join(tmp, "real-settings.json");
    fs.writeFileSync(realSettings, '{"marker":"settings-must-not-change"}');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
    Object.assign(env, { LOCALAPPDATA: local, TEMP: temp, TMP: temp, HEARTECHO_INSTALLED: "1",
      HEARTECHO_INSTALL_ROOT: process.cwd(), HEARTECHO_APP_DIR: process.cwd(), HEARTECHO_DATA_DIR: actualData,
      HEARTECHO_SELFTEST_TMP: actualData, HEARTECHO_SETTINGS: realSettings });
    const result = spawnSync(process.execPath, ["index.mjs", "--selftest"], { env, encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /心语自检：\d+ \/ \d+ 通过/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), '{"marker":"must-not-change"}');
    assert.equal(fs.readFileSync(realSettings, "utf8"), '{"marker":"settings-must-not-change"}');
    assert.deepEqual(fs.readdirSync(actualData), ["config.json"]);
    assert.equal(fs.readdirSync(temp).some((name) => name.startsWith("heartecho-selftest-")), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("便携 exe 在空账号下启动带鉴权的面板", { timeout: 20000, skip: !fs.existsSync(exe) }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-exe-setup-"));
  const data = path.join(tmp, "data");
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ bot: { selfId: 0, panelPort: port }, weather: { enabled: false } }));
  const env = { ...process.env, HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: data,
    HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: path.join(tmp, "settings.json") };
  const child = spawn(exe, ["--no-panel", "--no-tray", "--no-autostart"], { env, stdio: "ignore" });
  try {
    let response;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) break; } catch { /* 等待面板启动 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(response?.ok, "便携 exe 未启动面板");
    const token = fs.readFileSync(path.join(data, "panel-token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/characters`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const system = await fetch(`http://127.0.0.1:${port}/api/system`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    assert.equal(system.runtime.version, JSON.parse(fs.readFileSync("package.json", "utf8")).version);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
