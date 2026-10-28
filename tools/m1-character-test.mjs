import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-m1-"));
process.env.HEARTECHO_APP_DIR = tmp;
process.env.HEARTECHO_DATA_DIR = path.join(tmp, "data");
const { ensureDirs, paths } = await import("../lib/paths.mjs");
const { newCharacterId, saveCharacter, loadCharacter, listCharacters, cloneCharacter } = await import("../lib/config.mjs");
ensureDirs();
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("创建角色不会覆盖大小写不同的已有角色", () => {
  saveCharacter("Alice", { name: "原角色", persona: "保留" }, { create: true });
  assert.equal(newCharacterId("alice"), "alice2");
  assert.throws(() => saveCharacter("alice", { name: "覆盖" }, { create: true }), /没有被覆盖/);
  assert.equal(loadCharacter("Alice").persona, "保留");
  const id = newCharacterId("alice");
  saveCharacter(id, { name: "新角色" }, { create: true });
  assert.ok(listCharacters().includes(id));
  assert.equal(cloneCharacter("Alice", "ALICE").id.toLowerCase(), "alice3");
});

test("空名、保留名和真实目录中的大小写扩展名", () => {
  assert.equal(newCharacterId("..."), "character");
  assert.equal(newCharacterId("CON"), "CON_");
  assert.equal(newCharacterId("lpt1"), "lpt1_");
  fs.writeFileSync(path.join(paths.characters, "Case.JSON"), "{}");
  assert.equal(newCharacterId("case"), "case2");
  assert.throws(() => saveCharacter("case", {}, { create: true }), /没有被覆盖/);
});

test("损坏的角色文件和被删除角色不会被保存操作覆盖或重建", () => {
  const broken = path.join(paths.characters, "broken.json");
  fs.writeFileSync(broken, "{invalid-json");
  assert.throws(() => saveCharacter("broken", { name: "新名字" }), /原文件未修改/);
  assert.equal(fs.readFileSync(broken, "utf8"), "{invalid-json");
  assert.throws(() => saveCharacter("gone", { name: "新名字" }, { requireExisting: true }), /已被删除/);
  assert.equal(fs.existsSync(path.join(paths.characters, "gone.json")), false);
});
