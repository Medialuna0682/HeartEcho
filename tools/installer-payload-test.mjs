import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const fixture = String.raw`
using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Collections.Generic;
class Fixture {
  static void Put(ZipArchive zip, string name, string value) {
    using (var w = new StreamWriter(zip.CreateEntry(name).Open(), new UTF8Encoding(false))) w.Write(value);
  }
  static string Hash(string text) {
    using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
  }
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    try {
      if (args[0] == "make") {
        using (var zip = ZipFile.Open(args[1], ZipArchiveMode.Create)) {
          string kind = args[2];
          Put(zip, "app/file.txt", "fixture");
          if (kind == "traversal") Put(zip, "../outside.txt", "escape");
          if (kind == "duplicate") Put(zip, "APP/FILE.TXT", "duplicate");
          if (kind == "reserved") Put(zip, "app/CON.txt", "invalid");
          if (kind == "unlisted") Put(zip, "app/extra.txt", "unlisted");
          if (kind == "symlink") { var e = zip.CreateEntry("app/link"); e.ExternalAttributes = unchecked((int)0xA0000000); }
          if (kind != "missing") {
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes("fixture"))).Replace("-", "").ToLowerInvariant();
            if (kind == "tampered") hash = new string('0', 64);
            Put(zip, "SHA256SUMS.txt", hash + "  app/file.txt\n");
          }
        }
      } else if (args[0] == "makeinstall") {
        using (var zip = ZipFile.Open(args[1], ZipArchiveMode.Create)) {
          var files = new Dictionary<string, string> { {"app/index.mjs", args[2]}, {"runtime/node.exe", args[2]}, {"心语.exe", args[2]}, {"VERSION.json", "{}"}, {"INSTALL-EDITION.txt", "generic\n"} };
          var manifest = new StringBuilder();
          foreach (var item in files) { Put(zip, item.Key, item.Value); manifest.Append(Hash(item.Value)).Append("  ").Append(item.Key).Append('\n'); }
          Put(zip, "SHA256SUMS.txt", manifest.ToString());
        }
      } else if (args[0] == "install") {
        Action<string> progress = args.Length > 5 && args[5] == "fail" ? (Action<string>)(name => { throw new Exception("injected failure"); }) : args.Length > 5 && args[5] == "fail-uninstaller" ? (Action<string>)(name => { if (name == "卸载.exe") throw new Exception("injected failure"); }) : null;
        Console.WriteLine(InstallCore.Install(args[1], args[2], args[3], args[4], progress, args.Length > 6 && args[6] != "-" ? args[6] : null, args.Length > 7 ? args[7] : null));
      } else if (args[0] == "hold") { using (OperationLock.Acquire(args[1])) { Console.WriteLine("locked"); Console.ReadLine(); } }
      else if (args[0] == "lock") { using (OperationLock.Acquire(args[1])) {} }
      else if (args[0] == "import") Migration.CopyFrom(args[1], args[2]);
      else if (args[0] == "uninstall") {
        using (var zip = ZipFile.OpenRead(args[1])) using (var reader = new StreamReader(zip.GetEntry("SHA256SUMS.txt").Open())) {
          string manifest = reader.ReadToEnd();
          var kept = UninstallCore.Remove(args[2], "generic", manifest);
          if (kept.Count == 0) UninstallCore.FinalizeRemoval(args[2], "generic", manifest);
          Console.WriteLine(String.Join(",", kept));
        }
      } else if (args[0] == "zip") ZipFile.CreateFromDirectory(args[1], args[2]);
      else Payload.ExtractVerified(args[1], args[2]);
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
  }
}`;

