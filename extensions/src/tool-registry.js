/**
 * 兼容层：原平台 `src/tool-registry.js` 的最小替代。
 * 原平台用它判断「某个工具现在可不可用」；心语里扩展工具随扩展启用/可用状态走，
 * 这里返回宿主给出的运行时可用性（拿不到就按可用处理，让插件自己兜底）。
 */
import { requireExtensionServices } from "../../lib/extensions-runtime.mjs";

export function getToolAvailability(toolId, options = {}) {
  try {
    const services = requireExtensionServices("tool-registry");
    if (typeof services.getToolAvailability === "function") {
      return services.getToolAvailability(String(toolId ?? ""), options) ?? { ok: true };
    }
  } catch {
    /* fallthrough */
  }
  return { ok: true };
}
