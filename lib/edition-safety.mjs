import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isInstalled } from "./paths.mjs";

/** 默认数据目录的进程锁只用于提示；不会终止进程或声称端口一定安全。 */
export function otherEditionStatus({ local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  temp = os.tmpdir(), edition = process.env.HEARTECHO_EDITION === "tb" ? "tb" : "generic",
  installed = isInstalled, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  if (!installed) return { running: false };
  const data = edition === "tb" ? path.join(local, "心语") : path.join(local, "心语TB", "data");
  const key = createHash("sha1").update(path.resolve(data).toLowerCase()).digest("hex").slice(0, 12);
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(temp, `heartecho-${key}.lock`), "utf8"));
    const pid = Number(lock?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || path.resolve(String(lock.data || "")).toLowerCase() !== path.resolve(data).toLowerCase() || !alive(pid)) return { running: false };
    return { running: true, name: edition === "tb" ? "心语" : "领航员终端" };
  } catch { return { running: false }; }
}
