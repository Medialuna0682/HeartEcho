/** 构建 Windows 安装器开发预览；不包含第三方 QQ 协议端。 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installerIcon } from "./installer-icon.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = args.indexOf(name); return i < 0 ? fallback : String(args[i + 1] || ""); };
const edition = arg("--edition", "generic");
if (!["generic", "tb"].includes(edition)) throw new Error("--edition 必须是 generic 或 tb");
if (process.platform !== "win32") throw new Error("请在 Windows 上构建安装器");
const defaultName = edition === "tb" ? "领航员终端-安装-预览.exe" : "心语-安装-预览.exe";
const output = path.resolve(arg("--output", path.join(root, "dist", "installer", defaultName)));
if (fs.existsSync(output) || fs.existsSync(`${output}.sha256`)) throw new Error("安装包或校验文件已存在，请指定新路径");
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) throw new Error("找不到 C# 编译器");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-installer-build-"));
const payload = path.join(work, "payload");
const zip = path.join(work, "payload.zip");
const assembled = path.join(work, "setup.exe");
const build = spawnSync(process.execPath, [path.join(root, "tools", "build-payload.mjs"), "--edition", edition, "--output", payload], { cwd: root, encoding: "utf8" });
if (build.status !== 0) throw new Error(`安装负载构建失败：${build.stderr || build.stdout}`);
const zipScript = path.join(work, "zip.ps1");
fs.writeFileSync(zipScript, 'param([string]$Source,[string]$Archive)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Archive)\n', "utf8");
const zipped = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", zipScript, payload, zip], { cwd: work, encoding: "utf8", windowsHide: true });
if (zipped.status !== 0) throw new Error(`安装负载压缩失败：${zipped.stderr || zipped.stdout}`);
const compilerArgs = ["/nologo", "/target:winexe", "/reference:System.Windows.Forms.dll", "/reference:System.IO.Compression.dll",
  "/reference:System.IO.Compression.FileSystem.dll", "/reference:System.Web.Extensions.dll", "/reference:Microsoft.CSharp.dll",
  "/resource:payload.zip,heartecho.payload", "/out:setup.exe", "/win32icon:setup-icon.ico"];
fs.writeFileSync(path.join(work, "setup-icon.ico"), installerIcon());
if (edition === "tb") compilerArgs.push("/define:TB_EDITION");
compilerArgs.push(...["Installer.cs", "InstallCore.cs", "Payload.cs", "UninstallCore.cs", "Migration.cs", "OperationLock.cs", "PathGuard.cs"].map((name) => path.join(root, "installer", name)));
const compiled = spawnSync(csc, compilerArgs, { cwd: work, encoding: "utf8", windowsHide: true });
if (compiled.status !== 0) throw new Error(`安装器编译失败：${compiled.stdout}\n${compiled.stderr}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(assembled, output, fs.constants.COPYFILE_EXCL);
const hash = createHash("sha256").update(fs.readFileSync(output)).digest("hex");
fs.writeFileSync(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`, { flag: "wx" });
fs.rmSync(work, { recursive: true, force: true });
console.log(`已构建 ${edition} 安装器开发预览：${output}`);
console.log("此预览的安装、卸载和迁移尚未完成图形界面及干净机验收，不能作为正式发行包。");
console.log("分发前须按 EXTENSIONS.md 逐项确认所附扩展的作者授权。");
