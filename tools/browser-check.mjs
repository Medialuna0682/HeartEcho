/**
 * 用 CDP 驱动无头浏览器：打开面板、收集控制台错误、跑一段 JS、截图。
 * 用途是「在没有可视化浏览器的环境里验证前端真的能跑起来」。
 *
 * 用法：
 *   node tools/browser-check.mjs [url] [输出图] [要执行的表达式]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:5311/";
const SHOT = process.argv[3] || path.join(os.tmpdir(), "heartecho-panel.png");
const EXPR = process.argv[4] || "1";
const PORT = 9333 + Math.floor(Math.random() * 200);

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const binary = EDGE_CANDIDATES.find((item) => fs.existsSync(item));
if (!binary) {
  console.error("找不到 Edge/Chrome，无法做浏览器检查");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `heartecho-cdp-${Date.now().toString(36)}`);
const child = spawn(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    "--window-size=1440,980",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("等待 DevTools 端口超时");
}

function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  const listeners = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (event) => reject(new Error(String(event?.message ?? "ws error"))));
  });
  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result);
      return;
    }
    events.push(payload);
    for (const listener of listeners) listener(payload);
  });
  return {
    ready,
    events,
    on: (fn) => listeners.push(fn),
    send(method, params = {}) {
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 超时：${method}`));
          }
        }, 30000);
      });
    },
    close: () => ws.close(),
  };
}

async function main() {
  const version = await waitForDevtools();
  console.log(`浏览器：${version.Browser}`);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((item) => item.type === "page");
  const client = createClient(page.webSocketDebuggerUrl);
  await client.ready;

  const logs = [];
  client.on((payload) => {
    if (payload.method === "Runtime.consoleAPICalled") {
      const text = (payload.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
      logs.push({ type: payload.params.type, text });
    }
    if (payload.method === "Runtime.exceptionThrown") {
      const d = payload.params.exceptionDetails;
      logs.push({ type: "exception", text: d.exception?.description ?? d.text });
    }
    if (payload.method === "Log.entryAdded") {
      logs.push({ type: payload.params.entry.level, text: payload.params.entry.text });
    }
  });

  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await client.send("Page.navigate", { url: URL_ });
  await sleep(6000);

  const evaluate = async (expression) => {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value;
  };

  const probe = await evaluate(`(() => {
    const side = document.getElementById("sidebar");
    const content = document.getElementById("content");
    const fatal = document.getElementById("fatal");
    return {
      readyState: document.readyState,
      bootFlag: document.documentElement.getAttribute("data-heartecho"),
      navItems: side ? side.querySelectorAll(".nav-item").length : -1,
      sidebarText: side ? side.innerText.slice(0, 120) : "",
      cards: content ? content.querySelectorAll(".card").length : -1,
      stats: content ? content.querySelectorAll(".stat").length : -1,
      contentText: content ? content.innerText.slice(0, 400) : "",
      fatal: fatal && !fatal.classList.contains("hidden") ? fatal.innerText.slice(0, 800) : "",
      title: document.getElementById("pageTitle") ? document.getElementById("pageTitle").textContent : "",
      svgCount: document.querySelectorAll("svg").length,
    };
  })()`);

  console.log("检查结果：");
  console.log(JSON.stringify(probe, null, 2));

  const extra = await evaluate(EXPR);
  if (extra !== undefined && extra !== 1) console.log("表达式结果：", JSON.stringify(extra, null, 2));

  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`截图：${SHOT}`);

  const errors = logs.filter((item) => item.type === "error" || item.type === "exception");
  console.log(`控制台消息 ${logs.length} 条，其中错误 ${errors.length} 条`);
  for (const item of errors.slice(0, 12)) console.log(`  [${item.type}] ${String(item.text).slice(0, 400)}`);
  if (!errors.length) {
    for (const item of logs.slice(0, 8)) console.log(`  [${item.type}] ${String(item.text).slice(0, 200)}`);
  }

  client.close();
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = errors.length ? 1 : 0;
}

main().catch((error) => {
  console.error("浏览器检查失败：", error?.stack ?? error);
  child.kill();
  process.exitCode = 2;
});
