/** Local panel credentials are separate from the OneBot token and public config. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { paths } from "./paths.mjs";

const COOKIE = "heartecho_panel";

export function panelToken() {
  const file = path.join(paths.data, "panel-token");
  fs.mkdirSync(paths.data, { recursive: true });
  try {
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const token = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("面板凭据文件无效，请移走数据目录内的 panel-token 后重启");
  return token;
}

export function panelLaunchUrl(base) {
  const url = new URL(base);
  url.hash = `panelToken=${panelToken()}`;
  return url.href;
}

function equalToken(actual, expected) {
  const a = Buffer.from(String(actual ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function panelCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api`;
}

/** Run before routing, body parsing, state changes or opening an SSE stream. */
export function checkPanelRequest(req, { host, port, token }) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const hosts = loopback ? ["127.0.0.1", "localhost", "[::1]"] : [host.includes(":") ? `[${host}]` : host];
  const authorities = hosts.flatMap((name) => port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]);
  const authority = String(req.headers.host ?? "").toLowerCase();
  if (!authorities.includes(authority)) return { code: 403, message: "不受信任的 Host" };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== new URL(`http://${authority}`).origin) return { code: 403, message: "不受信任的请求来源" };
  if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) return { code: 403, message: "禁止跨来源访问面板" };
  let pathname;
  try { pathname = new URL(req.url, `http://${authority}`).pathname; }
  catch { return { code: 400, message: "无效的请求地址" }; }
  if (!pathname.startsWith("/api/")) return null;
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
  const cookie = String(req.headers.cookie ?? "").split(";").map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!equalToken(bearer, token) && !equalToken(cookie, token)) return { code: 401, message: "请从托盘打开面板，或重新启动程序取得授权" };
  if (["POST", "PUT", "PATCH"].includes(req.method) && String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return { code: 415, message: "写接口只接受 application/json" };
  }
  return null;
}