test("安装负载解压：校验内容并拒绝越界、重名和异常条目", { timeout: 30000, skip: process.platform !== "win32" || !fs.existsSync(csc) }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-install-payload-"));
  try {
    const source = path.join(tmp, "Fixture.cs");
    const exe = path.join(tmp, "fixture.exe");
    fs.writeFileSync(source, fixture);
    const compiled = spawnSync(csc, ["/nologo", "/target:exe", "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll", "/reference:System.Web.Extensions.dll", `/out:${exe}`, source, path.join(repo, "installer", "Payload.cs"), path.join(repo, "installer", "InstallCore.cs"), path.join(repo, "installer", "UninstallCore.cs"), path.join(repo, "installer", "Migration.cs"), path.join(repo, "installer", "OperationLock.cs"), path.join(repo, "installer", "PathGuard.cs")], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    const lockTarget = path.join(tmp, "操作 锁");
    const holder = spawn(exe, ["hold", lockTarget], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = await Promise.race([new Promise((resolve) => holder.stdout.once("data", (data) => resolve(String(data)))), new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
      assert.match(ready, /locked/);
      assert.equal(spawnSync(exe, ["lock", lockTarget]).status, 1);
    } finally {
      holder.stdin.end("\n");
      if (holder.exitCode === null) await new Promise((resolve) => holder.once("exit", resolve));
    }
    assert.equal(spawnSync(exe, ["lock", lockTarget]).status, 0);
    for (const kind of ["ok", "traversal", "duplicate", "reserved", "unlisted", "symlink", "missing", "tampered"]) {
      const zip = path.join(tmp, `${kind}.zip`);
      const dest = path.join(tmp, `unpack-${kind}`);
      assert.equal(spawnSync(exe, ["make", zip, kind]).status, 0, kind);
      const result = spawnSync(exe, ["extract", zip, dest], { encoding: "utf8" });
      assert.equal(result.status, kind === "ok" ? 0 : 1, `${kind}: ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(tmp, "outside.txt")), false);
      if (kind === "ok") assert.equal(fs.readFileSync(path.join(dest, "app", "file.txt"), "utf8"), "fixture");
    }
    const oldZip = path.join(tmp, "old.zip"), nextZip = path.join(tmp, "next.zip"), install = path.join(tmp, "安装 目录"), data = path.join(tmp, "用户数据");
    for (const [zip, version] of [[oldZip, "version-one"], [nextZip, "version-two"]]) {
      assert.equal(spawnSync(exe, ["makeinstall", zip, version]).status, 0);
    }
    fs.mkdirSync(path.join(data, "database"), { recursive: true });
    fs.writeFileSync(path.join(data, "database", "main.db"), "user-db");
    const runInstall = (zip, target, edition = "generic", dataDir = data, extra = []) => spawnSync(exe, ["install", zip, target, edition, dataDir, ...extra], { encoding: "utf8" });
    assert.equal(runInstall(oldZip, install).status, 0);
    fs.writeFileSync(path.join(install, "心语设置.json"), "user-settings");
    fs.mkdirSync(path.join(install, "protocol"));
    fs.writeFileSync(path.join(install, "protocol", "user-state"), "keep");
    const childData = path.join(install, "instances", "child", "data");
    fs.mkdirSync(path.join(childData, "database"), { recursive: true });
    fs.writeFileSync(path.join(childData, "database", "main.db"), "child-db");
    fs.writeFileSync(path.join(install, "instances", "child", "心语设置.json"), JSON.stringify({ dataDir: "data" }));
    fs.writeFileSync(path.join(install, "instances", "child", "心语设置.json"), JSON.stringify({ dataDir: 12 }));
    assert.equal(runInstall(nextZip, install).status, 1, "实例数据目录类型错误时不能升级");
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-one");
    fs.writeFileSync(path.join(install, "instances", "child", "心语设置.json"), JSON.stringify({ dataDir: "data" }));
    for (const lockedData of [data, childData]) {
      const name = `heartecho-${createHash("sha1").update(path.resolve(lockedData).toLowerCase()).digest("hex").slice(0, 12)}.lock`;
      const file = path.join(os.tmpdir(), name);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      try {
        assert.equal(runInstall(nextZip, install).status, 1, "数据目录正在使用时不能升级");
        assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-one");
      } finally { fs.rmSync(file); }
    }
    assert.equal(runInstall(nextZip, install, "generic", data, ["fail"]).status, 1);
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-one");
    const newUninstaller = path.join(tmp, "new-uninstaller.exe");
    fs.writeFileSync(newUninstaller, "new-uninstaller");
    fs.writeFileSync(path.join(install, "卸载.exe"), "old-uninstaller");
    assert.equal(runInstall(nextZip, install, "generic", data, ["fail-uninstaller", newUninstaller]).status, 1);
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-one");
    assert.equal(fs.readFileSync(path.join(install, "卸载.exe"), "utf8"), "old-uninstaller");
    const upgraded = runInstall(nextZip, install);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-two");
    assert.equal(fs.readFileSync(path.join(install, "心语设置.json"), "utf8"), "user-settings");
    assert.equal(fs.readFileSync(path.join(install, "protocol", "user-state"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(upgraded.stdout.trim(), "app", "index.mjs"), "utf8"), "version-one");
    assert.ok(fs.readdirSync(path.join(data, "backups")).length >= 1);
    const childBackups = fs.readdirSync(path.join(childData, "backups"));
    assert.ok(childBackups.length >= 1);
    assert.equal(fs.readFileSync(path.join(childData, "backups", childBackups[0], "main.db"), "utf8"), "child-db");
    assert.equal(fs.readFileSync(path.join(data, "database", "main.db"), "utf8"), "user-db");
    const customHome = path.join(tmp, "独立实例目录");
    const customChild = path.join(customHome, "instances", "custom");
    const registeredChild = path.join(tmp, "登记的外部实例");
    for (const child of [customChild, registeredChild]) {
      fs.mkdirSync(path.join(child, "data", "database"), { recursive: true });
      fs.writeFileSync(path.join(child, "data", "database", "main.db"), child);
    }
    fs.writeFileSync(path.join(customHome, "instances.json"), JSON.stringify({ instances: [{ dir: registeredChild }] }));
    assert.equal(runInstall(oldZip, install, "generic", data, ["ok", "-", customHome]).status, 0);
    for (const child of [customChild, registeredChild]) {
      const backupRoot = path.join(child, "data", "backups");
      const backupNames = fs.readdirSync(backupRoot);
      assert.equal(fs.readFileSync(path.join(backupRoot, backupNames[0], "main.db"), "utf8"), child);
    }
    fs.writeFileSync(path.join(customHome, "instances.json"), "{broken");
    assert.equal(runInstall(nextZip, install, "generic", data, ["ok", "-", customHome]).status, 1, "无法读取登记表时不能升级");
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "version-one");
    fs.writeFileSync(path.join(customHome, "instances.json"), JSON.stringify({ instances: [{ dir: registeredChild }] }));
    assert.equal(runInstall(nextZip, install, "generic", data, ["ok", "-", customHome]).status, 0);
    const unrelated = path.join(tmp, "unrelated");
    fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, "important"), "unchanged");
    assert.equal(runInstall(nextZip, unrelated).status, 1);
    assert.equal(fs.readFileSync(path.join(unrelated, "important"), "utf8"), "unchanged");
    assert.equal(runInstall(nextZip, install, "tb").status, 1);
    assert.equal(runInstall(nextZip, install, "generic", path.join(install, "app", "data")).status, 1);
    assert.equal(runInstall(nextZip, path.join(data, "program"), "generic", data).status, 1);
    assert.equal(runInstall(nextZip, data, "generic", data).status, 1);
    fs.writeFileSync(path.join(install, "app", "index.mjs"), "user-customized");
    const uninstall = spawnSync(exe, ["uninstall", nextZip, install], { encoding: "utf8" });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /app\/index.mjs/);
    assert.equal(fs.readFileSync(path.join(install, "app", "index.mjs"), "utf8"), "user-customized");
    assert.equal(fs.readFileSync(path.join(install, "protocol", "user-state"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(install, "心语设置.json"), "utf8"), "user-settings");
    assert.ok(fs.existsSync(path.join(install, "INSTALL-EDITION.txt")));
    fs.writeFileSync(path.join(install, "app", "index.mjs"), "version-two");
    assert.equal(spawnSync(exe, ["uninstall", nextZip, install]).status, 0);
    assert.equal(fs.existsSync(path.join(install, "INSTALL-EDITION.txt")), false);
    assert.equal(fs.readFileSync(path.join(data, "database", "main.db"), "utf8"), "user-db");
    const legacy = path.join(tmp, "旧数据"), imported = path.join(tmp, "导入数据");
    fs.mkdirSync(path.join(legacy, "characters"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), "synthetic-secret");
    fs.writeFileSync(path.join(legacy, "characters", "role.json"), "character");
    const lockName = `heartecho-${createHash("sha1").update(path.resolve(legacy).toLowerCase()).digest("hex").slice(0, 12)}.lock`;
    const lock = path.join(os.tmpdir(), lockName);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    try { assert.equal(spawnSync(exe, ["import", legacy, imported]).status, 1); }
    finally { fs.rmSync(lock); }
    const junction = path.join(legacy, "external");
    fs.symlinkSync(unrelated, junction, "junction");
    assert.equal(spawnSync(exe, ["import", legacy, imported]).status, 1);
    fs.rmdirSync(junction);
    assert.equal(spawnSync(exe, ["import", legacy, imported]).status, 0);
    assert.equal(fs.readFileSync(path.join(imported, "characters", "role.json"), "utf8"), "character");
    assert.equal(fs.readFileSync(path.join(legacy, "config.json"), "utf8"), "synthetic-secret");
    assert.equal(spawnSync(exe, ["import", legacy, imported]).status, 1, "不能覆盖已有目标数据");
    assert.equal(spawnSync(exe, ["import", legacy, path.join(legacy, "nested")]).status, 1);
    const alias = path.join(tmp, "旧数据别名");
    fs.symlinkSync(legacy, alias, "junction");
    assert.equal(spawnSync(exe, ["import", legacy, path.join(alias, "nested")]).status, 1);
    assert.equal(spawnSync(exe, ["import", alias, path.join(tmp, "alias-copy")]).status, 1);
    assert.equal(runInstall(oldZip, path.join(alias, "program"), "generic", data).status, 1);
    assert.equal(fs.existsSync(path.join(legacy, "nested")), false);
    fs.rmdirSync(alias);
    if (process.env.HEARTECHO_TEST_PAYLOAD) {
      const zip = path.join(tmp, "real.zip");
      const dest = path.join(tmp, "real-unpack");
      const compressed = spawnSync(exe, ["zip", process.env.HEARTECHO_TEST_PAYLOAD, zip], { encoding: "utf8" });
      assert.equal(compressed.status, 0, compressed.stderr);
      const extracted = spawnSync(exe, ["extract", zip, dest], { encoding: "utf8" });
      assert.equal(extracted.status, 0, extracted.stderr);
      assert.ok(fs.existsSync(path.join(dest, "runtime", "node.exe")));
      const installed = path.join(tmp, "真实安装目录");
      const installResult = runInstall(zip, installed);
      assert.equal(installResult.status, 0, installResult.stderr);
      assert.ok(fs.existsSync(path.join(installed, "心语.exe")));
      assert.ok(fs.existsSync(path.join(installed, "runtime", "Node-LICENSE.txt")));
      assert.equal(fs.existsSync(path.join(installed, "protocol")), false);
      const runtime = spawn(path.join(installed, "runtime", "node.exe"), ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(runtime.exitCode, null);
        const blocked = runInstall(zip, installed);
        assert.equal(blocked.status, 1);
        assert.match(blocked.stderr, /仍在运行/);
      } finally {
        if (runtime.exitCode === null) {
          runtime.kill();
          await new Promise((resolve) => runtime.once("exit", resolve));
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
