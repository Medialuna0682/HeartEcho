/**
 * 圆润线性图标集（供前端内联使用）。
 *
 * 统一约定：24x24 视窗、stroke-width 1.8、linecap/linejoin 全部 round ——
 * 所以每个图标摸起来都是圆头的，视觉上也更柔和。
 */
import { ICONS as PATHS } from "./ui-icons.mjs";

export const CLIENT_ICONS = PATHS;
export const CLIENT_ICONS_JSON = JSON.stringify(PATHS);
