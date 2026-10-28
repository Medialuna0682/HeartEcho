import fs from "node:fs";

// SEA 在构建时注入版本；源码和安装版读取随程序发布的 package.json。
export const APP_VERSION = (() => {
  if (typeof globalThis.__HEARTECHO_VERSION__ === "string") return globalThis.__HEARTECHO_VERSION__;
  try { return String(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "unknown"); }
  catch { return "unknown"; }
})();
