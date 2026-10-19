/**
 * 逐个页面检查控制面板：导航到每个页面，等渲染完成，检查有没有报错、有没有内容。
 * 这是「没有可视化浏览器」时验证前端最靠谱的办法。
 *
 * 用法：node tools/check-pages.mjs [baseUrl] [截图目录]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:5311";
const SHOT_DIR = process.argv[3] || "";
const PORT = 9600 + Math.floor(Math.random() * 300);

const BINARIES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const binary = BINARIES.find((item) => fs.existsSync(item));
if (!binary) {
  console.error("找不到浏览器");
  process.exit(2);
}

const PAGES = ["overview", "account", "dialog", "weather", "studio", "chat", "groups", "memory", "life", "schedule", "qzone", "llm", "system", "logs"];
const profile = path.join(os.tmpdir(), `heartecho-pages-${Date.now().toString(36)}`);
const child = spawn(
  binary,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1440,980", "about:blank"],
  { stdio: "ignore", windowsHide: true },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!(await devtoolsReady())) throw new Error("DevTools 端口没起来");
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((item) => item.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result);
      return;
    }
    if (payload.method === "Runtime.consoleAPICalled") {
      logs.push({ type: payload.params.type, text: (payload.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ") });
    }
    if (payload.method === "Runtime.exceptionThrown") {
      logs.push({ type: "exception", text: payload.params.exceptionDetails.exception?.description ?? payload.params.exceptionDetails.text });
    }
  });
  const send = (method, params = {}) => {
    seq += 1;
    return new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
      setTimeout(() => {
        if (pending.has(seq)) {
          pending.delete(seq);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  };
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate 失败");
    return result.result?.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  const launch = new URL(BASE);
  if (process.env.HEARTECHO_PANEL_TOKEN) launch.hash = `panelToken=${process.env.HEARTECHO_PANEL_TOKEN}`;
  await send("Page.navigate", { url: launch.href });
  await sleep(5000);

  const rows = [];
  for (const page of PAGES) {
    const before = logs.length;
    await evaluate(`location.hash = "#${page}"; 1`);
    await sleep(2600);
    const info = await evaluate(`(() => {
      const content = document.getElementById("content");
      const fatal = document.getElementById("fatal");
      const notices = content.querySelectorAll(".notice").length;
      const dangerNotice = Array.from(content.querySelectorAll(".notice")).some((n) => n.className.includes("danger"));
      const empty = content.querySelectorAll(".empty").length;
      return {
        title: document.getElementById("pageTitle").textContent,
        chars: content.innerText.replace(/\\s+/g, " ").trim().length,
        cards: content.querySelectorAll(".card").length,
        tables: content.querySelectorAll("table").length,
        inputs: content.querySelectorAll("input,textarea,select").length,
        buttons: content.querySelectorAll("button").length,
        notices, empty,
        fatal: fatal && !fatal.classList.contains("hidden") ? fatal.innerText.slice(0, 400) : "",
        dangerNotice,
        text: content.innerText.replace(/\\s+/g, " ").trim().slice(0, 120),
      };
    })()`);
    const newLogs = logs.slice(before).filter((item) => item.type === "error" || item.type === "exception");
    rows.push({ page, ...info, errors: newLogs.map((item) => item.text.slice(0, 200)) });

    if (SHOT_DIR) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOT_DIR, `page-${page}.png`), Buffer.from(shot.data, "base64"));
    }
  }

  console.log("页面检查：");
  let bad = 0;
  for (const row of rows) {
    const ok = !row.fatal && row.errors.length === 0 && row.chars > 40;
    if (!ok) bad += 1;
    console.log(`${ok ? "✓" : "✗"} ${row.page.padEnd(9)} 标题=${row.title} 文字=${row.chars} 卡片=${row.cards} 表=${row.tables} 控件=${row.inputs + row.buttons} 空态=${row.empty}`);
    if (row.text) console.log(`    ${row.text}`);
    if (row.fatal) console.log(`    !! 前端错误：${row.fatal}`);
    for (const error of row.errors) console.log(`    !! 控制台：${error}`);
  }
  console.log(`\n${rows.length - bad}/${rows.length} 个页面正常`);

  ws.close();
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((error) => {
  console.error("检查失败：", error?.stack ?? error);
  child.kill();
  process.exitCode = 2;
});
