/**
 * 兼容层：原平台 `src/logger.js` 的最小替代。
 */
import { extensionLogger } from "../../lib/extensions-runtime.mjs";

export function logger(id) {
  const impl = extensionLogger(id);
  const wrap = (level) => (...args) => {
    try {
      if (typeof impl?.[level] === "function") impl[level](...args);
      else if (typeof impl === "function") impl(...args);
      else console[level === "debug" ? "log" : level]?.(...args);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };
  return { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") };
}

export default logger;
