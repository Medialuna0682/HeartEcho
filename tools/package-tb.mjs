/** Produce a separate portable TB distribution without copying user data or keys. */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] || path.join(root, "dist", "HeartEcho-TB"));
if (fs.existsSync(output)) throw new Error("输出目录已存在，请指定新的空目录");
if (process.platform !== "win32") throw new Error("此便携包包含 Windows Node 运行时，请在 Windows 上构建");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("请使用 Node 24 构建");
const sqlite = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(":memory:");
sqlite.exec("create virtual table runtime_probe using fts5(content)");
sqlite.close();
let nodeLicense;
if (process.env.HEARTECHO_NODE_LICENSE) nodeLicense = fs.readFileSync(process.env.HEARTECHO_NODE_LICENSE, "utf8");
else {
  console.log("正在取得对应 Node 版本的官方许可证（打包需要网络）…");
  const licenseResponse = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
    { redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (!licenseResponse.ok) throw new Error("无法取得 Node 许可证；可用 HEARTECHO_NODE_LICENSE 指定本地许可证文件");
  nodeLicense = await licenseResponse.text();
}
if (!nodeLicense.includes("Node.js") || nodeLicense.length > 1048576) throw new Error("Node 许可证文件无效");
fs.mkdirSync(output, { recursive: true });
for (const file of ["index.mjs", "LICENSE"])
  if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.cpSync(path.join(root, "lib"), path.join(output, "lib"), { recursive: true });
/*
 * extensions/*.js 依赖根目录 package.json 的 "type": "module"；扩展本身也随 TB
 * 独立包交付，否则合并进来的插件与技能在便携版里会全部消失。
 */
fs.copyFileSync(path.join(root, "package.json"), path.join(output, "package.json"));
fs.cpSync(path.join(root, "extensions"), path.join(output, "extensions"), { recursive: true });
fs.mkdirSync(path.join(output, "tools"));
fs.copyFileSync(path.join(root, "tools", "supervisor.mjs"), path.join(output, "tools", "supervisor.mjs"));
fs.copyFileSync(process.execPath, path.join(output, "node.exe"));
fs.writeFileSync(path.join(output, "Node-LICENSE.txt"), nodeLicense);
fs.copyFileSync(path.join(root, "NOTICE"), path.join(output, "NOTICE"));
fs.copyFileSync(path.join(root, "EXTENSIONS.md"), path.join(output, "EXTENSIONS.md"));
fs.mkdirSync(path.join(output, "docs"));
fs.copyFileSync(path.join(root, "docs", "扩展宿主契约.md"), path.join(output, "docs", "扩展宿主契约.md"));
fs.copyFileSync(path.join(root, "启动TB.bat"), path.join(output, "启动TB.bat"));
fs.copyFileSync(path.join(root, "docs", "NEXT-VERSION.md"), path.join(output, "使用说明.md"));
fs.writeFileSync(
  path.join(output, "README.md"),
  [
    "# 心语 · 领航员 TB 独立便携版",
    "",
    "解压后双击 `启动TB.bat`。包内已包含 Node 运行时，无需另装 Node。",
    "",
    "QQ 和兼容的 OneBot 协议端需自行准备，在面板中选择。Hindsight 托管启动需要 Docker Desktop，首次下载需要网络。",
    "",
    "数据默认位于 `%LOCALAPPDATA%\\心语TB`，与普通版分开。详情见 [使用说明](使用说明.md)。",
    "",
    "便携包附带 16 个插件/技能；来源、权限边界与分发前授权提醒见 [EXTENSIONS.md](EXTENSIONS.md)。",
    "",
    "原项目：https://github.com/RCEY-123/HeartEcho 。本包为非官方衍生版本，应用源码遵循附带的 AGPL-3.0 许可证；Node 运行时许可见 Node-LICENSE.txt。",
    "",
  ].join("\n"),
);
console.log(`TB 独立便携包已生成：${output}`);
console.log(
  "包含 Node 运行时和 16 个插件/技能；QQ 协议端仍需在界面中选择。Hindsight 托管启动需要 Docker Desktop，首次下载需要网络。此包没有包含协议端、用户数据或密钥。",
);
