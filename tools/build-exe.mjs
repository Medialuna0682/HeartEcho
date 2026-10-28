/**
 * 把心语打包成一个真正独立的 exe：dist\心语.exe
 *
 * 做法（Node 官方 SEA：Single Executable Application）：
 *   1. esbuild 把整个项目打成**一个** JS 文件（本项目只用 Node 内置模块，所以没有 node_modules 负担）
 *   2. 生成 sea-config.json，用 node --experimental-sea-config 产出 blob
 *   3. 复制一份 node.exe，用 postject 把 blob 注入进去
 *   4. 顺手把图标塞进去（有就塞，没有也不影响）
 *
 * 目标机器不需要装 Node：运行时就是 exe 里那份 node。
 * 数据目录与程序目录分开，所以 exe 可以放在任意可写目录里。
 *
 *   node tools/build-exe.mjs
 *   node tools/build-exe.mjs --out "D:\某个目录\心语.exe"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = path.join(ROOT, "dist");
const BUILD_DIR = path.join(ROOT, "build");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : fallback;
};
const OUT_FILE = argValue("--out", path.join(OUT_DIR, "心语.exe"));

const log = (msg) => console.log(`[打包] ${msg}`);
const fail = (msg) => {
  console.error(`[打包失败] ${msg}`);
  process.exit(1);
};

/* ------------------------------ 找工具 ------------------------------ */

/**
 * 打包只用到两个第三方工具（都只在开发时用，运行时零依赖）：
 *   esbuild  —— 把整个项目打成单个 JS
 *   postject —— 把 SEA blob 注入 node.exe
 *
 * 装法二选一：
 *   npm i -D esbuild postject
 *   或者把它们的 node_modules 放到任意目录，用环境变量 HEARTECHO_TOOLS_DIR 指过去
 */
const TOOL_BASES = [
  path.join(ROOT, "node_modules"),
  process.env.HEARTECHO_TOOLS_DIR ? path.join(process.env.HEARTECHO_TOOLS_DIR, "node_modules") : "",
  process.env.HEARTECHO_TOOLS_DIR || "",
  path.join(ROOT, "..", "node_modules"),
].filter(Boolean);

/**
 * 找 esbuild。
 * 优先用真正的 esbuild.exe：Node 20+ 出于安全考虑不能直接 spawn 带参数的 .cmd，
 * 而 spawn(..., {shell:true}) 又会被路径里的空格坑到，所以直接找 exe 最省事。
 */
function findEsbuild() {
  for (const base of TOOL_BASES) {
    for (const name of ["esbuild.exe", "esbuild"]) {
      const direct = path.join(base, "@esbuild", "win32-x64", name);
      if (fs.existsSync(direct)) return direct;
    }
    const bin = path.join(base, ".bin", "esbuild.exe");
    if (fs.existsSync(bin)) return bin;
  }
  // 退一步：全局 PATH 里的 esbuild.exe
  try {
    const out = execFileSync("where", ["esbuild.exe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    /* ignore */
  }
  return "";
}

function findPostject() {
  for (const base of TOOL_BASES) {
    const item = path.join(base, "postject", "dist", "cli.js");
    if (fs.existsSync(item)) return item;
  }
  return "";
}

/* ------------------------------ 图标 ------------------------------ */

/** 用和托盘同一套代码生成一个 ico（纯手写 ICO，不依赖任何库）。 */
async function writeIcon(target) {
  const { desktopSelfCheck } = { desktopSelfCheck: null };
  const size = 64;
  const pixels = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (size * 2);
      const r = Math.round(139 + (244 - 139) * t);
      const g = Math.round(124 + (114 - 124) * t);
      const b = Math.round(248 + (182 - 248) * t);
      // 一颗心：用两个圆 + 一个三角的近似判据
      const nx = (x / size - 0.5) * 2.2;
      const ny = (y / size - 0.5) * 2.2;
      const inCircleL = (nx + 0.45) ** 2 + (ny + 0.35) ** 2 < 0.36;
      const inCircleR = (nx - 0.45) ** 2 + (ny + 0.35) ** 2 < 0.36;
      const inTriangle = ny > -0.1 && Math.abs(nx) < (1.0 - ny) * 0.95 && ny < 0.95;
      pixels.push(inCircleL || inCircleR || inTriangle ? [255, 255, 255] : [r, g, b]);
    }
  }
  const xor = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const [r, g, b] = pixels[i];
    xor[i * 4] = b;
    xor[i * 4 + 1] = g;
    xor[i * 4 + 2] = r;
    xor[i * 4 + 3] = 255;
  }
  const andMask = Buffer.alloc((size * size) / 8);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xor.length + andMask.length, 20);
  const dib = Buffer.concat([header, xor, andMask]);
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(0, 2);
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(1, 6);
  dir[6] = size;
  dir[7] = size;
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(dib.length, 14);
  dir.writeUInt32LE(22, 18);
  fs.writeFileSync(target, Buffer.concat([dir, dib]));
  return target;
}

