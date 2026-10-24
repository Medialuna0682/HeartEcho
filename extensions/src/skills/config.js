/**
 * 兼容层：原平台 `src/skills/config.js` 的最小替代。
 * 返回指定技能当前的设置（manifest 默认值 + 面板保存值的合并，实时读）。
 */
import { extensionSettings } from "../../../lib/extensions-runtime.mjs";

export function getSkillConfig(id) {
  return extensionSettings("skills", String(id ?? ""));
}
