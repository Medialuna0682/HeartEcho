/**
 * 扩展系统运行时桥（宿主 ↔ 兼容层）。
 *
 * 为什么单独一个模块：extensions/src/* 是给「从 QQ Agent 移植过来的扩展包」用的兼容层，
 * 它们会 import ../../lib/extensions-runtime.mjs。宿主（lib/extensions.mjs）在**导入任何
 * 扩展入口之前**先把服务绑进来，所以兼容层在模块求值阶段就能拿到 DATA_DIR 等常量。
 *
 * 这里只存引用，不做事——避免 lib/extensions.mjs ↔ extensions/src/* 的循环依赖。
 */
import path from "node:path";
import { paths } from "./paths.mjs";

let services = null;

/** 宿主启动时调用一次。 */
export function bindExtensionServices(next) {
  services = next ?? null;
  return services;
}

export function extensionServices() {
  return services;
}

function requireServices(feature) {
  if (!services) throw new Error(`扩展宿主还没就绪（${feature} 暂不可用）`);
  return services;
}

/** 所有扩展的数据根目录：<心语数据目录>/extensions（不含任何聊天数据）。 */
export function extensionDataDir() {
  if (services?.dataDir) return path.resolve(services.dataDir);
  return path.join(paths.data, "extensions");
}

/** 取某个扩展当前的设置（manifest 默认值 + 面板保存值）。 */
export function extensionSettings(kind, id) {
  return services?.settingsFor?.(kind, String(id)) ?? {};
}

export function extensionLogger(id) {
  return services?.logger?.(String(id)) ?? console;
}

export function requireExtensionServices(feature) {
  return requireServices(feature);
}
