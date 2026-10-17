/**
 * QQ 适配器（OneBot 11 正向 WebSocket，兼容 SnowLuma / NapCat 等协议端）。
 *
 * 对应规划书 14.1 的抽象接口：
 *   connect / disconnect / on_private_message / on_group_message /
 *   list_groups / list_members / send_private / send_group / get_capabilities
 *
 * 约束：
 *   - 只用 Node 内置能力（全局 WebSocket + fetch），不引入任何第三方依赖
 *   - 「发送状态未知」不等于失败：交给上层进入待核验，绝不盲目重发（规划书 12.2）
 *   - 所有出站调用都可带幂等键，重复调用会被去重
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createLogger } from "./log.mjs";
import { redactText } from "./log.mjs";

const log = createLogger("OneBot");

const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 从文件头判断图片类型（比 Content-Type 可靠）。 */
export function sniffImageMime(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return "";
}

export function bufferToDataUrl(buffer) {
  const mime = sniffImageMime(buffer) || "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export function dataUrlFromLocalFile(file, { maxBytes = DEFAULT_IMAGE_MAX_BYTES } = {}) {
  const buffer = fs.readFileSync(file);
  if (!buffer.length) throw new Error(`图片是空的：${file}`);
  if (buffer.length > maxBytes) {
    throw new Error(`图片太大（${(buffer.length / 1024 / 1024).toFixed(1)} MB），超过上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB`);
  }
  return bufferToDataUrl(buffer);
}

/* -------------------------- 消息段标准化（14.2） -------------------------- */

/** 把 OneBot 消息段数组 / 字符串统一成纯文本，未支持的段落用占位符表示，绝不误传二进制。 */
export function segmentsToText(message) {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .map((seg) => {
      if (typeof seg === "string") return seg;
      switch (seg?.type) {
        case "text":
          return seg.data?.text ?? "";
        case "at":
          return seg.data?.qq === "all" ? "@全体成员" : `@${seg.data?.qq ?? ""}`;
        case "image":
          return "[图片]";
        case "face":
          return "[表情]";
        case "record":
          return "[语音]";
        case "video":
          return "[视频]";
        case "file":
          return `[文件:${seg.data?.name ?? ""}]`;
        case "forward":
          return "[合并转发]";
        case "reply":
          return "";
        case "json":
        case "xml":
          return "[卡片消息]";
        default:
          return seg?.type ? `[${seg.type}]` : "";
      }
    })
    .join("")
    .trim();
}

export function extractImages(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const seg of message) {
    if (seg?.type !== "image") continue;
    const data = seg.data ?? {};
    const url = String(data.url ?? "").trim();
    const file = String(data.file ?? "").trim();
    if (!url && !file) continue;
    out.push({ url, file, summary: String(data.summary ?? "").trim(), subType: data.sub_type ?? "" });
  }
  return out;
}

export function isAtMe(message, selfId) {
  if (!Array.isArray(message)) return false;
  return message.some((seg) => seg?.type === "at" && String(seg.data?.qq) === String(selfId));
}

export function stripAt(message, selfId) {
  if (!Array.isArray(message)) return typeof message === "string" ? message.trim() : "";
  return message
    .filter((seg) => !(seg?.type === "at" && String(seg.data?.qq) === String(selfId)))
    .map((seg) => (seg?.type === "text" ? seg.data?.text ?? "" : segmentsToText([seg])))
    .join("")
    .trim();
}

export function replyTarget(message) {
  if (!Array.isArray(message)) return "";
  const seg = message.find((item) => item?.type === "reply");
  return String(seg?.data?.id ?? "");
}

export function hasAny(message, type) {
  if (!Array.isArray(message)) return false;
  return message.some((seg) => seg?.type === type);
}

export class OneBot extends EventEmitter {
  constructor({ url, accessToken, httpUrl, selfId }) {
    super();
    this.url = url;
    this.accessToken = accessToken;
    this.httpUrl = httpUrl;
    this.selfId = Number(selfId) || 0;
    this.ws = null;
    this.connected = false;
    this.echo = 0;
    this.pending = new Map();
    this.retry = 0;
    this.closedByUser = false;
    this.queue = [];
    this.timers = new Set();
    this.sentKeys = new Map();
    this.capabilities = null;
    this.status = {
      online: false,
      lastError: "",
      connectedAt: 0,
      disconnectedAt: 0,
      selfId: this.selfId,
      nickname: "",
      reconnects: 0,
      lastEventAt: 0,
      events: 0,
    };
  }