/* ------------------------------ 去掉控制台窗口 ------------------------------ */

/**
 * 把 exe 的 PE 子系统中改成 GUI（3=CUI → 2=GUI）。
 *
 * 为什么必须改：Node 官方的 node.exe 是「控制台程序」（CUI）。
 * 双击一个 CUI 程序时，Windows 会先给它建一个黑色命令行窗口，而且这个窗口会一直跟着进程
 * ——用户看到的就是「启动后会拉起一个命令行窗口」。代码层面再怎么隐藏都不行，因为窗口
 * 是系统在进程启动之前就建好的。改 PE 头里的 Subsystem 字段是唯一彻底的办法。
 *
 * 副作用：不再有自己的控制台，直接往屏幕上打的东西看不见了。
 *   但是被管道重定向时（spawn/spawnSync 读 stdout、工具、验收脚本）标准输出照样工作，
 *   所以 `心语.exe --probe` 在脚本里仍然能拿到输出。
 *
 * 传 --console-subsystem 可以跳过这一步（调试用，还是老的控制台窗口）。
 */
function setGuiSubsystem(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 0x100 || buf.readUInt16LE(0) !== 0x5a4d) return { ok: false, reason: "不是 PE 文件（缺 MZ 头）" };
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 26 > buf.length) return { ok: false, reason: "PE 头越界" };
    if (buf.readUInt32LE(peOff) !== 0x00004550) return { ok: false, reason: "PE 签名不对" };
    const optionalOff = peOff + 24;
    const magic = buf.readUInt16LE(optionalOff);
    if (magic !== 0x10b && magic !== 0x20b) return { ok: false, reason: `未知的可选头格式：0x${magic.toString(16)}` };
    // Subsystem 在可选头里的偏移对 PE32 和 PE32+ 都是 68：
    //   PE32 有 BaseOfData(4)+ImageBase(4)，PE32+ 没有 BaseOfData 但 ImageBase 是 8 字节，
    //   两者在 ImageBase 之后完全对齐，所以后面的字段偏移一致。
    //   （+72 是 Win32VersionValue，写那里会把文件头搞坏，是没有效果的。）
    const subsystemOff = optionalOff + 68;
    if (subsystemOff + 2 > buf.length) return { ok: false, reason: "Subsystem 字段越界" };
    const before = buf.readUInt16LE(subsystemOff);
    if (before === 2) return { ok: true, changed: false, before, after: 2 };
    buf.writeUInt16LE(2, subsystemOff);
    fs.writeFileSync(file, buf);
    return { ok: true, changed: true, before, after: 2 };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  log(`项目目录：${ROOT}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const esbuild = findEsbuild();
  const postject = findPostject();
  if (!esbuild) fail("找不到 esbuild。请先装开发依赖：npm i -D esbuild postject（或用 HEARTECHO_TOOLS_DIR 指向已装好的 node_modules）");
  if (!postject) fail("找不到 postject。请先装开发依赖：npm i -D esbuild postject（或用 HEARTECHO_TOOLS_DIR 指向已装好的 node_modules）");

  /* ① 打成一个 JS */
  const bundle = path.join(BUILD_DIR, "bundle.cjs");
  /*
   * 打包前先扫描 extensions/ 生成静态注册表：
   * SEA 里没法从磁盘 import 扩展，只能让 esbuild 把它们一起打进单文件。
   * 生成失败（manifest 坏了/入口缺失）就直接停下——不然 exe 里会静默少几个扩展。
   */
  log("① 生成扩展注册表…");
  const genResult = spawnSync(process.execPath, [path.join(ROOT, "tools", "gen-extensions.mjs")], { cwd: ROOT, encoding: "utf8" });
  if (genResult.status !== 0) fail(`生成扩展注册表失败：\n${genResult.stderr || genResult.stdout}`);
  if (genResult.stdout?.trim()) console.log(genResult.stdout.trim().split(/\r?\n/).map((line) => `   ${line}`).join("\n"));
  log("① esbuild 打包成一个文件…");
  const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const esbuildArgs = [
    path.join(ROOT, "index.mjs"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    `--outfile=${bundle}`,
    `--banner:js=globalThis.__HEARTECHO_BUNDLED__=true;globalThis.__HEARTECHO_VERSION__=${JSON.stringify(appVersion)};`,
    "--log-level=warning",
  ];
  // 直接 spawn 真正的 esbuild.exe（不经 shell），参数里带空格也没问题
  const esbuildResult = spawnSync(esbuild, esbuildArgs, { cwd: ROOT, encoding: "utf8" });
  if (esbuildResult.error) fail(`esbuild 启动失败：${esbuildResult.error.message}`);
  if (esbuildResult.status !== 0) fail(`esbuild 失败：\n${esbuildResult.stderr || esbuildResult.stdout}`);
  if (esbuildResult.stderr?.trim()) console.log(esbuildResult.stderr.trim());
  if (!fs.existsSync(bundle)) fail("esbuild 没有产出文件");
  log(`   产物：${bundle}（${(fs.statSync(bundle).size / 1024).toFixed(0)} KB）`);

  /* ② 生成 SEA blob */
  const seaConfig = path.join(BUILD_DIR, "sea-config.json");
  const blob = path.join(BUILD_DIR, "sea-prep.blob");
  const dataDir = path.join(ROOT, "data");
  fs.writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  log("② 生成 SEA blob…");
  const seaResult = spawnSync(process.execPath, ["--experimental-sea-config", seaConfig], { cwd: ROOT, encoding: "utf8" });
  if (seaResult.status !== 0) fail(`生成 blob 失败：\n${seaResult.stderr || seaResult.stdout}`);
  log(`   blob：${(fs.statSync(blob).size / 1024 / 1024).toFixed(1)} MB`);

  /* ③ 复制 node 并注入 */
  log("③ 复制 node.exe 并注入 blob…");
  const tempExe = path.join(BUILD_DIR, "心语-未注入.exe");
  fs.copyFileSync(process.execPath, tempExe);
  const injectResult = spawnSync(
    process.execPath,
    [
      postject,
      tempExe,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (injectResult.status !== 0) fail(`postject 注入失败：\n${injectResult.stderr || injectResult.stdout}`);

  /* ③.5 去掉控制台窗口 */
  if (!process.argv.includes("--console-subsystem")) {
    const patched = setGuiSubsystem(tempExe);
    if (!patched.ok) log(`⚠ 没能改成 GUI 子系统（${patched.reason}），双击时仍会带一个命令行窗口`);
    else log(`   子系统：${patched.before} → ${patched.after}（GUI，双击不再弹命令行窗口）`);
  } else {
    log("   子系统：保留控制台（--console-subsystem）");
  }

  /* ④ 图标（可选） */
  const icon = path.join(BUILD_DIR, "app.ico");
  await writeIcon(icon);
  log(`④ 生成图标：${icon}`);

  if (OUT_FILE !== tempExe) {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.copyFileSync(tempExe, OUT_FILE);
  }
  fs.rmSync(tempExe, { force: true });

  const sizeMb = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(0);
  log(`完成：${OUT_FILE}（${sizeMb} MB）`);

  /* ⑤ 自检：能不能跑起来 */
  log("⑤ 冒烟：--probe（不常驻，只验证 exe 能启动）");
  const smoke = spawnSync(OUT_FILE, ["--probe"], {
    cwd: path.dirname(OUT_FILE),
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, HEARTECHO_DATA_DIR: path.join(os.tmpdir(), "heartecho-exe-smoke") },
  });
  const out = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`;
  const ok = /心语自检/.test(out) && /角色：/.test(out);
  console.log(out.split(/\r?\n/).slice(0, 14).map((line) => `   ${line}`).join("\n"));
  if (!ok) {
    log("⚠ exe 起来了但自检输出不完整，请手动跑一次 exe --probe 看看");
  } else {
    log("✓ exe 可以独立启动（不需要目标机器装 Node）");
  }
  try {
    fs.rmSync(path.join(os.tmpdir(), "heartecho-exe-smoke"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((error) => fail(String(error?.stack ?? error)));
