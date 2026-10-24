/**
 * 扩展包测试 runner。
 *
 *   node tools/extensions-test.mjs                # 跑所有带 test.mjs 的扩展
 *   node tools/extensions-test.mjs --only ledger  # 只跑一个（按包名）
 *   node tools/extensions-test.mjs --list         # 列出有哪些测试
 *
 * 每个 test.mjs 导出 cases：
 *   export const cases = [{ name: "...", run: async (t) => { t.eq(a, b); ... } }];
 * t 提供：ok / eq / deepEq / contains / notContains / throws / sleep / tempDir / path / fs
 *
 * 隔离：每个扩展包在**独立子进程**里跑（数据目录也是独立的临时目录）。
 * 为什么必须这样：扩展包在模块求值阶段就会把 DATA_DIR / 兼容层常量固定下来，
 * 同一个进程里跑第二个包时拿到的是第一个包绑定的目录，状态会互相污染。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXT_ROOT = path.join(ROOT, "extensions");
const only = valueOf("--only");
const listOnly = process.argv.includes("--list");
const childMode = process.argv.includes("--child");

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function findTests() {
  const out = [];
  for (const kind of ["plugins", "skills"]) {
    const kindDir = path.join(EXT_ROOT, kind);
    if (!fs.existsSync(kindDir)) continue;
    for (const name of fs.readdirSync(kindDir).sort()) {
      const dir = path.join(kindDir, name);
      const file = path.join(dir, "test.mjs");
      if (fs.existsSync(file)) out.push({ id: name, kind, file });
    }
  }
  return out;
}

function makeT(id, index) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `he-ext-${id}-`));
  const t = {
    id,
    dir,
    path,
    fs,
    tempDir: (prefix = "tmp-") => fs.mkdtempSync(path.join(dir, prefix)),
    ok(value, message = "应为真") {
      if (!value) throw new Error(`${message}（实际：${format(value)}）`);
    },
    eq(actual, expected, message = "") {
      if (!Object.is(actual, expected)) throw new Error(`${message || "值不相等"}：期望 ${format(expected)}，实际 ${format(actual)}`);
    },
    deepEq(actual, expected, message = "") {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`${message || "结构不相等"}：期望 ${b}，实际 ${a}`);
    },
    contains(haystack, needle, message = "") {
      const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
      if (!String(text).includes(needle)) throw new Error(`${message || "应包含"}「${needle}」：实际 ${text.slice(0, 400)}`);
    },
    notContains(haystack, needle, message = "") {
      const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
      if (String(text).includes(needle)) throw new Error(`${message || "不应包含"}「${needle}」`);
    },
    throws(fn, message = "") {
      try {
        const value = fn();
        if (value && typeof value.then === "function") throw new Error("返回了 Promise，请用 throwsAsync");
      } catch (error) {
        return error;
      }
      throw new Error(`${message || "应当抛错，但没有抛"}`);
    },
    async throwsAsync(fn, message = "") {
      try {
        await fn();
      } catch (error) {
        return error;
      }
      throw new Error(`${message || "应当抛错，但没有抛"}`);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    index,
  };
  return { t, dir };
}

function format(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}

async function runSingle(item) {
  let mod;
  try {
    mod = await import(`${pathToFileURL(item.file).href}?t=${Date.now()}`);
  } catch (error) {
    console.log(`__SUMMARY__ ${JSON.stringify({ pass: 0, fail: 1, cases: [{ name: "加载 test.mjs", error: String(error?.stack ?? error) }] })}`);
    return;
  }
  const cases = Array.isArray(mod.cases) ? mod.cases : [];
  if (!cases.length) {
    console.log(`- ${item.id}: test.mjs 没有导出 cases（跳过）`);
    console.log(`__SUMMARY__ ${JSON.stringify({ pass: 0, fail: 0, cases: [] })}`);
    return;
  }
  let pass = 0;
  const failed = [];
  for (const [index, itemCase] of cases.entries()) {
    const { t, dir } = makeT(item.id, index);
    const started = Date.now();
    try {
      await itemCase.run(t);
      pass += 1;
      console.log(`  ✓ ${item.id} · ${itemCase.name}（${Date.now() - started}ms）`);
    } catch (error) {
      failed.push({ name: itemCase.name, error: String(error?.stack ?? error) });
      console.log(`  ✗ ${item.id} · ${itemCase.name}`);
      console.log(`      ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n      ")}`);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`__SUMMARY__ ${JSON.stringify({ pass, fail: failed.length, cases: failed })}`);
}

function runIsolated(item, runRoot) {
  const dataDir = path.join(runRoot, item.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--only", item.id, "--child"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      HEARTECHO_DATA_DIR: dataDir,
      HEARTECHO_LOG_DIR: path.join(dataDir, "logs"),
      HEARTECHO_LOG_LEVEL: "warn",
      // 别让扩展测试碰到真实的协议端/多实例目录
      HEARTECHO_INSTANCES_HOME: path.join(runRoot, "app"),
      HEARTECHO_CLAIM_DIR: path.join(runRoot, "claims"),
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summaryLine = output.split(/\r?\n/).find((line) => line.startsWith("__SUMMARY__ "));
  let summary = { pass: 0, fail: 1, cases: [{ name: "子进程", error: output.slice(-1500) }] };
  if (summaryLine) {
    try {
      summary = JSON.parse(summaryLine.slice("__SUMMARY__ ".length));
    } catch {
      /* 保留兜底 */
    }
  }
  const body = output
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("__SUMMARY__ "))
    .join("\n");
  if (body) console.log(body);
  if (result.error) console.log(`      ${String(result.error.message ?? result.error)}`);
  return summary;
}

async function main() {
  const tests = findTests();
  if (listOnly) {
    for (const item of tests) console.log(`${item.kind}/${item.id}`);
    if (!tests.length) console.log("（没有 test.mjs）");
    return;
  }
  const picked = only ? tests.filter((item) => item.id === only) : tests;
  if (!picked.length) {
    console.log(only ? `没找到扩展「${only}」的测试（或包不存在）` : "（没有可跑的扩展测试）");
    process.exitCode = only ? 1 : 0;
    return;
  }
  if (childMode) {
    await runSingle(picked[0]);
    return;
  }
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "he-ext-run-"));
  let pass = 0;
  const failures = [];
  try {
    for (const item of picked) {
      const summary = runIsolated(item, runRoot);
      pass += Number(summary.pass) || 0;
      for (const itemCase of summary.cases ?? []) failures.push({ id: item.id, ...itemCase });
    }
  } finally {
    try {
      fs.rmSync(runRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  console.log(`\n扩展测试：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
