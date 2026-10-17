/**
 * 单文件 exe 的「干净机器」验收。
 *
 * 安全设计：**不会碰你的真实数据目录**。
 *   默认路径解析用 --probe + 临时 HEARTECHO_APP_DIR 验证；
 *   完整实例跑在一个隔离的沙箱数据目录里（HEARTECHO_DATA_DIR 指向临时目录）。
 *
 * 检查项：
 *   ① exe 能独立启动（目标机器不需要装 Node）
 *   ② 默认数据目录落在 %LOCALAPPDATA%\心语（Windows 单机软件习惯）
 *   ③ 首次运行会自动建好目录结构与默认配置
 *   ④ 能读到角色卡、能连协议端、能起控制面板、能真的调 QQ 接口
 *
 *   node tools/exe-verify.mjs
 *   node tools/exe-verify.mjs --keep    保留沙箱目录（排查用）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXE = path.join(ROOT, "dist", "心语.exe");
const SANDBOX = path.join(os.tmpdir(), `heartecho-exe-sandbox-${Date.now().toString(36)}`);
const TEST_PORT = 5399;
const KEEP = process.argv.includes("--keep");

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail: String(detail ?? "") });
  console.log(`${ok ? "✓" : "✗"} ${id} ${name}${detail ? `  · ${detail}` : ""}`);
};

/** 跑一次 exe，返回输出。 */
function runExe(args, { cwd, env, timeout = 90000 } = {}) {
  const result = spawnSync(EXE, args, { cwd: cwd ?? SANDBOX, encoding: "utf8", timeout, env: { ...process.env, ...(env ?? {}) } });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function main() {
  console.log("=== 单文件 exe 验收（隔离沙箱，不动真实数据） ===");
  if (!fs.existsSync(EXE)) {
    console.log(`找不到 ${EXE}，先跑 node tools/build-exe.mjs`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(SANDBOX, { recursive: true });
  const sizeMb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(0);
  check("EXE-01", "exe 文件存在", true, `${path.basename(EXE)}（${sizeMb} MB，单文件）`);

  /* ② 默认数据目录：把「程序目录」指到一个空目录，看它把数据放到哪 */
  const fakeAppDir = path.join(SANDBOX, "程序目录");
  fs.mkdirSync(fakeAppDir, { recursive: true });
  const defaultOut = runExe(["--probe"], { cwd: fakeAppDir, env: { HEARTECHO_APP_DIR: fakeAppDir } });
  const expectData = path.join(process.env.LOCALAPPDATA || os.homedir(), "心语");
  const dataLine = defaultOut.split(/\r?\n/).find((l) => l.includes("数据目录：")) ?? "";
  check(
    "EXE-02",
    "exe 能独立启动（目标机器无需装 Node）",
    /心语自检/.test(defaultOut),
    defaultOut.split(/\r?\n/).find((l) => l.includes("角色：")) ?? "自检输出没出来",
  );
  check(
    "EXE-03",
    "默认数据目录落在 %LOCALAPPDATA%\\心语",
    dataLine.includes(expectData),
    dataLine.replace("数据目录：", "").trim() || "（没解析出路径）",
  );

  /* ③ 首次运行自建目录与配置（用沙箱数据目录，不碰真实数据） */
  const sandboxData = path.join(SANDBOX, "data");
  const firstOut = runExe(["--probe"], { env: { HEARTECHO_DATA_DIR: sandboxData } });
  check("EXE-04", "首次运行自动建好目录结构", ["characters", "database", "logs", "backups"].every((d) => fs.existsSync(path.join(sandboxData, d))), fs.readdirSync(sandboxData).join(",") || "（空）");
  check("EXE-05", "自动生成默认配置文件", fs.existsSync(path.join(sandboxData, "config.json")), "");

  /* ④ 拿真实角色卡与配置，在沙箱里起一个完整实例
        （不写死任何角色名：用 data/characters 里的第一张卡，仓库里默认没有卡时就跳过这一段） */
  const cardsDir = path.join(ROOT, "data", "characters");
  const cards = fs.existsSync(cardsDir) ? fs.readdirSync(cardsDir).filter((name) => name.endsWith(".json")) : [];
  if (!cards.length) {
    console.log("\n（data/characters 里没有角色卡，跳过「读角色卡」相关的验收项——这是正常的：仓库不带角色卡）");
    return summary();
  }
  const realCard = path.join(cardsDir, cards[0]);
  const cardName = JSON.parse(fs.readFileSync(realCard, "utf8").replace(/^\uFEFF/, "")).name || "";
  fs.copyFileSync(realCard, path.join(sandboxData, "characters", cards[0]));

  const realConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "config.json"), "utf8"));
  realConfig.bot.panelPort = TEST_PORT;
  realConfig.bot.selfId = Number(realConfig.bot.selfId);
  realConfig.activeCharacter = path.basename(cards[0], ".json");
  fs.writeFileSync(path.join(sandboxData, "config.json"), JSON.stringify(realConfig, null, 2), "utf8");

  // 沙箱里的"程序目录"放一份设置文件，告诉它协议端在哪
  const settingsFile = path.join(fakeAppDir, "心语设置.json");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ dataDir: "", logDir: "", snowlumaDir: path.dirname(ROOT), autoStartProtocol: false, openPanelOnStart: false, closeWindowTo: "ask" }, null, 2),
    "utf8",
  );

  const child = spawn(EXE, ["--no-panel", "--no-tray"], {
    cwd: fakeAppDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HEARTECHO_APP_DIR: fakeAppDir, HEARTECHO_DATA_DIR: sandboxData, HEARTECHO_SETTINGS: settingsFile },
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    log += String(chunk);
  });

  let up = false;
  for (let i = 0; i < 45; i += 1) {
    await sleep(1000);
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  check("EXE-06", "exe 起的完整实例提供了控制面板", up, up ? `http://127.0.0.1:${TEST_PORT}` : log.slice(-500));

  if (up) {
    const status = await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`)).json();
    check("EXE-07", "exe 读到了角色卡", Boolean(cardName) && status.character?.name === cardName, status.character?.name ?? "（没读到）");
    check("EXE-08", "exe 连上了 QQ 协议端", Boolean(status.onebot?.online), status.onebot?.online ? `${status.onebot.nickname}（${status.onebot.selfId}）` : status.onebot?.lastError ?? "");
    const html = await (await fetch(`http://127.0.0.1:${TEST_PORT}/`)).text();
    check("EXE-09", "控制面板完整（前端内联在 exe 里）", html.includes("心语 · HeartEcho") && html.length > 50000, `${(html.length / 1024).toFixed(0)} KB`);

    const sandboxPanel = await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/chat/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    })).json();
    check("EXE-10", "exe 实例能真的调用模型并生成回复", Array.isArray(sandboxPanel.bubbles) && sandboxPanel.bubbles.length > 0, (sandboxPanel.bubbles ?? []).join(" / ").slice(0, 90) || sandboxPanel.message || "");

    const getInfo = await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/onebot/ping`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    check("EXE-11", "exe 实例能调用 QQ 接口", Boolean(getInfo.ok), getInfo.ok ? `get_login_info：${getInfo.info?.nickname}` : String(getInfo.error ?? ""));
  }

  child.kill();
  await sleep(1200);
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }

  if (KEEP) console.log(`\n沙箱目录保留在：${SANDBOX}`);
  else fs.rmSync(SANDBOX, { recursive: true, force: true });

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(58));
  console.log(`单文件 exe 验收：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log("未通过：");
    for (const item of failed) console.log(`  ${item.id} ${item.name} —— ${item.detail}`);
  }
  console.log("═".repeat(58));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error("验收崩了：", error?.stack ?? error);
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});
