/**
 * 兼容层：原平台 `src/sticker-manager.js` 的最小替代。
 * 把表情 URL 映射到本机缓存文件（收藏时下载过）；没有缓存就返回 null。
 */
import { requireExtensionServices } from "../../lib/extensions-runtime.mjs";

export function localStickerPath(url) {
  try {
    return requireExtensionServices("sticker-manager").stickerPathByUrl?.(String(url ?? "")) ?? null;
  } catch {
    return null;
  }
}

export function stickerUrl(id) {
  try {
    return requireExtensionServices("sticker-manager").stickerUrl?.(String(id ?? "")) ?? "";
  } catch {
    return "";
  }
}
