/**
 * 生成扩展注册表（打包用）。
 *
 * 为什么需要：心语发布形态是「一个 exe」，代码由 esbuild 打成一个 JS 再塞进 SEA。
 * 运行时从磁盘 import 扩展在 SEA 里不可行，所以打包前把 extensions/ 下所有扩展
 * 生成成一份**静态 import 清单**，交给 esbuild 一起打进去。
 *
 *   extensions/plugins/<id>/plugin.json + index.js
 *   extensions/skills/<id>/skill.json + index.js
 *     →
 *   lib/extensions.generated.mjs（自动生成，不要手改；已加入 .gitignore）
 *
 * 源码运行时不需要它：ExtensionHost 会优先用生成表，没有就扫描磁盘（开发热改方便）。
 *
 *   node tools/gen-extensions.mjs            # 生成
 *   node tools/gen-extensions.mjs --check    # 只检查（有扩展没进表就退出码 1）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXT_ROOT = path.join(ROOT, "extensions");
const OUT_FILE = path.join(ROOT, "lib", "extensions.generated.mjs");
const MANIFEST = { plugins: "plugin.json", skills: "skill.json" };
const checkOnly = process.argv.includes("--check");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function scan() {
  const entries = [];
  const problems = [];
  if (!fs.existsSync(EXT_ROOT)) return { entries, problems };
  for (const kind of ["plugins", "skills"]) {
    const kindDir = path.join(EXT_ROOT, kind);
    if (!fs.existsSync(kindDir)) continue;
    for (const name of fs.readdirSync(kindDir).sort()) {
      const dir = path.join(kindDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifestFile = path.join(dir, MANIFEST[kind]);
      if (!fs.existsSync(manifestFile)) {
        problems.push(`${kind}/${name}：缺少 ${MANIFEST[kind]}`);
        continue;
      }
      let manifest;
      try {
        manifest = readJson(manifestFile);
      } catch (error) {
        problems.push(`${kind}/${name}：${MANIFEST[kind]} 解析失败（${error?.message ?? error}）`);
        continue;
      }
      const entry = String(manifest.entry || "index.js");
      if (!fs.existsSync(path.join(dir, entry))) {
        problems.push(`${kind}/${name}：入口不存在（${entry}）`);
        continue;
      }
      if (String(manifest.id || name) !== name) {
        problems.push(`${kind}/${name}：manifest id（${manifest.id}）与目录名不一致`);
      }
      entries.push({
        kind,
        id: name,
        manifest,
        relative: path.relative(path.dirname(OUT_FILE), path.join(dir, entry)).split(path.sep).join("/"),
      });
    }
  }
  return { entries, problems };
}

function render(entries) {
  const lines = [];
  lines.push("// 本文件由 tools/gen-extensions.mjs 自动生成，不要手改。");
  lines.push("// 作用：把 extensions/ 下的扩展做成静态 import 清单，让 esbuild 能一起打进 exe。");
  lines.push("/* eslint-disable */");
  lines.push("export const generatedEntries = [");
  for (const item of entries) {
    lines.push("  {");
    lines.push(`    kind: ${JSON.stringify(item.kind)},`);
    lines.push(`    id: ${JSON.stringify(item.id)},`);
    lines.push(`    manifest: ${JSON.stringify(item.manifest)},`);
    lines.push(`    load: () => import(${JSON.stringify(`./${item.relative}`.startsWith("./") ? `./${item.relative}` : item.relative)}),`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const { entries, problems } = scan();
  for (const problem of problems) console.error(`[扩展注册表] ${problem}`);
  if (!entries.length) {
    console.log("[扩展注册表] extensions/ 下没有扩展（生成空表）");
  }
  const content = render(entries);
  if (checkOnly) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (current !== content) {
      console.error("[扩展注册表] 和 lib/extensions.generated.mjs 不一致，请运行 node tools/gen-extensions.mjs");
      process.exitCode = 1;
      return;
    }
    console.log(`[扩展注册表] 一致（${entries.length} 个扩展）`);
    return;
  }
  fs.writeFileSync(OUT_FILE, content, "utf8");
  console.log(`[扩展注册表] 已生成 ${entries.length} 个扩展 → ${path.relative(ROOT, OUT_FILE)}`);
  if (problems.length) process.exitCode = 1;
}

main();
