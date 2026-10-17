/**
 * 给指定页面截图（写文档/自查用）。
 *   node tools/shoot.mjs <输出目录> [页面1 页面2 ...]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = process.argv[2] || path.join(os.tmpdir(), "heartecho-shots");
const PAGES = process.argv.slice(3).length ? process.argv.slice(3) : ["overview", "studio", "memory", "life", "llm", "qzone"];
const BASE = process.env.HEARTECHO_PANEL || "http://127.0.0.1:5311";
const PORT = 9700 + Math.floor(Math.random() * 200);

const binary = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((item) => fs.existsSync(item));
if (!binary) {
  console.error("找不到浏览器");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(os.tmpdir(), `heartecho-shoot-${Date.now().toString(36)}`);
const child = spawn(binary, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1440,980", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result);
    }
  });
  const send = (method, params = {}) => {
    seq += 1;
    return new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
      setTimeout(() => reject(new Error("timeout " + method)), 30000);
    });
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(4500);

  for (const page of PAGES) {
    await send("Runtime.evaluate", { expression: `location.hash="#${page}";1`, returnByValue: true });
    await sleep(2800);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${page}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`已截图 ${file}`);
  }

  ws.close();
  child.kill();
  await sleep(200);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
