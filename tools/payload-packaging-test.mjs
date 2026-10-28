import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
test("安装负载只包含清单中的源码，不带本地额外文件", { timeout: 30000, skip: process.platform !== "win32" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-package-test-"));
  const id = randomBytes(8).toString("hex");
  const extras = [path.join(repo, "lib", `local-${id}.txt`), path.join(repo, "extensions", "plugins", "affinity", `local-${id}.txt`)];
  try {
    for (const file of extras) fs.writeFileSync(file, "SYNTHETIC-DO-NOT-PACKAGE", { flag: "wx" });
    const license = path.join(tmp, "license.txt");
    fs.writeFileSync(license, "Node.js synthetic license for test only");
    const output = path.join(tmp, "payload");
    const result = spawnSync(process.execPath, [path.join(repo, "tools", "build-payload.mjs"), "--edition", "generic", "--output", output], {
      cwd: repo, env: { ...process.env, HEARTECHO_NODE_LICENSE: license }, encoding: "utf8", timeout: 25000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of extras) assert.equal(fs.existsSync(path.join(output, "app", path.relative(repo, file))), false);
    assert.ok(fs.existsSync(path.join(output, "app", "lib", "version.mjs")));
    assert.ok(fs.existsSync(path.join(output, "app", "lib", "edition-safety.mjs")));
    assert.ok(fs.existsSync(path.join(output, "app", "tools", "selftest.mjs")));
    const credits = fs.readFileSync(path.join(output, "app", "EXTENSION-AUTHORS.txt"), "utf8");
    const manifests = JSON.parse(fs.readFileSync(path.join(repo, "tools", "payload-source-files.json"), "utf8"))
      .filter((name) => /^extensions\/(plugins|skills)\/[^/]+\/(plugin|skill)\.json$/.test(name));
    assert.equal(manifests.length, 16);
    for (const name of manifests) assert.ok(credits.includes(`（${name}）`), name);
    assert.match(credits, /作者未标注/);
    assert.match(credits, /分发前须逐项确认授权/);
    assert.equal(fs.existsSync(path.join(output, "protocol")), false);
  } finally {
    for (const file of extras) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
