/**
 * 兼容层：原平台 `src/safe-fetch.js` 的最小替代。
 * 只放行 http(s)、长度合理、不是内网/本机的图片地址；返回规范化后的 URL 字符串。
 */

const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;
const PRIVATE_SUFFIX = /\.(local|internal|lan|home)$/i;

export function validateImageUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("图片地址为空");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("图片地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https 图片地址");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || PRIVATE_SUFFIX.test(host)) throw new Error("不允许内网/本机图片地址");
  if (text.length > 2048) throw new Error("图片地址过长");
  return url.toString();
}

export function validateFetchUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("地址为空");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || PRIVATE_SUFFIX.test(host)) throw new Error("不允许内网/本机地址");
  return url.toString();
}
