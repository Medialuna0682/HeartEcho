/**
 * 表情收藏（核心能力）。
 *
 * 背景：从「QQ Agent」平台移植过来的 meme-taste 技能把「她自己的表情收藏夹」
 * 当作核心能力（data/stickers.json + data/sticker-images/）。心语原来没有收藏夹，
 * 这里补一个最小实现：从当前会话的消息里取图 → 下载 → 落盘 → 记一条带理由的档案。
 *
 * 设计边界：
 *   - 只收当前会话消息里的图（messageId 必须能在该 scope 的消息表里找到）
 *   - 下载复用 OneBot 的 downloadImage（协议端已经能取 QQ 图片），失败再用安全 HTTP 兜底
 *   - 同一张图按 sha256 去重；总条数有上限，超出淘汰最旧的（连同文件）
 *   - 不做图片识别/描述：收藏档案里只有时间、来源、她写的理由
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createLogger } from "./log.mjs";
import { one } from "./db.mjs";

const log = createLogger("Stickers");
const MAX_STICKERS = 500;
const MAX_BYTES = 6 * 1024 * 1024;

export function createStickerStore({ dataDir = "", client = null } = {}) {
  const baseDir = dataDir;
  const imagesDir = path.join(baseDir, "sticker-images");
  const indexFile = path.join(baseDir, "stickers.json");
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      cache = {
        version: 1,
        nextId: Number(raw?.nextId) || 1,
        items: Array.isArray(raw?.items) ? raw.items : [],
      };
    } catch {
      cache = { version: 1, nextId: 1, items: [] };
    }
    return cache;
  }

  function save() {
    if (!cache) return;
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, indexFile);
  }

  function find(id) {
    return load().items.find((item) => String(item.id) === String(id)) ?? null;
  }

  function pathById(id) {
    const item = find(id);
    if (!item?.file) return null;
    const file = path.isAbsolute(item.file) ? item.file : path.join(baseDir, item.file);
    try {
      return fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }

  function pathByUrl(url) {
    const text = String(url ?? "").trim();
    if (!text) return null;
    const item = load().items.find((entry) => entry.url === text);
    return item ? pathById(item.id) : null;
  }

  function list(limit = 100) {
    return load().items.slice(-Math.max(1, Math.min(MAX_STICKERS, Number(limit) || 100))).reverse();
  }

  /** 找一条消息里的第一张图（只在指定会话里找）。 */
  function imageFromMessage(chatKey, messageId) {
    // chatKey 是扩展格式 group:<群号> / private:<QQ号>；心语真正的 scope_key 是
    // group_<群号>_<成员号> / private_<QQ号>，群会话要把该群所有成员的作用域都算上。
    const key = String(chatKey ?? "");
    let clause = "scope_key = ?";
    let args = [key];
    if (key.startsWith("group:")) {
      clause = "scope_key like ?";
      args = [`group_${key.slice(6)}_%`];
    } else if (key.startsWith("private:")) {
      clause = "scope_key = ?";
      args = [`private_${key.slice(8)}`];
    }
    const row = one(
      `select * from messages where ${clause} and (platform_message_id = ? or event_key = ? or id = ?) order by id desc limit 1`,
      [...args, String(messageId), String(messageId), Number(messageId) || -1],
    );
    if (!row) return null;
    let attachments;
    try {
      attachments = JSON.parse(row.attachments_json || "[]");
    } catch {
      attachments = [];
    }
    const image = (Array.isArray(attachments) ? attachments : []).find((item) => item?.type === "image" || item?.kind === "image");
    if (!image) return null;
    return { url: String(image.url ?? ""), file: String(image.file ?? ""), mid: String(row.platform_message_id ?? messageId), at: Number(row.at) || 0, senderId: String(row.sender_id ?? "") };
  }

  async function download(source) {
    const image = { url: source.url, file: source.file };
    if (client?.downloadImage) {
      const result = await client.downloadImage(image, { maxBytes: MAX_BYTES });
      const buffer = Buffer.isBuffer(result?.buffer) ? result.buffer : Buffer.from(result?.buffer ?? result?.data ?? []);
      if (buffer.length) return { buffer, mime: result?.mime ?? sniffMime(buffer) };
    }
    const url = String(source.url ?? "").trim();
    if (!url) throw new Error("消息里的图片没有可下载的地址");
    const target = validateImageUrl(url);
    const response = await globalThis.fetch(target, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_BYTES) throw new Error("图片太大");
    return { buffer: data, mime: sniffMime(data) };
  }

  async function collectFromMessage({ messageId, note = "", chatKey = "" } = {}) {
    if (!chatKey) return { content: "收藏失败：不知道是哪条消息（缺少会话信息）。", isError: true };
    const found = imageFromMessage(chatKey, messageId);
    if (!found) return { content: "收藏失败：这条消息里没有图片（只认图片消息）。", isError: true };
    let downloaded;
    try {
      downloaded = await download(found);
    } catch (error) {
      return { content: `收藏失败：${String(error?.message ?? error)}`, isError: true };
    }
    const sha = crypto.createHash("sha256").update(downloaded.buffer).digest("hex");
    const state = load();
    const existing = state.items.find((item) => item.sha256 === sha);
    if (existing) {
      if (!existing.note && note) existing.note = String(note);
      save();
      return { content: JSON.stringify({ status: "duplicate", id: existing.id, note: existing.note }), isError: false };
    }
    const id = String(state.nextId || 1);
    state.nextId = Number(id) + 1;
    const ext = extFromMime(downloaded.mime);
    const rel = path.join("sticker-images", `${id}-${sha.slice(0, 8)}${ext}`);
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, rel), downloaded.buffer);
    const item = {
      id,
      file: rel,
      url: found.url,
      sha256: sha,
      chatKey,
      mid: found.mid,
      senderId: found.senderId,
      note: String(note ?? "").slice(0, 200),
      at: Date.now(),
    };
    state.items.push(item);
    while (state.items.length > MAX_STICKERS) {
      const dropped = state.items.shift();
      const droppedPath = dropped?.file ? path.join(baseDir, dropped.file) : "";
      if (droppedPath) {
        try {
          fs.rmSync(droppedPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    save();
    log.info(`收藏了一张表情（#${id}）`);
    return { content: JSON.stringify({ status: "ok", id, note: item.note }), isError: false };
  }

  function listText(limit = 30) {
    const items = list(limit);
    if (!items.length) return { content: "收藏夹还是空的。" };
    const lines = items.map((item) => {
      const at = new Date(Number(item.at) || 0);
      const time = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      return `#${item.id}｜${time}｜${item.note || "（没写理由）"}`;
    });
    return { content: `收藏夹（最近 ${items.length} 张）：\n${lines.join("\n")}` };
  }

  function api() {
    return {
      find,
      list,
      collectFromMessage,
      localPath: (id) => pathById(id),
      pathByUrl,
      all: () => load().items.map((item) => ({ ...item })),
    };
  }

  return { find, list, collectFromMessage, listText, pathById, pathByUrl, api, baseDir, imagesDir };
}

function sniffMime(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function extFromMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  return ".bin";
}

function validateImageUrl(raw) {
  const url = new URL(String(raw ?? ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https 图片地址");
  const host = url.hostname.toLowerCase();
  if (/^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(host) || /\.(local|internal|lan|home)$/i.test(host)) {
    throw new Error("不允许内网/本机图片地址");
  }
  return url.toString();
}
