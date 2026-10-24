/**
 * 兼容层：原平台 `src/prompt.js` 的最小替代。
 * 扩展用 `import * as promptCore from '../../src/prompt.js'`，这里只需要 appendDynamicTail。
 */
/**
 * 把一段动态文本追加到**最后一条 user 消息**的末尾（保住 system 缓存前缀）。
 * 返回是否追加成功。
 */
export function appendDynamicTail(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") m.content = `${m.content}${block}`;
    else if (Array.isArray(m.content)) m.content.push({ type: "text", text: block.trim() });
    else m.content = block.trim();
    return true;
  }
  return false;
}
