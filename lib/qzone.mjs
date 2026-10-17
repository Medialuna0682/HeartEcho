/**
 * QQ 空间适配器（规划书 09、FR-601~604）。
 *
 * 四个状态严格区分：接口存在 → 调用返回 → 真实页面生效 → 多次回归通过。
 * 只有 end_to_end_verified 的能力才允许开启自动化写操作。
 *
 * 红线：
 *   - 默认不自动发布，写操作默认待审批
 *   - HTTP 200 不等于真实社交结果：必须能读到页面才改成 verified，否则停在 sent_unverified
 *   - 相同目标动态用 action_key 幂等，不会重复点赞刷屏
 */
import { all, one, run, audit } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { cleanReply } from "./util.mjs";

const log = createLogger("QZone");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 能力定义：面板按这些项逐条展示与门控。 */
export const QZONE_CAPABILITIES = [
  { id: "post_text", label: "发文字说说", risk: "write" },
  { id: "post_image", label: "发布带图说说", risk: "write" },
  { id: "read_own", label: "读自己空间的说说", risk: "read" },
  { id: "read_feeds", label: "读好友动态流", risk: "read" },
  { id: "like", label: "给动态点赞", risk: "write" },
  { id: "comment", label: "评论动态", risk: "write" },
  { id: "delete", label: "删除说说", risk: "write" },
];

export const QZONE_HINTS = {
  "not-logged-in": "腾讯认为这个 QQ 号还没有可用的空间登录态。用 QQ 客户端或手机 QQ 打开一次它的 QQ 空间，过几分钟再试。",
  "rate-limited": "腾讯把这个接口限流了（-10000）。等 10~30 分钟再试，别连着点。",
  shape: "接口返回的数据结构不对，通常也是空间登录态的问题。先点「空间自检」。",
  permission: "这个账号没有对应权限（可能是可见范围或好友限制）。",
  network: "网络不通或超时。检查网络后重试。",
  unknown: "先点「空间自检」，把结果发出来看看。",
};

export class QzoneError extends Error {
  constructor(message, { kind = "unknown", hint = "", code = null } = {}) {
    super(message);
    this.name = "QzoneError";
    this.kind = kind;
    this.hint = hint || QZONE_HINTS[kind] || QZONE_HINTS.unknown;
    this.code = code;
  }
}

export function classifyQzoneError(message) {
  const text = String(message ?? "");
  if (/-3000|请先登录空间|need login|未登录/i.test(text)) return { kind: "not-logged-in", code: -3000 };
  if (/-10000|rate.?limit|限流/i.test(text)) return { kind: "rate-limited", code: -10000 };
  if (/-1000[0-9]|权限|forbidden|denied/i.test(text)) return { kind: "permission", code: null };
  if (/响应结构异常|msglist|结构/i.test(text)) return { kind: "shape", code: null };
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(text)) return { kind: "network", code: null };
  return { kind: "unknown", code: null };
}

export function bknFrom(secret) {
  let hash = 5381;
  for (const ch of String(secret ?? "")) hash += (hash << 5) + ch.charCodeAt(0);
  return hash & 0x7fffffff;
}

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

export function htmlToText(html) {
  if (!html) return "";
  let text = String(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|h\d)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  for (const [k, v] of Object.entries(ENTITIES)) text = text.replaceAll(k, v);
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractImages(html) {
  const urls = new Set();
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(String(html ?? "")))) {
    let url = match[1];
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:/i.test(url)) continue;
    if (/qzonestyle|qzone_style|emotion|face\/|qlogo|avatar/i.test(url)) continue;
    urls.add(url);
  }
  return [...urls];
}

