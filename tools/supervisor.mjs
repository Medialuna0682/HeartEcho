/**
 * 开发/测试用监督进程：`node --exit` 之外还负责在退出码 42（面板点了重启）或崩溃后自动拉起。
 * 生产用法是双击「启动心语.bat」；这个文件是给命令行/自动化测试用的等价物。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = path.join(ROOT, "index.mjs");
const args = process.argv.slice(2);

let stopping = false;

function run() {
  const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, stdio: "inherit" });
  console.log(`[监督] 心语已启动，pid=${child.pid}`);
  child.on("exit", (code) => {
    if (stopping) {
      console.log(`[监督] 已停止（退出码 ${code}）`);
      process.exit(code ?? 0);
    }
    if (code === 0) {
      console.log("[监督] 正常退出");
      process.exit(0);
    }
    const delay = code === 42 ? 1500 : 5000;
    console.log(`[监督] 退出码 ${code}，${delay / 1000} 秒后重新拉起`);
    setTimeout(run, delay);
  });
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

run();
