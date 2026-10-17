/**
 * 补回遗漏的消息（「我发出去了，但她那边没收到」的兜底）。
 *
 * 什么时候会漏：
 *   - 协议端的 WebSocket 短暂断开（哪怕只有几秒），那几秒里发的消息它不会补推；
 *   - 心语正在重启 / 电脑刚开机，协议端已经在收消息了，但业务还没连上；
 *   - 协议端自己偶尔丢事件。
 *
 * 协议端（SnowLuma / go-cqhttp 系）支持 `get_friend_msg_history`，
 * 所以每次连上之后主动把最近的好友私聊历史拉一遍，把库里没有的补进来：
 *   - 用 `private:<self>:<message_id>` 作为 event_key，重复拉取也不会写两遍；
 *   - 只补「别人发给我们的」，自己发的不补（那边本来就记着）；
 *   - 补回来的消息**不会触发回复**——它们是几分钟甚至几小时前的，回了才奇怪；
 *   - 补回来的会在审计里留痕（history_recovered），面板能看到补了几条。
 */
import { getConfig } from "./config.mjs";
import { normalizeEvent } from "./onebot.mjs";
import { insertMessage, ensureSession, ensureContact, messageCount } from "./storage.mjs";
import { all, audit } from "./db.mjs";
import { activeCharacterId } from "./config.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("Recover");

/** 最近活跃的私聊会话（补历史时只需要这几个）。 */
export function recentPrivateScopes(limit = 5) {
  try {
    // 注意：sessions 表的时间列叫 updated_at（不是 last_at），写错了会静默返回空数组
    return all("select scope_key from sessions where scope_key like 'private\\_%' escape '\\' order by updated_at desc limit ?", [limit])
      .map((row) => String(row.scope_key).replace(/^private_/, ""))
      .filter(Boolean);
  } catch (error) {
    log.warn(`读取最近私聊会话失败：${error?.message ?? error}`);
    return [];
  }
}

/**
 * 补某个好友的私聊历史。
 * 返回 { peerId, fetched, added, skipped }。
 */
export async function recoverPrivateFor({ client, peerId, count = 40, characterId = "" }) {
  const id = String(peerId ?? "").trim();
  if (!id) return { peerId: id, fetched: 0, added: 0, skipped: 0, error: "没有 peerId" };
  if (!client?.callHttp) return { peerId: id, fetched: 0, added: 0, skipped: 0, error: "协议端不可用" };

  let data;
  try {
    data = await client.callHttp("get_friend_msg_history", { user_id: Number(id) || id, count });
  } catch (error) {
    return { peerId: id, fetched: 0, added: 0, skipped: 0, error: String(error?.message ?? error).slice(0, 160) };
  }
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  if (!messages.length) return { peerId: id, fetched: 0, added: 0, skipped: 0 };

  const cfg = getConfig();
  const selfId = String(client.selfId ?? cfg.bot.selfId ?? "");
  const charId = characterId || activeCharacterId();
  let added = 0;
  let skipped = 0;

  for (const raw of messages) {
    const senderId = String(raw?.sender?.user_id ?? raw?.user_id ?? "");
    // 自己发的不补（我们的出站消息本来就落库了）
    if (!senderId || senderId === selfId) {
      skipped += 1;
      continue;
    }
    const normalized = normalizeEvent({ ...raw, post_type: "message", self_id: Number(selfId) || raw?.self_id }, selfId);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    const result = insertMessage({
      eventKey: normalized.eventId,
      platformMessageId: normalized.messageId,
      scopeKey: normalized.scopeKey,
      direction: "in",
      senderId: normalized.senderId,
      senderName: normalized.senderName,
      kind: "private",
      at: normalized.timestampMs,
      body: normalized.text || ((normalized.images ?? []).length ? "[图片]" : "[非文字内容]"),
      segments: normalized.segments,
      attachments: (normalized.images ?? []).map((image) => ({ type: "image", file: image.file, url: image.url })),
      traceId: `recover-${normalized.messageId}`,
      characterId: charId,
      accountId: selfId,
    });
    if (result?.duplicated) skipped += 1;
    else added += 1;
  }

  if (added) {
    ensureSession(`private_${id}`, { characterId: charId, accountId: selfId });
    ensureContact(id, { accountId: selfId, displayName: messages.find((m) => String(m?.sender?.user_id) === id)?.sender?.nickname ?? "" });
    audit({ eventType: "history_recovered", scopeKey: `private_${id}`, detail: { added, total: messages.length } });
    log.info(`补回了 ${added} 条之前没接到的消息（${id}，这一页共 ${messages.length} 条）`);
  }
  return { peerId: id, fetched: messages.length, added, skipped };
}

/**
 * 连上之后补一轮：主人 + 最近几个私聊会话。
 * 不会抛异常（补不回来只是少几条，不该影响正常收发）。
 */
export async function recoverMissedMessages({ client, extraPeers = [], count = 40 } = {}) {
  const cfg = getConfig();
  const master = String(cfg.bot.masterId ?? "").trim();
  const peers = [...new Set([...extraPeers.map(String), master, ...recentPrivateScopes(5)].filter(Boolean))];
  const results = [];
  for (const peerId of peers) {
    try {
      results.push(await recoverPrivateFor({ client, peerId, count }));
    } catch (error) {
      results.push({ peerId, added: 0, error: String(error?.message ?? error) });
    }
  }
  const added = results.reduce((sum, item) => sum + (item.added || 0), 0);
  return { peers: peers.length, added, results, messageCount: null };
}

export { messageCount };
