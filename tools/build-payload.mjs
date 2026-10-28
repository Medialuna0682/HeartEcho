/** 构建不含协议端与用户数据的安装版负载；目标目录必须是新目录。 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installerIcon } from "./installer-icon.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || "") : fallback;
};
const edition = arg("--edition", "generic");
if (!["generic", "tb"].includes(edition)) throw new Error("--edition 必须是 generic 或 tb");
if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("请在 Windows 使用 Node 24 或更新版本构建");
}
const output = path.resolve(arg("--output", path.join(root, "build", "installer", `payload-${edition}`)));
if (fs.existsSync(output)) throw new Error(`输出目录已存在：${output}；请指定新的输出目录`);
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) throw new Error("找不到 Windows .NET Framework C# 编译器");
const sqlite = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(":memory:");
sqlite.exec("create virtual table runtime_probe using fts5(content)");
sqlite.close();

let license;
if (process.env.HEARTECHO_NODE_LICENSE) license = fs.readFileSync(process.env.HEARTECHO_NODE_LICENSE, "utf8");
else {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, {
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("无法取得 Node 许可证；请用 HEARTECHO_NODE_LICENSE 指定文件");
  license = await response.text();
}
if (!license.includes("Node.js") || license.length > 1048576) throw new Error("Node 许可证文件无效");

const gen = spawnSync(process.execPath, [path.join(root, "tools", "gen-extensions.mjs")], { cwd: root, encoding: "utf8" });
if (gen.status !== 0) throw new Error(`生成扩展注册表失败：${gen.stderr || gen.stdout}`);
const app = path.join(output, "app");
fs.mkdirSync(app, { recursive: true });
for (const name of ["index.mjs", "package.json", "LICENSE", "NOTICE", "EXTENSIONS.md", "README.md", "INSTALLATION.md"]) {
  const source = path.join(root, name);
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`不能打包链接或特殊文件：${name}`);
  fs.copyFileSync(source, path.join(app, name));
}
// 显式清单避免把工作区中未追踪的账号文件、密钥或临时扩展带入安装包。
const sourceFiles = JSON.parse(fs.readFileSync(path.join(root, "tools", "payload-source-files.json"), "utf8"));
if (!Array.isArray(sourceFiles) || new Set(sourceFiles).size !== sourceFiles.length) throw new Error("安装负载源码清单无效");
const tracked = spawnSync("git", ["ls-files", "-z", "--", "lib", "extensions", "examples"], { cwd: root, encoding: "utf8" });
if (tracked.status === 0) {
  const allowed = new Set(sourceFiles);
  const missing = tracked.stdout.split("\0").filter((name) => name && !allowed.has(name));
  if (missing.length) throw new Error(`安装负载源码清单缺少已追踪文件，请更新清单：${missing.join(", ")}`);
}
for (const name of sourceFiles) {
  if (typeof name !== "string" || !/^(lib|extensions|examples)\//.test(name) || name.split("/").some((part) => !part || part === "." || part === "..") || name.includes("\\")) {
    throw new Error("安装负载源码清单包含不安全路径");
  }
  const source = path.join(root, ...name.split("/"));
  let ancestor = root;
  for (const part of name.split("/").slice(0, -1)) {
    ancestor = path.join(ancestor, part);
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`源码路径包含链接：${name}`);
  }
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`源码清单包含链接或特殊文件：${name}`);
  const target = path.join(app, ...name.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
const extensionManifests = sourceFiles.filter((name) => /^extensions\/(plugins|skills)\/[^/]+\/(plugin|skill)\.json$/.test(name)).sort();
const extensionCredits = extensionManifests.map((name) => {
  const info = JSON.parse(fs.readFileSync(path.join(app, ...name.split("/")), "utf8"));
  const clean = (value) => typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
  return `- ${clean(info.name) || name.split("/")[2]}：${clean(info.author) || "作者未标注"}（${name}）`;
});
fs.writeFileSync(path.join(app, "EXTENSION-AUTHORS.txt"), [
  "扩展作者与来源（依照各扩展清单记录，未标注不代表权利归属已确认）",
  "扩展移植自用户提供的 QQ Agent 生态素材。原始素材未附 LICENSE，分发前须逐项确认授权；详见 EXTENSIONS.md。",
  ...extensionCredits,
  "",
].join("\n"));
fs.mkdirSync(path.join(app, "docs"));
fs.copyFileSync(path.join(root, "docs", "NEXT-VERSION.md"), path.join(app, "docs", "NEXT-VERSION.md"));
fs.mkdirSync(path.join(app, "tools"));
for (const file of ["selftest.mjs", "png.mjs"]) fs.copyFileSync(path.join(root, "tools", file), path.join(app, "tools", file));
fs.mkdirSync(path.join(output, "runtime"));
fs.copyFileSync(process.execPath, path.join(output, "runtime", "node.exe"));
fs.writeFileSync(path.join(output, "runtime", "Node-LICENSE.txt"), license);
const launcher = edition === "tb" ? "领航员终端.exe" : "心语.exe";
const compilerArgs = ["/nologo", "/target:winexe", "/reference:System.Windows.Forms.dll", `/out:${path.join(output, launcher)}`];
if (edition === "tb") compilerArgs.push("/define:TB_EDITION");
const icon = path.join(output, "launcher-build-icon.ico");
fs.writeFileSync(icon, installerIcon());
compilerArgs.push(`/win32icon:${icon}`);
compilerArgs.push(path.join(root, "installer", "Launcher.cs"));
const compiled = spawnSync(csc, compilerArgs, { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`启动器编译失败：${compiled.stdout}\n${compiled.stderr}`);
fs.unlinkSync(icon);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(output, "VERSION.json"), JSON.stringify({ version: pkg.version, edition, node: process.versions.node,
  commit: git.status === 0 ? git.stdout.trim() : null, dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
  builtAt: new Date().toISOString() }, null, 2));
fs.writeFileSync(path.join(output, "INSTALL-EDITION.txt"), `${edition}\n`);
const lines = [];
function manifest(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) manifest(full, name);
    else if (entry.isFile()) lines.push(`${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}  ${name}`);
    else throw new Error(`不能把链接或特殊文件放进安装负载：${name}`);
  }
}
manifest(output);
fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
console.log(`已生成 ${edition} 安装负载：${output}；未包含 QQ 协议端、账号数据或密钥。`);
