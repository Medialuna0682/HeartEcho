/**
 * 兼容层：原平台 `src/model-prices.js` 的最小替代。
 * 价格一律从心语当前配置的模型 Profile / 服务商预设里取；拿不到就按 0 计。
 */
import { requireExtensionServices } from "../../lib/extensions-runtime.mjs";

export function resolveModelPrice(model, cfg = null) {
  try {
    return requireExtensionServices("model-prices").resolveModelPrice?.(model, cfg) ?? { in: 0, out: 0, cached: 0 };
  } catch {
    return { in: 0, out: 0, cached: 0 };
  }
}

/** 原平台有峰谷计价；心语没有分时价格，返回原价即可。 */
export function priceAt(price) {
  return price ?? { in: 0, out: 0, cached: 0 };
}

export function modelLabel(vendor, model) {
  const id = String(model ?? "").trim();
  return id;
}