export function guessTid(feed) {
  const key = String(feed?.key ?? "").trim();
  if (/^[0-9a-f]{20,32}$/i.test(key)) return key;
  const html = String(feed?.html ?? "");
  for (const pattern of [/data-tid=["']([0-9a-f]{16,32})["']/i, /[?&]tid=([0-9a-f]{16,32})/i, /"tid"\s*:\s*"?([0-9a-f]{16,32})"?/i]) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  const tail = key.match(/([0-9a-f]{16,})$/i);
  return tail ? tail[1] : "";
}

/* ------------------------------ 能力状态 ------------------------------ */

export function initCapabilities() {
  for (const item of QZONE_CAPABILITIES) {
    run("insert or ignore into qzone_capabilities(capability, status, note, checked_at) values(?, 'unknown', '', 0)", [item.id]);
  }
}

export function setCapability(id, status, note = "") {
  const allowed = ["unknown", "discovered", "api_verified", "end_to_end_verified", "degraded", "disabled"];
  if (!allowed.includes(status)) throw new Error(`不认识的能力状态：${status}`);
  run(
    `insert into qzone_capabilities(capability, status, note, checked_at) values(?, ?, ?, ?)
     on conflict(capability) do update set status = excluded.status, note = excluded.note, checked_at = excluded.checked_at`,
    [id, status, String(note).slice(0, 300), Date.now()],
  );
  audit({ eventType: "qzone_capability", reason: `${id} → ${status}`, detail: { note } });
}

export function capabilityStatus(id) {
  return one("select * from qzone_capabilities where capability = ?", [id])?.status ?? "unknown";
}

export function listCapabilities() {
  initCapabilities();
  const rows = all("select * from qzone_capabilities");
  const map = new Map(rows.map((row) => [row.capability, row]));
  return QZONE_CAPABILITIES.map((item) => ({ ...item, status: map.get(item.id)?.status ?? "unknown", note: map.get(item.id)?.note ?? "", checkedAt: map.get(item.id)?.checked_at ?? 0 }));
}

/** 自动化写操作的门控：只有端到端验证过的能力才允许自动执行。 */
export function canAutomate(capability) {
  const status = capabilityStatus(capability);
  if (status === "end_to_end_verified") return { ok: true, status };
  return { ok: false, status, reason: `「${QZONE_CAPABILITIES.find((item) => item.id === capability)?.label ?? capability}」还没有通过真实账号端到端验证（当前状态：${status}）` };
}

/* ------------------------------ 动作队列 ------------------------------ */

const STATUS_LABEL = {
  pending: "待执行",
  sent_unverified: "已发出，待核验",
  verified: "已确认生效",
  failed: "失败",
  skipped: "已跳过",
  rejected: "已拒绝",
};

function recordAction({ action, tid = "", targetUin = "", idempotencyKey, request = {}, status = "pending" }) {
  run(
    `insert or ignore into qzone_actions(target_post, target_uin, action, status, idempotency_key, request_json, at)
     values(?, ?, ?, ?, ?, ?, ?)`,
    [String(tid), String(targetUin), action, status, idempotencyKey, JSON.stringify(request ?? {}), Date.now()],
  );
  return one("select * from qzone_actions where idempotency_key = ?", [idempotencyKey]);
}

function finishAction(idempotencyKey, { status, result = {}, verified = false }) {
  run("update qzone_actions set status = ?, result_json = ?, verified = ?, verify_at = ? where idempotency_key = ?", [
    status,
    JSON.stringify(result ?? {}),
    verified ? 1 : 0,
    Date.now(),
    idempotencyKey,
  ]);
  return one("select * from qzone_actions where idempotency_key = ?", [idempotencyKey]);
}

export function listActions({ limit = 100 } = {}) {
  return all("select * from qzone_actions order by at desc limit ?", [Math.max(1, Number(limit) || 100)]).map((row) => ({
    ...row,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
  }));
}

/* ------------------------------ 适配器本体 ------------------------------ */

export class QZoneAdapter {
  constructor({ client, llm }) {
    this.client = client;
    this.llm = llm;
    this.lastError = "";
    this.lastCheck = null;
    initCapabilities();
  }

  /* --------------------------- 读取 --------------------------- */

  async cookies() {
    const data = await this.client.call("get_cookies", {}, { timeoutMs: 15000 });
    return String(data?.cookies ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .join("; ");
  }

  static pickPskey(cookieText) {
    return /(?:^|;\s*)p_skey=([^;]+)/.exec(String(cookieText ?? ""))?.[1] ?? "";
  }

  /** 直连腾讯读说说列表（协议端读接口坏了时的兜底）。 */
  async directMsgList(targetUin, pos = 0, num = 20) {
    const uin = Number(targetUin) || Number(this.client.selfId) || 0;
    const cookie = await this.cookies();
    const pskey = QZoneAdapter.pickPskey(cookie);
    if (!pskey) throw new QzoneError("cookie 里没有 p_skey，空间接口用不了", classifyQzoneError("请先登录空间"));
    const gtk = bknFrom(pskey);
    const url =
      "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?" +
      `uin=${uin}&ftype=0&sort=0&pos=${Number(pos) || 0}&num=${Number(num) || 20}&code_version=1&format=json&g_tk=${gtk}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: cookie, Referer: `https://user.qzone.qq.com/${uin}` },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text.replace(/^[^{[]+/, ""));
    } catch {
      throw new QzoneError(`返回的不是 JSON：${text.slice(0, 120)}`, classifyQzoneError("响应结构异常"));
    }
    if (typeof json.code === "number" && json.code !== 0) {
      throw new QzoneError(`直连返回 code=${json.code} ${json.message ?? ""}`, classifyQzoneError(`${json.code} ${json.message ?? ""}`));
    }
    const list = Array.isArray(json.msglist) ? json.msglist : [];
    return {
      msglist: list.map((item) => ({
        tid: String(item.tid ?? ""),
        content: String(item.content ?? ""),
        created_time: Number(item.created_time ?? item.time ?? 0),
        comment_num: Array.isArray(item.commentlist) ? item.commentlist.length : Number(item.comment_num ?? 0),
        is_private: Boolean(item.is_private),
        images: Array.isArray(item.pic) ? item.pic : [],
        source: "direct",
      })),
      total: Number(json.total ?? list.length),
      source: "direct",
    };
  }

  async msgList(targetUin = 0, pos = 0, num = 20) {
    const uin = Number(targetUin) || 0;
    let lastError = null;
    for (const params of [{ ...(uin ? { target_uin: uin } : {}), pos, num }, { ...(uin ? { user_id: uin } : {}), pos, num }]) {
      try {
        const data = await this.client.call("get_qzone_msg_list", params, { timeoutMs: 40000 });
        if (Array.isArray(data?.msglist)) return { ...data, source: "adapter" };
        lastError = new Error("响应结构异常：没有 msglist 字段");
      } catch (error) {
        lastError = error;
      }
    }
    try {
      const data = await this.directMsgList(uin, pos, num);
      if (Array.isArray(data?.msglist)) return data;
    } catch (error) {
      log.warn(`直连腾讯也没成功：${String(error?.message ?? error).slice(0, 160)}`);
    }
    const info = classifyQzoneError(lastError?.message ?? lastError);
    this.lastError = String(lastError?.message ?? lastError);
    throw new QzoneError(`无法获取说说列表：${this.lastError.slice(0, 160)}`, info);
  }

  async feedItems({ count = 20 } = {}) {
    const data = await this.client.call("get_qzone_feeds", { page_num: 1, count }, { timeoutMs: 40000 });
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    return feeds.map((feed) => ({
      uin: Number(feed.uin ?? 0),
      nickname: feed.nickname ?? "",
      time: Number(feed.time ?? 0),
      key: feed.key ?? "",
      text: htmlToText(feed.html),
      images: extractImages(feed.html),
      tid: guessTid(feed),
    }));
  }

  /* --------------------------- 自检 --------------------------- */

  async selfCheck() {
    const steps = [];
    const add = (name, ok, detail) => steps.push({ name, ok, detail: String(detail ?? "").slice(0, 240) });
    let cookie = "";
    let pskeyOk = false;

    try {
      cookie = await this.cookies();
      pskeyOk = Boolean(QZoneAdapter.pickPskey(cookie));
      add("① 取登录票据（get_cookies）", Boolean(cookie), pskeyOk ? "票据齐全（含 p_skey）" : "只有 QQ 登录票据，没有 p_skey");
    } catch (error) {
      add("① 取登录票据（get_cookies）", false, error?.message);
    }

    let adapterRead = null;
    try {
      adapterRead = await this.client.call("get_qzone_msg_list", { pos: 0, num: 1 }, { timeoutMs: 30000 });
      const ok = Array.isArray(adapterRead?.msglist);
      add("② 协议端读自己空间说说", ok, ok ? `拿到 ${adapterRead.msglist.length} 条` : "结构异常：没有 msglist");
      if (ok) setCapability("read_own", adapterRead.msglist.length ? "api_verified" : "discovered", "自检通过");
    } catch (error) {
      add("② 协议端读自己空间说说", false, classifyQzoneError(error?.message ?? error).kind);
    }

    try {
      const feeds = await this.feedItems({ count: 3 });
      add("③ 协议端读好友动态", true, `拿到 ${feeds.length} 条`);
      setCapability("read_feeds", feeds.length ? "api_verified" : "discovered", "自检通过");
    } catch (error) {
      add("③ 协议端读好友动态", false, classifyQzoneError(error?.message ?? error).kind);
    }

    let direct = null;
    try {
      direct = await this.directMsgList(0, 0, 1);
      add("④ 直连腾讯读说说（绕过协议端）", true, `拿到 ${direct.msglist.length} 条，说明账号本身可用`);
    } catch (error) {
      add("④ 直连腾讯读说说（绕过协议端）", false, classifyQzoneError(error?.message ?? error).kind);
    }

    let conclusion;
    let hint = "";
    const adapterItems = Array.isArray(adapterRead?.msglist) ? adapterRead.msglist.length : 0;
    const directItems = direct?.msglist?.length ?? 0;

    if (adapterItems > 0 || directItems > 0) {
      // 只要有任意一条路径能读到真实说说，就说明这个号的空间是通的
      setCapability("read_own", "end_to_end_verified", `读到 ${adapterItems || directItems} 条真实说说`);
      if (adapterItems > 0 && directItems > 0) {
        conclusion = `空间读取正常：协议端与直连都能拿到说说（各 ${adapterItems} / ${directItems} 条）。`;
      } else if (adapterItems > 0) {
        conclusion = `空间读取正常：协议端能拿到 ${adapterItems} 条说说。直连那条路被腾讯拒了（-3000），但机器人本来优先走协议端，不影响使用。`;
      } else {
        conclusion = `协议端读接口有问题，但直连能拿到 ${directItems} 条说说——机器人会自动改用直连。`;
      }
      const postCap = listCapabilities().find((item) => item.id === "post_text");
      if (postCap && postCap.status !== "end_to_end_verified") {
        conclusion += " 发说说还没做过真实发布验证：点「直接发布」发一条测试说说，机器人会读回页面确认，确认到了才会把这项标成「端到端已验证」。";
      }
    } else if (!pskeyOk) {
      conclusion = "没有空间登录票据：这个号还没登录过 QQ 空间。";
      hint = QZONE_HINTS["not-logged-in"];
    } else {
      conclusion = "腾讯回的是「请先登录空间」：这个号还没有可用的空间登录态。用 QQ 客户端打开一次它的空间，过几分钟再试。";
      hint = QZONE_HINTS["not-logged-in"];
    }

    const capabilities = listCapabilities();
    this.lastCheck = { at: Date.now(), steps, conclusion, hint, capabilities };
    return this.lastCheck;
  }

  inspectCapabilities({ probe = false } = {}) {
    return { at: Date.now(), capabilities: listCapabilities(), lastCheck: this.lastCheck, note: probe ? "已按当前配置刷新" : "" };
  }

  /* --------------------------- 写操作 --------------------------- */

  /**
   * 发布说说。dryRun 只返回将要发送的内容。
   * 默认不自动发布：调用方必须先拿到用户审批。
   */
  async publish(content, { images = [], ugcRight = 1, dryRun = false, idempotencyKey = "" } = {}) {
    const text = String(content ?? "").trim().slice(0, 1500);
    if (!text && !images.length) throw new Error("说说内容不能为空");
    if (dryRun) return { dryRun: true, content: text, images, ugcRight };
    const key = idempotencyKey || `post:${Date.now()}`;
    const existing = one("select * from qzone_actions where idempotency_key = ?", [key]);
    if (existing && existing.status !== "failed") {
      return { deduped: true, action: existing };
    }
    recordAction({ action: "post", idempotencyKey: key, request: { content: text, images, ugcRight }, status: "pending" });
    try {
      const params = { content: text, ugc_right: Number(ugcRight) || 1 };
      if (images.length) params.images = images.slice(0, 9);
      const data = await this.client.call("send_qzone_msg", params, { timeoutMs: 180000 });
      // API 返回成功 ≠ 页面生效（规划书 FR-604）：先记为 sent_unverified
      const verified = await this.verifyPublished(text).catch(() => false);
      const action = finishAction(key, {
        status: verified ? "verified" : "sent_unverified",
        result: { data, verified },
        verified,
      });
      setCapability("post_text", verified ? "end_to_end_verified" : "api_verified", verified ? "已读到刚发的内容" : "接口返回成功，但没能读到页面确认");
      if (params.images) {
        setCapability("post_image", verified ? "end_to_end_verified" : "api_verified", verified ? "带图说说已读到页面确认" : "接口返回成功，但没能读到页面确认");
      }
      log.info(`说说已发出（${verified ? "已确认可见" : "待核验"}）：${text.slice(0, 40)}`);
      return { ok: true, data, verified, action };
    } catch (error) {
      const info = classifyQzoneError(error?.message ?? error);
      finishAction(key, { status: "failed", result: { error: String(error?.message ?? error), kind: info.kind } });
      setCapability("post_text", "degraded", info.kind);
      throw new QzoneError(`发说说失败：${String(error?.message ?? error).slice(0, 200)}`, info);
    }
  }

  /** 用「读自己空间的最新说说」来核验是否真的发出去且可见。 */
  async verifyPublished(content) {
    const snippet = String(content ?? "").replace(/\s+/g, "").slice(0, 12);
    if (!snippet) return false;
    const data = await this.msgList(0, 0, 5);
    const list = Array.isArray(data?.msglist) ? data.msglist : [];
    return list.some((item) => String(item.content ?? "").replace(/\s+/g, "").includes(snippet));
  }

  async like(tid, targetUin, { abstime = 0, dryRun = false, idempotencyKey = "" } = {}) {
    if (!tid) throw new Error("缺少动态 ID（tid）");
    const key = idempotencyKey || `like:${tid}`;
    if (dryRun) return { dryRun: true, tid, targetUin };
    const existing = one("select * from qzone_actions where idempotency_key = ?", [key]);
    if (existing && ["verified", "sent_unverified", "pending"].includes(existing.status)) {
      return { deduped: true, action: existing };
    }
    recordAction({ action: "like", tid, targetUin, idempotencyKey: key, request: { tid, targetUin, abstime } });
    try {
      const data = await this.client.call(
        "like_qzone",
        { tid: String(tid), ...(targetUin ? { target_uin: Number(targetUin) } : {}), abstime: Number(abstime) || 0 },
        { timeoutMs: 60000 },
      );
      // 空间接口返回的说说字段里没有「我赞过没有」，所以点赞只能停在 sent_unverified。
      // 这里不假装能核验——面板上会显示成「已发出，待核验」。
      const action = finishAction(key, { status: "sent_unverified", result: { data, likeVerifiable: false } });
      setCapability("like", "api_verified", "接口返回成功（点赞状态无法从消息里读回，只能人工确认）");
      return { ok: true, data, action, verified: false, likeVerifiable: false };
    } catch (error) {
      const info = classifyQzoneError(error?.message ?? error);
      finishAction(key, { status: "failed", result: { error: String(error?.message ?? error) } });
      throw new QzoneError(`点赞失败：${String(error?.message ?? error).slice(0, 200)}`, info);
    }
  }

  /**
   * 反馈核验：把某条说说读回来，看看评论有没有真的落上去。
   * 读不到就老实说读不到——不把 HTTP 200 当成社交结果（规划书 FR-604 的红线）。
   *
   * 注意：协议端返回的说说里只有评论「条数」，没有评论正文，
   * 所以这里用「条数是否增加」作为判据，而不是去匹配评论文本。
   */
  async verifyInteraction(tid, { baselineCount = null } = {}) {
    const data = await this.msgList(0, 0, 10);
    const list = Array.isArray(data?.msglist) ? data.msglist : [];
    const target = list.find((item) => String(item.tid) === String(tid));
    if (!target) return { found: false, commentVisible: false, commentCount: 0 };
    const comments = Array.isArray(target.commentlist) ? target.commentlist : [];
    const commentCount = Number(target.comment_num ?? comments.length ?? 0);
    return {
      found: true,
      commentCount,
      commentVisible: baselineCount === null ? commentCount > 0 : commentCount > Number(baselineCount),
      // 空间接口目前只在消息里回 comment_num，没有「我赞过没有」这个字段，
      // 所以点赞状态无法从这条通路核验，只能如实标成「已发出，待核验」。
      likeVisible: false,
      likeVerifiable: false,
    };
  }

  /** 读一条说说当前的评论数（作为核对基准）。 */
  async commentCountOf(tid) {
    try {
      const data = await this.msgList(0, 0, 10);
      const target = (data?.msglist ?? []).find((item) => String(item.tid) === String(tid));
      return target ? Number(target.comment_num ?? 0) : null;
    } catch {
      return null;
    }
  }

  async comment(tid, content, targetUin, { dryRun = false, idempotencyKey = "", verify = true } = {}) {
    if (!tid) throw new Error("缺少动态 ID（tid）");
    const text = String(content ?? "").trim().slice(0, 600);
    if (!text) throw new Error("评论内容不能为空");
    const key = idempotencyKey || `comment:${tid}:${text.slice(0, 12)}`;
    if (dryRun) return { dryRun: true, tid, content: text };
    const existing = one("select * from qzone_actions where idempotency_key = ?", [key]);
    if (existing && ["verified", "sent_unverified", "pending"].includes(existing.status)) {
      return { deduped: true, action: existing };
    }
    const baselineCount = verify ? await this.commentCountOf(tid) : null;
    recordAction({ action: "comment", tid, targetUin, idempotencyKey: key, request: { tid, content: text } });
    try {
      const data = await this.client.call(
        "comment_qzone",
        { tid: String(tid), content: text, ...(targetUin ? { target_uin: Number(targetUin) } : {}) },
        { timeoutMs: 120000 },
      );
      let verified = false;
      let observed = baselineCount;
      if (verify) {
        // 空间的读接口是最终一致的：评论数要过几秒才更新，所以轮询等待
        for (const wait of [1500, 2500, 4000, 6000]) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          try {
            const check = await this.verifyInteraction(tid, { baselineCount });
            observed = check.commentCount;
            if (check.commentVisible) {
              verified = true;
              break;
            }
          } catch {
            /* 读不到就继续等，最后如实标成待核验 */
          }
        }
      }
      const action = finishAction(key, {
        status: verified ? "verified" : "sent_unverified",
        result: { data, verified, baselineCount, observedCount: observed },
        verified,
      });
      setCapability("comment", verified ? "end_to_end_verified" : "api_verified", verified ? "已读到评论数真的增加了" : "接口返回成功，但没能读到页面确认");
      return { ok: true, data, action, verified };
    } catch (error) {
      const info = classifyQzoneError(error?.message ?? error);
      finishAction(key, { status: "failed", result: { error: String(error?.message ?? error) } });
      throw new QzoneError(`评论失败：${String(error?.message ?? error).slice(0, 200)}`, info);
    }
  }

  /** 删除自己发的一条说说（自检清理、发错了撤回都用它）。 */
  async remove(tid, { idempotencyKey = "" } = {}) {
    if (!tid) throw new Error("缺少动态 ID（tid）");
    const key = idempotencyKey || `delete:${tid}`;
    recordAction({ action: "delete", tid, idempotencyKey: key, request: { tid } });
    try {
      const data = await this.client.call("delete_qzone_msg", { tid: String(tid) }, { timeoutMs: 60000 });
      const action = finishAction(key, { status: "sent_unverified", result: { data } });
      const gone = await this.verifyDeleted(tid).catch(() => false);
      if (gone) finishAction(key, { status: "verified", result: { data, verified: true }, verified: true });
      setCapability("delete", gone ? "end_to_end_verified" : "api_verified", gone ? "已确认删除" : "接口返回成功");
      return { ok: true, data, action, verified: gone };
    } catch (error) {
      const info = classifyQzoneError(error?.message ?? error);
      finishAction(key, { status: "failed", result: { error: String(error?.message ?? error) } });
      throw new QzoneError(`删除说说失败：${String(error?.message ?? error).slice(0, 200)}`, info);
    }
  }

  /** 确认某条说说已经从列表里消失。 */
  async verifyDeleted(tid) {
    const data = await this.msgList(0, 0, 10);
    const list = Array.isArray(data?.msglist) ? data.msglist : [];
    return !list.some((item) => String(item.tid) === String(tid));
  }

  /* --------------------------- 文案生成 --------------------------- */

  async composePost({ character, topic = "", masterName = "指挥官" }) {
    const cfg = getConfig();
    const memoryItems = [];
    const result = await this.llm.chat(
      [
        {
          role: "system",
          content: [
            `你是《${character.source || "碧蓝航线"}》里的角色「${character.name}」，正在写一条 QQ 空间的说说。`,
            character.persona ? `人设：${character.persona}` : "",
            character.speechStyle ? `说话风格：${character.speechStyle}` : "",
            "要求：1~3 句，60~120 字，第一人称，像随手记下来的一点心情；不要用「今天真是美好的一天」这种模板句。",
            "不要写任何括号动作，不要提 AI 或模型，不要带话题标签。",
            topic ? `这次的写作提示：${topic}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        { role: "user", content: `现在是 ${new Date().toLocaleString("zh-CN")}，写一条说说。` },
      ],
      { task: "qzone", characterId: character.id, overrides: { maxTokens: 400 } },
    );
    const text = cleanReply(result.text).slice(0, 400);
    return { text, requestId: result.requestId, cost: result.usage?.cost ?? 0, memoryItems };
  }

  async composeComment({ character, post, masterName = "指挥官" }) {
    const cfg = getConfig();
    const style = cfg.qzone?.manualCommentStyle || "温柔自然，像在动态下关心一句，不要太长。";
    const result = await this.llm.chat(
      [
        {
          role: "system",
          content: [
            `你是「${character.name}」，正在给「${masterName}」的 QQ 空间动态写一句评论。`,
            character.speechStyle ? `说话风格：${character.speechStyle}` : "",
            `要求：${style}`,
            "只输出评论本身，不要引号，不要括号动作，不超过 40 字。",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        { role: "user", content: `动态内容：${String(post?.text ?? "").slice(0, 300)}` },
      ],
      { task: "qzone", characterId: character.id, overrides: { maxTokens: 200 } },
    );
    return cleanReply(result.text).slice(0, 120);
  }

  snapshot() {
    return {
      enabled: getConfig().qzone?.enabled === true,
      capabilities: listCapabilities(),
      actions: listActions({ limit: 40 }),
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      statusLabel: STATUS_LABEL,
    };
  }
}