  get online() {
    return this.connected;
  }

  start() {
    this.closedByUser = false;
    this.#connect();
  }

  stop() {
    this.closedByUser = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
    this.status.online = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  #later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (error) {
        log.warn(`延迟任务失败：${error?.message ?? error}`);
      }
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  #connect() {
    if (this.closedByUser) return;
    let ws;
    try {
      ws = new WebSocket(this.url, {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : undefined,
      });
    } catch (error) {
      this.status.lastError = String(error?.message ?? error);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.connected = true;
      const reconnects = this.status.reconnects;
      this.retry = 0;
      this.status = {
        ...this.status,
        online: true,
        lastError: "",
        connectedAt: Date.now(),
        selfId: this.selfId,
        reconnects,
      };
      log.info(`已连接协议端：${this.url}`);
      this.emit("connected");
      this.#flushQueue();
    });

    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        log.warn("收到无法解析的报文，已忽略");
        return;
      }
      this.#handle(payload);
    });

    ws.addEventListener("error", () => {
      this.status.lastError = "WebSocket 连接异常（协议端可能没起来）";
    });

    ws.addEventListener("close", (event) => {
      const wasOnline = this.connected;
      this.connected = false;
      this.status.online = false;
      this.status.disconnectedAt = Date.now();
      if (wasOnline) log.warn(`连接断开（code=${event?.code ?? "?"}），准备重连`);
      this.emit("disconnected");
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.closedByUser) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.retry, 4));
    this.retry += 1;
    this.status.reconnects += 1;
    this.#later(() => this.#connect(), delay);
  }

  #handle(payload) {
    if (payload.echo !== undefined && payload.echo !== null && this.pending.has(payload.echo)) {
      const { resolve, reject, timer } = this.pending.get(payload.echo);
      this.pending.delete(payload.echo);
      clearTimeout(timer);
      if (payload.status === "failed" || (payload.retcode !== undefined && payload.retcode !== 0)) {
        reject(
          Object.assign(new Error(payload.message || payload.wording || `OneBot 调用失败 (retcode=${payload.retcode})`), {
            retcode: payload.retcode,
            wording: payload.wording,
          }),
        );
      } else {
        resolve(payload.data ?? payload);
      }
      return;
    }
    if (payload.post_type) {
      this.status.lastEventAt = Date.now();
      this.status.events += 1;
      this.emit("event", payload);
    }
  }

  #flushQueue() {
    const items = this.queue.splice(0);
    for (const item of items) {
      this.call(item.action, item.params, { timeoutMs: item.timeoutMs, idempotencyKey: item.idempotencyKey }).then(
        item.resolve,
        item.reject,
      );
    }
  }

  /** 调用任意 OneBot action；未连接时排队等待（最长 60s）。 */
  call(action, params = {}, { timeoutMs = 60000 } = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) {
      return new Promise((resolve, reject) => {
        const item = { action, params, timeoutMs, resolve, reject };
        this.queue.push(item);
        if (this.queue.length > 200) this.queue.shift();
        this.#later(() => {
          const idx = this.queue.indexOf(item);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error(`还没连上 QQ（协议端），${action} 无法执行`));
          }
        }, 60000);
      });
    }
    const echo = `h${++this.echo}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** HTTP 兜底（WS 不通时用）。 */
  async callHttp(action, params = {}) {
    const base = String(this.httpUrl ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("没有配置 HTTP 接口地址");
    const res = await fetch(`${base}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000),
    });
    const json = await res.json();
    if (json.status === "failed" || (json.retcode !== undefined && json.retcode !== 0)) {
      throw new Error(json.message || json.wording || `HTTP 调用失败 (${json.retcode})`);
    }
    return json.data ?? json;
  }

  /* ------------------------------ 动作封装 ------------------------------ */

  /**
   * 幂等发送：同一个 idempotencyKey 只会真正发出去一次。
   * 返回 { message_id, deduped }。deduped=true 表示这次没有真的发。
   */
  async send(kind, targetId, message, { idempotencyKey = "", timeoutMs = 30000 } = {}) {
    if (idempotencyKey) {
      const seen = this.sentKeys.get(idempotencyKey);
      if (seen) return { ...seen, deduped: true };
    }
    const action = kind === "group" ? "send_group_msg" : "send_private_msg";
    const params = kind === "group" ? { group_id: Number(targetId), message } : { user_id: Number(targetId), message };
    const data = await this.call(action, params, { timeoutMs });
    const result = { message_id: String(data?.message_id ?? ""), sentAt: Date.now(), deduped: false };
    if (idempotencyKey) {
      this.sentKeys.set(idempotencyKey, result);
      if (this.sentKeys.size > 5000) {
        const firstKey = this.sentKeys.keys().next().value;
        this.sentKeys.delete(firstKey);
      }
    }
    return result;
  }

  sendPrivateMsg(userId, message, options) {
    return this.send("private", userId, message, options);
  }

  sendGroupMsg(groupId, message, options) {
    return this.send("group", groupId, message, options);
  }

  getLoginInfo() {
    return this.call("get_login_info", {}, { timeoutMs: 15000 });
  }

  getFriendList() {
    return this.call("get_friend_list", {}, { timeoutMs: 30000 });
  }

  getGroupList() {
    return this.call("get_group_list", {}, { timeoutMs: 30000 });
  }

  getGroupMemberList(groupId) {
    return this.call("get_group_member_list", { group_id: Number(groupId) }, { timeoutMs: 40000 });
  }

  getGroupMemberInfo(groupId, userId) {
    return this.call("get_group_member_info", { group_id: Number(groupId), user_id: Number(userId) }, { timeoutMs: 20000 });
  }

  /** 取一张图片的字节（依次尝试本地缓存 → 直连 URL → 协议端 get_image）。 */
  async downloadImage(image, { maxBytes = DEFAULT_IMAGE_MAX_BYTES, depth = 0 } = {}) {
    const candidates = [image?.file, image?.url].map((item) => String(item ?? "").trim()).filter(Boolean);
    const errors = [];

    for (const source of candidates) {
      const local = /^file:\/\//i.test(source) ? source : /^[a-zA-Z]:[\\/]/.test(source) ? source : "";
      if (!local) continue;
      try {
        const filePath = local.startsWith("file://") ? new URL(local) : local;
        const buffer = fs.readFileSync(filePath);
        if (buffer.length > maxBytes) throw new Error("图片太大");
        return { dataUrl: bufferToDataUrl(buffer), source: "local", bytes: buffer.length };
      } catch (error) {
        errors.push(`本地文件：${error?.message ?? error}`);
      }
    }

    for (const source of candidates) {
      if (!/^https?:\/\//i.test(source)) continue;
      try {
        const res = await fetch(source, {
          headers: { "User-Agent": IMAGE_UA, Referer: "https://im.qq.com/" },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (!buffer.length) throw new Error("内容为空");
        if (buffer.length > maxBytes) throw new Error(`图片太大（${(buffer.length / 1024 / 1024).toFixed(1)} MB）`);
        if (!sniffImageMime(buffer)) throw new Error("拿到的不是图片");
        return { dataUrl: bufferToDataUrl(buffer), source: "url", bytes: buffer.length };
      } catch (error) {
        errors.push(`直连图片地址失败：${error?.message ?? error}`);
      }
    }

    if (depth < 1 && image?.file) {
      try {
        const info = await this.call("get_image", { file: image.file }, { timeoutMs: 20000 });
        const next = {
          url: String(info?.url ?? info?.file_url ?? "").trim(),
          file: String(info?.file ?? "").trim(),
        };
        if (next.url !== image.url || next.file !== image.file) {
          const result = await this.downloadImage(next, { maxBytes, depth: depth + 1 });
          return { ...result, source: `get_image→${result.source}` };
        }
        errors.push("协议端的 get_image 没有返回新地址");
      } catch (error) {
        errors.push(`get_image 失败：${error?.message ?? error}`);
      }
    }

    throw new Error(errors.join("；") || "没有可用的图片地址");
  }

  /** 能力探测：协议端支持哪些接口。结果会缓存，供面板与空间功能门控使用。 */
  async probeCapabilities({ refresh = false } = {}) {
    if (this.capabilities && !refresh) return this.capabilities;
    const probe = async (action, params = {}) => {
      try {
        await this.call(action, params, { timeoutMs: 12000 });
        return "api_verified";
      } catch (error) {
        const message = redactText(String(error?.message ?? error));
        if (/不支持|unknown action|not found|retcode=-1404|不合法/i.test(message)) return "unsupported";
        return "error";
      }
    };
    const capabilities = {
      send_private_msg: this.connected ? "api_verified" : "unknown",
      send_group_msg: this.connected ? "api_verified" : "unknown",
      get_group_list: await probe("get_group_list"),
      get_group_member_list: "unknown",
      get_friend_list: await probe("get_friend_list"),
      get_image: "unknown",
      send_qzone_msg: await probe("send_qzone_msg", { text: "" }),
      get_qzone_feeds: await probe("get_qzone_feeds", { count: 1 }),
      get_qzone_msg_list: await probe("get_qzone_msg_list", { target_uin: this.selfId, pos: 0, num: 1 }),
      like_qzone: "unknown",
      comment_qzone: "unknown",
      get_cookies: await probe("get_cookies", { domain: "qzone.qq.com" }),
      checkedAt: Date.now(),
    };
    this.capabilities = capabilities;
    return capabilities;
  }

  async ping() {
    try {
      const info = await this.getLoginInfo();
      this.status.nickname = info?.nickname ?? "";
      this.status.selfId = info?.user_id ?? this.selfId;
      return { ok: true, info };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
}

/**
 * 把一条已授权的真实事件标准化为内部数据契约（规划书 14.2）。
 * 所有字段先经校验；缺关键字段直接返回 null，不让脏数据进入流水线。
 */
export function normalizeEvent(event, selfId) {
  if (!event || event.post_type !== "message") return null;
  const self = Number(selfId ?? 0) || Number(event.self_id ?? 0);
  const messageId = String(event.message_id ?? "");
  const at = Number(event.time ?? 0) * 1000 || Date.now();

  if (event.message_type === "private") {
    const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
    if (!senderId || !messageId) return null;
    return {
      eventId: `private:${self}:${messageId}`,
      platform: "qq",
      accountId: String(self),
      scopeType: "private",
      scopeId: senderId,
      subjectId: "",
      scopeKey: `private_${senderId}`,
      kind: "private",
      senderId,
      senderName: event.sender?.nickname ?? "",
      groupId: "",
      groupName: "",
      messageId,
      timestampMs: at,
      segments: event.message ?? [],
      text: segmentsToText(event.message),
      images: extractImages(event.message),
      isMention: false,
      replyTo: replyTarget(event.message),
      hasFace: hasAny(event.message, "face"),
      subType: event.sub_type ?? "friend",
      traceId: `${Date.now().toString(36)}-${messageId}`,
      raw: event,
    };
  }

  if (event.message_type === "group") {
    const groupId = String(event.group_id ?? "");
    const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
    if (!groupId || !senderId || !messageId) return null;
    const atMe = isAtMe(event.message, self);
    return {
      eventId: `group:${self}:${groupId}:${messageId}`,
      platform: "qq",
      accountId: String(self),
      scopeType: "group",
      scopeId: groupId,
      subjectId: senderId,
      scopeKey: `group_${groupId}_${senderId}`,
      kind: "group",
      senderId,
      senderName: event.sender?.card || event.sender?.nickname || "",
      groupId,
      groupName: event.group_name ?? "",
      messageId,
      timestampMs: at,
      segments: event.message ?? [],
      text: atMe ? stripAt(event.message, self) : segmentsToText(event.message),
      images: extractImages(event.message),
      isMention: atMe,
      replyTo: replyTarget(event.message),
      hasFace: hasAny(event.message, "face"),
      subType: event.sub_type ?? "normal",
      traceId: `${Date.now().toString(36)}-${messageId}`,
      raw: event,
    };
  }

  return null;
}
