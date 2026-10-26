/**
 * 必须在**任何**业务模块之前执行：只解析 `--instance <目录>`，把环境变量摆好。
 *
 * paths.mjs 是在模块加载时就把目录算死的，等 index.mjs 的其它 import 跑起来再改就晚了。
 * ESM 的静态 import 是「先依赖、后自己」，所以只要这个文件是 index.mjs 的第一个 import，
 * 它的副作用就一定发生在 paths.mjs 之前。
 *
 * 这个文件刻意不 import 任何东西。
 */
const args = process.argv.slice(2);
if (args.includes("--tb")) process.env.HEARTECHO_EDITION = "tb";

function valueOf(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  return String(args[index + 1] ?? "").trim();
}

const instanceDir = valueOf("--instance");
if (args.includes("--tb") && !instanceDir) {
  const path = process.getBuiltinModule("node:path");
  const os = process.getBuiltinModule("node:os");
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "心语TB");
  process.env.HEARTECHO_DATA_DIR ||= path.join(dir, "data");
  process.env.HEARTECHO_LOG_DIR ||= path.join(dir, "logs");
  process.env.HEARTECHO_SETTINGS ||= path.join(dir, "心语TB设置.json");
}
if (instanceDir) {
  const path = process.getBuiltinModule("node:path");
  const resolved = path.resolve(instanceDir);
  // 让程序目录 = 实例目录：设置、数据、日志默认都落在它下面，
  // 不同实例之间因此天然互不干扰（锁也是按数据目录算的）。
  process.env.HEARTECHO_APP_DIR = resolved;
  process.env.HEARTECHO_SETTINGS = path.join(resolved, "心语设置.json");
}
