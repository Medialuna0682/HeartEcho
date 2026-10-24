/**
 * 兼容层：原平台 `src/config.js` 的最小替代。
 * 扩展包里的 `import { DATA_DIR, getConfig, updateConfig } from '../../src/config.js'` 会解析到这里。
 */
import { extensionDataDir, requireExtensionServices } from "../../lib/extensions-runtime.mjs";

export const DATA_DIR = extensionDataDir();

export function getConfig() {
  return extensionServicesSafe().getConfig?.() ?? {};
}

export function updateConfig(patch) {
  return extensionServicesSafe().updateConfig?.(patch) ?? {};
}

function extensionServicesSafe() {
  try {
    return requireExtensionServices("config");
  } catch {
    return {};
  }
}
