/**
 * 兼容层：原平台 `src/llm.js` 的最小替代（判定类插件用）。
 * 宿主负责把这次调用接到心语自己的模型网关（预算、重试、日志都走心语）。
 */
import { requireExtensionServices } from "../../lib/extensions-runtime.mjs";

export async function chatCompletion(options = {}) {
  const services = requireExtensionServices("llm.chatCompletion");
  if (typeof services.chatCompletion !== "function") throw new Error("扩展宿主没有提供 chatCompletion");
  return services.chatCompletion(options);
}
