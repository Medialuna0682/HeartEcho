/**
 * 静态检查：确认每个模块「从别的模块导入的名字」确实存在于对方的导出里。
 *
 * 这类错误（比如 import { memoryBlock } 但 memory.mjs 后来改了名）只有跑到那一行才炸，
 * 而本工具在启动前就能全部列出来——免费的自检。
 *
 *   node tools/check-identifiers.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIB = path.join(ROOT, "lib");
const DIRS = [LIB, path.join(ROOT, "tools"), ROOT];

/** 直接问 Node 每个模块到底导出了什么，避免手工维护清单。 */
async function exportsOf(file) {
  try {
    const mod = await import(`file://${file.replace(/\\/g, "/")}`);
    return new Set(Object.keys(mod));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function scanImports(source) {
  const out = [];
  const pattern = /import\s+\{([^}]+)\}\s+from\s+"(\.[^"]+)"/g;
  let match;
  while ((match = pattern.exec(source))) {
    const names = match[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push({ spec: match[2], names });
  }
  return out;
}

async function main() {
  // 先收集所有 lib 模块的导出（需要能加载：给一个临时数据目录）
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `heartecho-ident-${Date.now().toString(36)}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.HEARTECHO_DATA_DIR ||= tmp;
  process.env.HEARTECHO_LOG_DIR ||= path.join(tmp, "logs");
  process.env.HEARTECHO_LOG_LEVEL ||= "error";

  const exportMap = new Map();
  for (const name of fs.readdirSync(LIB).filter((item) => item.endsWith(".mjs"))) {
    const file = path.join(LIB, name);
    exportMap.set(file, await exportsOf(file));
  }

  let problems = 0;
  let checked = 0;

  for (const dir of DIRS) {
    const files = fs.readdirSync(dir).filter((item) => item.endsWith(".mjs"));
    for (const name of files) {
      const file = path.join(dir, name);
      if (file.includes(`${path.sep}__probe${path.sep}`)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const item of scanImports(source)) {
        const target = path.resolve(dir, item.spec);
        const exports = exportMap.get(target);
        if (!exports || exports.error) continue;
        for (const imported of item.names) {
          checked += 1;
          if (!exports.has(imported)) {
            problems += 1;
            console.log(`  ✗ ${path.relative(ROOT, file)}：从 ${item.spec} 导入的 ${imported} 并不存在`);
          }
        }
      }
    }
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`检查了 ${checked} 个导入名，${problems ? `发现 ${problems} 处问题` : "全部存在"}`);
  process.exitCode = problems ? 1 : 0;
}

main().catch((error) => {
  console.error("检查失败：", error?.stack ?? error);
  process.exitCode = 2;
});
