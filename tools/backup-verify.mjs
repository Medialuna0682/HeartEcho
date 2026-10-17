/**
 * 验证备份是真的完整：备份 → 修改数据 → 从备份恢复 → 检查数据在不在。
 * 这是「备份看起来成功、恢复少一截」那类坑的唯一有效检验。
 *
 *   node tools/backup-verify.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = path.join(os.tmpdir(), `heartecho-backup-${Date.now().toString(36)}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.HEARTECHO_DATA_DIR = TMP;
process.env.HEARTECHO_LOG_DIR = path.join(TMP, "logs");
process.env.HEARTECHO_LOG_LEVEL = "error";

const { ensureDirs, paths } = await import("../lib/paths.mjs");
ensureDirs();
const db = await import("../lib/db.mjs");
const storage = await import("../lib/storage.mjs");
db.getDb();

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  · ${detail}` : ""}`);
};

// 1) 写入一批数据
const PEER = "10000002"; // 合成号码，不带真实账号
const scopeKey = `private_${PEER}`;
storage.ensureSession(scopeKey, { characterId: "test" });
for (let i = 0; i < 50; i += 1) {
  storage.insertMessage({ eventKey: `m-${i}`, scopeKey, direction: "in", senderId: PEER, at: Date.now() + i, body: `备份测试消息 ${i}` });
}
const before = storage.messageCount(scopeKey);
check("写入 50 条消息", before === 50, `实际 ${before} 条`);

// 2) 备份
const result = db.backup("verify");
check("备份成功", result.ok, result.file ? `${path.basename(result.file)}（${(result.size / 1024).toFixed(0)} KB）` : result.error);
const stray = fs.readdirSync(paths.backups).filter((name) => /-(wal|shm)$/.test(name));
check("备份是自包含的（不依赖 -wal 伴随文件）", stray.length === 0, stray.length ? `多出 ${stray.join(",")}` : `backups 目录只有 .db：${fs.readdirSync(paths.backups).join(",")}`);

// 3) 备份后继续写，模拟"备份之后又有新数据"
for (let i = 50; i < 80; i += 1) {
  storage.insertMessage({ eventKey: `m-${i}`, scopeKey, direction: "in", senderId: PEER, at: Date.now() + i, body: `备份之后才写的 ${i}` });
}
check("备份后继续写入", storage.messageCount(scopeKey) === 80);

// 4) 从备份恢复：把备份文件当成主库打开（VACUUM INTO 的产物本身就是独立库）
db.closeDb();
const restoreDir = path.join(TMP, "restore");
fs.mkdirSync(restoreDir, { recursive: true });
const restored = path.join(restoreDir, "main.db");
fs.copyFileSync(result.file, restored);

const { DatabaseSync } = await import("node:sqlite");
const checkDb = new DatabaseSync(restored);
const count = checkDb.prepare("select count(*) as n from messages where scope_key = ?").get(scopeKey).n;
const bodies = checkDb.prepare("select body from messages where scope_key = ? order by id").all(scopeKey).map((r) => r.body);
check("从备份恢复后数据完整", count === 50, `恢复出 ${count} 条（期望 50）`);
check("恢复的数据内容正确", bodies[0] === "备份测试消息 0" && bodies[49] === "备份测试消息 49");
const hasLater = bodies.some((b) => b.includes("备份之后才写的"));
check("备份里不含备份之后的数据", !hasLater, "时间点切分正确");
const integrity = checkDb.prepare("pragma integrity_check").get();
check("备份文件本身完整", integrity.integrity_check === "ok", integrity.integrity_check);
checkDb.close();

// 5) 备份轮转：只保留最近 10 份
for (let i = 0; i < 13; i += 1) {
  db.getDb();
  db.backup(`rotate-${i}`);
}
const files = fs.readdirSync(paths.backups).filter((name) => name.endsWith(".db"));
check("旧备份会自动清理", files.length <= 10, `当前保留 ${files.length} 份`);

db.closeDb();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n备份验证失败 ${failed} 项` : "\n备份验证全部通过");
process.exitCode = failed ? 1 : 0;
