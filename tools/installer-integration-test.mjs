import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const setup of String(process.env.HEARTECHO_TEST_INSTALLERS || "").split(path.delimiter).filter(Boolean)) {
  test(`安装器预览：${path.basename(setup)}`, { timeout: 70000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "心语 安装集成-"));
    const local = path.join(tmp, "local"), roaming = path.join(tmp, "roaming"), target = path.join(tmp, "安装 目录");
    const env = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, TEMP: tmp, TMP: tmp };
    for (const key of Object.keys(env)) if (key.startsWith("HEARTECHO_")) delete env[key];
    const setupArgs = ["--silent", `--dir=${target}`];
    let launcher;
    let headers;
    let port;
    try {
      const expectedHash = fs.readFileSync(`${setup}.sha256`, "utf8").split("  ")[0];
      assert.equal(createHash("sha256").update(fs.readFileSync(setup)).digest("hex"), expectedHash);
      assert.equal(spawnSync(setup, ["--verify-resources"], { env, timeout: 30000 }).status, 0, "许可或安装清单无法读取");
      assert.equal(spawnSync(setup, setupArgs, { env, timeout: 30000 }).status, 2);
      assert.equal(fs.existsSync(target), false);
      const first = spawnSync(setup, [...setupArgs, "--accept-license"], { env, timeout: 30000 });
      assert.equal(first.status, 0, String(first.error || first.stderr || "安装失败"));
      const edition = fs.readFileSync(path.join(target, "INSTALL-EDITION.txt"), "utf8").trim();
      assert.ok(["generic", "tb"].includes(edition));
      const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, "VERSION.json"), "utf8")).version, version);
      assert.ok(fs.existsSync(path.join(target, "卸载.exe")));
      assert.equal(fs.existsSync(path.join(target, "protocol")), false);
      const launcherPath = path.join(target, edition === "tb" ? "领航员终端.exe" : "心语.exe");
      const data = edition === "tb" ? path.join(local, "心语TB", "data") : path.join(local, "心语");
      port = await freePort();
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ bot: { selfId: 0, panelPort: port }, weather: { enabled: false },
        ...(edition === "tb" ? { tb: { initialized: true, enabled: true } } : {}) }));
      const untouched = fs.readFileSync(path.join(data, "config.json"), "utf8");
      const selftest = spawnSync(launcherPath, ["--selftest", "--no-autostart"], { env, timeout: 30000, encoding: "utf8" });
      assert.equal(selftest.status, 0, String(selftest.error || selftest.stderr || selftest.stdout || "安装版自检失败"));
      assert.equal(fs.readFileSync(path.join(data, "config.json"), "utf8"), untouched);
      assert.deepEqual(fs.readdirSync(data), ["config.json"]);
      fs.mkdirSync(path.join(target, "protocol"));
      fs.writeFileSync(path.join(target, "protocol", "user-state"), "preserve");
      launcher = spawn(launcherPath, ["--no-panel", "--no-tray", "--no-autostart"], { env, stdio: "ignore" });
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && launcher.exitCode === null && !headers) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) headers = { Authorization: `Bearer ${fs.readFileSync(path.join(data, "panel-token"), "utf8").trim()}` };
        } catch { /* 等待启动 */ }
        if (!headers) await wait(150);
      }
      assert.ok(headers, "安装后启动器没有提供面板");
      const ext = await fetch(`http://127.0.0.1:${port}/api/extensions`, { headers }).then((r) => r.json());
      assert.equal(ext.extensions.length, 16);
      const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers }).then((r) => r.json());
      assert.equal(status.version, version);
      assert.equal(spawnSync(setup, [...setupArgs, "--accept-license"], { env, timeout: 30000 }).status, 1, "运行中不应覆盖升级");
      const uninstallArgs = ["--silent", "--uninstall-direct", "--accept-uninstall", "--no-register", `--dir=${target}`];
      assert.equal(spawnSync(setup, uninstallArgs, { env, timeout: 30000 }).status, 1, "运行中不应卸载");
      await fetch(`http://127.0.0.1:${port}/api/system/quit`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      if (launcher.exitCode === null) await new Promise((resolve) => launcher.once("exit", resolve));
      const mainSettings = edition === "tb" ? path.join(local, "心语TB", "心语TB设置.json") : path.join(target, "心语设置.json");
      const originalSettings = fs.existsSync(mainSettings) ? fs.readFileSync(mainSettings, "utf8") : null;
      const externalHome = path.join(tmp, "外部实例家目录"), externalInstance = path.join(tmp, "外部登记实例");
      fs.mkdirSync(path.join(externalInstance, "data", "database"), { recursive: true });
      fs.mkdirSync(externalHome, { recursive: true });
      fs.writeFileSync(path.join(externalInstance, "data", "database", "main.db"), "external-instance-db");
      fs.writeFileSync(path.join(externalHome, "instances.json"), JSON.stringify({ instances: [{ dir: externalInstance }] }));
      fs.mkdirSync(path.dirname(mainSettings), { recursive: true });
      fs.writeFileSync(mainSettings, JSON.stringify({ ...(originalSettings ? JSON.parse(originalSettings) : {}), instancesHome: externalHome }));
      const upgrade = spawnSync(setup, [...setupArgs, "--accept-license"], { env, timeout: 30000 });
      assert.equal(upgrade.status, 0, String(upgrade.error || upgrade.stderr || "升级失败"));
      const externalBackups = path.join(externalInstance, "data", "backups");
      assert.equal(fs.readFileSync(path.join(externalBackups, fs.readdirSync(externalBackups)[0], "main.db"), "utf8"), "external-instance-db");
      if (originalSettings === null) fs.unlinkSync(mainSettings); else fs.writeFileSync(mainSettings, originalSettings);
      assert.equal(fs.readFileSync(path.join(target, "protocol", "user-state"), "utf8"), "preserve");
      assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
      assert.ok(fs.readdirSync(path.join(data, "backups")).some((name) => name.startsWith("installer-")));
      assert.equal(fs.existsSync(path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")), false);
      const codeFile = path.join(target, "app", "index.mjs");
      const original = fs.readFileSync(codeFile);
      fs.writeFileSync(codeFile, "用户修改");
      assert.equal(spawnSync(setup, uninstallArgs, { env, timeout: 30000 }).status, 1, "已修改文件应保留并提示未完成");
      assert.equal(fs.readFileSync(codeFile, "utf8"), "用户修改");
      assert.ok(fs.existsSync(path.join(target, "卸载.exe")));
      fs.writeFileSync(codeFile, original);
      assert.equal(spawnSync(setup, uninstallArgs, { env, timeout: 30000 }).status, 0);
      assert.equal(fs.existsSync(path.join(target, "卸载.exe")), false);
      assert.equal(fs.existsSync(path.join(target, "INSTALL-EDITION.txt")), false);
      assert.equal(fs.readFileSync(path.join(target, "protocol", "user-state"), "utf8"), "preserve");
      assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
      const deletionTarget = path.join(tmp, "删除数据测试安装");
      const deletionSetup = ["--silent", "--accept-license", `--dir=${deletionTarget}`];
      assert.equal(spawnSync(setup, deletionSetup, { env, timeout: 30000 }).status, 0);
      const deleteArgs = ["--silent", "--uninstall-direct", "--accept-uninstall", "--no-register", "--delete-data", `--dir=${deletionTarget}`];
      assert.equal(spawnSync(setup, deleteArgs, { env, timeout: 30000 }).status, 2, "删除数据必须明确确认");
      assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
      const dataLock = path.join(tmp, `heartecho-${createHash("sha1").update(path.resolve(data).toLowerCase()).digest("hex").slice(0, 12)}.lock`);
      fs.writeFileSync(dataLock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      try {
        assert.equal(spawnSync(setup, [...deleteArgs, "--confirm-delete-data"], { env, timeout: 30000 }).status, 1, "数据正在使用时不能删除");
        assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
        assert.ok(fs.existsSync(path.join(deletionTarget, "INSTALL-EDITION.txt")));
      } finally { fs.rmSync(dataLock); }
      const custom = path.join(tmp, "自定义数据");
      fs.mkdirSync(custom); fs.writeFileSync(path.join(custom, "keep"), "private");
      const settingsFile = edition === "tb" ? path.join(local, "心语TB", "心语TB设置.json") : path.join(deletionTarget, "心语设置.json");
      for (const invalid of ["null", "[]", '{"dataDir":42}', '{"dataDir":{}}', '{broken']) {
        fs.writeFileSync(settingsFile, invalid);
        assert.equal(spawnSync(setup, deletionSetup, { env, timeout: 30000 }).status, 1, "无效设置时不能升级");
        assert.equal(spawnSync(setup, [...deleteArgs, "--confirm-delete-data"], { env, timeout: 30000 }).status, 1, "无效设置时不能删除数据");
        assert.ok(fs.existsSync(path.join(data, "database", "main.db")));
        assert.ok(fs.existsSync(path.join(deletionTarget, "INSTALL-EDITION.txt")));
      }
      fs.writeFileSync(settingsFile, JSON.stringify({ dataDir: custom }));
      assert.equal(spawnSync(setup, [...deleteArgs, "--confirm-delete-data"], { env, timeout: 30000 }).status, 1);
      assert.equal(fs.readFileSync(path.join(custom, "keep"), "utf8"), "private");
      assert.ok(fs.existsSync(path.join(deletionTarget, "INSTALL-EDITION.txt")));
      fs.writeFileSync(settingsFile, "{}");
      const outside = path.join(tmp, "外部文件");
      fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "outside");
      const link = path.join(data, "external-junction");
      fs.symlinkSync(outside, link, "junction");
      assert.equal(spawnSync(setup, [...deleteArgs, "--confirm-delete-data"], { env, timeout: 30000 }).status, 1);
      assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "outside");
      fs.rmdirSync(link);
      const helper = path.join(tmp, `heartecho-uninstall-${Date.now()}.exe`);
      fs.copyFileSync(setup, helper);
      const helperArgs = ["--silent", "--uninstall-helper", "--no-register", "--delete-data", "--confirm-delete-data", `--dir=${deletionTarget}`];
      assert.equal(spawnSync(helper, helperArgs, { env, timeout: 30000 }).status, 0);
      assert.equal(fs.existsSync(data), false);
      assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "outside");
      for (let i = 0; i < 50 && fs.existsSync(helper); i++) await wait(100);
      assert.equal(fs.existsSync(helper), false, "临时卸载助手未清理");
      const oldData = path.join(tmp, "旧便携 数据"), importedTarget = path.join(tmp, "导入版程序");
      fs.mkdirSync(path.join(oldData, "characters"), { recursive: true });
      fs.writeFileSync(path.join(oldData, "config.json"), JSON.stringify({ bot: { selfId: 0 }, synthetic: "preserve" }));
      fs.writeFileSync(path.join(oldData, "characters", "role.json"), "old-character");
      const importArgs = ["--silent", "--accept-license", `--dir=${importedTarget}`, `--import-dir=${oldData}`];
      const imported = spawnSync(setup, importArgs, { env, timeout: 30000 });
      assert.equal(imported.status, 0, String(imported.error || imported.stderr || "导入失败"));
      assert.equal(fs.readFileSync(path.join(data, "characters", "role.json"), "utf8"), "old-character");
      assert.equal(fs.readFileSync(path.join(oldData, "characters", "role.json"), "utf8"), "old-character");
      const secondTarget = path.join(tmp, "不可覆盖测试");
      assert.equal(spawnSync(setup, ["--silent", "--accept-license", `--dir=${secondTarget}`, `--import-dir=${oldData}`], { env, timeout: 30000 }).status, 1);
      assert.equal(fs.readFileSync(path.join(data, "characters", "role.json"), "utf8"), "old-character");
      assert.equal(fs.existsSync(secondTarget), false, "导入预检失败时不应安装程序文件");
    } finally {
      if (launcher && launcher.exitCode === null) {
        if (headers) try { await fetch(`http://127.0.0.1:${port}/api/system/quit`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1000) }); } catch { /* 已退出 */ }
        await Promise.race([new Promise((resolve) => launcher.once("exit", resolve)), wait(5000)]);
        if (launcher.exitCode === null) spawnSync("taskkill", ["/PID", String(launcher.pid), "/T", "/F"], { windowsHide: true });
      }
      for (let i = 0; i < 30 && fs.existsSync(tmp); i++) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await wait(200); }
      }
    }
  });
}
