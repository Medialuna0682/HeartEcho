import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function serviceUrl(value) {
  const url = new URL(String(value));
  if (url.username || url.password || url.search || url.hash) throw new Error("服务地址不能包含凭据、查询或片段");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("远程服务必须使用 HTTPS，本机回环可用 HTTP");
  return url.toString().replace(/\/$/, "");
}

export async function serviceJson(url, { body, apiKey = "", method, timeoutMs = 10000, maxBytes = 1048576 } = {}) {
  const response = await fetch(url, {
    method: method || (body === undefined ? "GET" : "POST"),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`服务返回 HTTP ${response.status}`);
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > maxBytes) throw new Error("服务响应超过大小上限");
    parts.push(part);
  }
  const text = Buffer.concat(parts).toString("utf8");
  return text ? JSON.parse(text) : {};
}
