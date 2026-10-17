/**
 * 冒烟测试：把所有模块都加载一遍并实例化核心对象，确认没有「用了但没导入」这类低级错误。
 * 这类错误跑起来才炸，所以放进自检里。
 *
 *   node tools/smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = path.join(os.tmpdir(), `heartecho-smoke-${Date.now().toString(36)}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.HEARTECHO_DATA_DIR = TMP;
process.env.HEARTECHO_LOG_DIR = path.join(TMP, "logs");
process.env.HEARTECHO_LOG_LEVEL = "error";

const MODULES = [
  "paths",
  "log",
  "providers",
  "config",
  "db",
  "util",
  "budget",
  "llm",
  "onebot",
  "storage",
  "policy",
  "memory",
  "life",
  "chat",
  "scheduler",
  "qzone",
  "qzone-job",
  "health",
  "ui",
  "ui-css",
  "ui-icons",
  "ui-icons-client",
  "ui-app",
  "api",
];

let failed = 0;

async function main() {
  console.log("=== 模块冒烟测试 ===");
  const loaded = {};
  for (const name of MODULES) {
    try {
      loaded[name] = await import(`../lib/${name}.mjs`);
      console.log(`  ✓ lib/${name}.mjs`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ lib/${name}.mjs —— ${error?.message ?? error}`);
    }
  }

  console.log("\n=== 核心对象实例化 ===");
  const { ensureDirs } = loaded.paths;
  ensureDirs();
  const calls = [
    ["OneBot 客户端", () => new loaded.onebot.OneBot({ url: "ws://127.0.0.1:1", accessToken: "", httpUrl: "", selfId: 1 })],
    ["预算闸门", () => new loaded.budget.BudgetGate()],
    ["LLM 网关", () => new loaded.llm.LlmGateway({ budgetGate: new loaded.budget.BudgetGate() })],
    ["对话引擎", () => {
      const client = new loaded.onebot.OneBot({ url: "ws://127.0.0.1:1", accessToken: "", httpUrl: "", selfId: 1 });
      const llm = new loaded.llm.LlmGateway({});
      return new loaded.chat.ChatEngine({ client, llm });
    }],
    ["调度中心", () => new loaded.scheduler.Scheduler({ client: { sendPrivateMsg: async () => ({}) }, llm: {}, life: {} })],
    ["空间适配器", () => new loaded.qzone.QZoneAdapter({ client: { call: async () => ({}) }, llm: {} })],
    ["空间任务", () => new loaded["qzone-job"].QZoneScheduler({ qzone: { snapshot: () => ({}) }, llm: {} })],
    ["控制面板前端", () => {
      const html = loaded.ui.ui();
      if (html.length < 10000) throw new Error("面板 HTML 太短，可能拼接失败");
      return html;
    }],
  ];

  const instances = {};
  for (const [label, factory] of calls) {
    try {
      instances[label] = factory();
      console.log(`  ✓ ${label}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${label} —— ${error?.message ?? error}`);
    }
  }

  console.log("\n=== 关键方法自检（调一遍最容易漏 import 的方法） ===");
  const checks = [
    ["chat.snapshot()", () => {
      const engine = new loaded.chat.ChatEngine({
        client: { selfId: 1, status: {}, queue: [] },
        llm: new loaded.llm.LlmGateway({}),
      });
      const snap = engine.snapshot();
      if (!snap || typeof snap.merging !== "number") throw new Error("snapshot 返回异常");
      return `busy=${snap.busy.length} merging=${snap.merging}`;
    }],
    ["budget.snapshot()", () => JSON.stringify(loaded.budget.checkBudget()).length + " 字节"] ,
    ["policy.gate()", () => {
      const r = loaded.policy.gate({ kind: "private", groupId: "", senderId: "1", text: "hi", isMention: false, messageId: "m", scopeKey: "private_1" }, { characterId: "x" });
      return `action=${r.action}`;
    }],
    ["qzone.listCapabilities()", () => loaded.qzone.listCapabilities().length + " 项能力"],
    ["health.protocolStatus()", () => JSON.stringify(loaded.health.protocolStatus()).length + " 字节"],
    ["ui 客户端脚本语法", async () => {
      const html = loaded.ui.ui();
      const start = html.indexOf("<script>") + 8;
      const end = html.indexOf("</script>", start);
      const script = html.slice(start, end);
      const file = path.join(TMP, "client.js");
      fs.writeFileSync(file, script, "utf8");
      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      } catch (error) {
        throw new Error("前端脚本语法检查失败：" + String(error.stderr ?? error.message).split("\n").slice(0, 4).join(" "));
      }
      return `${script.length} 字节，语法正确`;
    }],
  ];

  for (const [label, fn] of checks) {
    try {
      const detail = await fn();
      console.log(`  ✓ ${label} —— ${detail}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${label} —— ${error?.message ?? error}`);
    }
  }

  try {
    loaded.db.closeDb();
  } catch {
    /* ignore */
  }
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(failed ? `\n冒烟测试失败 ${failed} 项` : "\n冒烟测试全部通过");
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error("冒烟测试崩了：", error?.stack ?? error);
  process.exitCode = 2;
});
