/**
 * 用「按 JS 词法状态扫描」的方式，找出 APP_JS 模板里字符串被换行截断的行。
 *
 * 比简单数字符更准：能区分「字符串正常闭合」和「引号在字符中间被当成闭合」。
 * 每行结束后如果还停在某个字符串里，那这一行几乎肯定是坏的。
 */
import fs from "node:fs";

const file = process.argv[2] || new URL("../lib/ui-app.mjs", import.meta.url);
const content = fs.readFileSync(file, "utf8");
const start = content.indexOf("String.raw`");
const end = content.lastIndexOf("`;");
const body = content.slice(start + "String.raw`".length, end);
const lines = body.split(/\r?\n/);

/**
 * 扫描一行，返回结束时的字符串状态。
 * 关键点：模板字面量里的 ${...} 里可能出现字符串，但本文件极少用到，
 * 所以按「引号一律按字符串分隔符处理」的近似即可定位问题行。
 */
function scanLine(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
  }
  return { inSingle, inDouble };
}

let bad = 0;
lines.forEach((line, index) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
  // 跳过明显不是 JS 的字面量块（前端代码里的正则等）
  if (trimmed.startsWith("const ICONS")) return;
  // 正则里的字符类（比如 /[&<>"']/g）会带一堆引号，那不是字符串分隔符，跳过
  if (/\/\[[^\]]*\]\//.test(trimmed)) return;
  const state = scanLine(line);
  if (state.inSingle || state.inDouble) {
    bad += 1;
    console.log(`模板第 ${index + 1} 行 ${state.inSingle ? "[单引号未闭合]" : "[双引号未闭合]"}`);
    console.log(`   ${trimmed.slice(0, 190)}`);
  }
});
console.log(`\n可疑行数：${bad}`);
process.exitCode = bad ? 1 : 0;
