import { getConfig, activeCharacter } from "./config.mjs";
import { gate, ACTION, claimInteraction, noteReply, resetReplyQuota } from "./policy.mjs";
import { run } from "./db.mjs";

export function normalizeNotice(raw, selfId) {
  if (raw?.post_type !== "notice" || String(raw.self_id) !== String(selfId)) return null;
  const senderId = String(raw.sender_id || raw.user_id || "");
  if (!/^[1-9]\d*$/.test(senderId) || senderId === String(selfId)) return null;
  const groupId = raw.group_id && Number(raw.group_id) > 0 ? String(raw.group_id) : "";
  const base = {
    senderId,
    accountId: String(selfId),
    groupId,
    kind: groupId ? "group" : "private",
    scopeKey: groupId ? `group_${groupId}_${senderId}` : `private_${senderId}`,
    timestampMs: Number(raw.time) * 1000 || Date.now(),
    senderName: "",
    images: [],
    files: [],
    segments: [],
    isMention: false,
  };
  if (raw.notice_type === "notify" && raw.sub_type === "input_status" && !groupId) {
    return {
      ...base,
      eventType: "typing",
      typing: Number(raw.event_type) === 1 && !/取消|停止/.test(String(raw.status_text || "")),
    };
  }
  let eventType = "";
  if (raw.notice_type === "notify" && raw.sub_type === "poke" && String(raw.target_id) === String(selfId))
    eventType = "poke";
  if (raw.notice_type === "group_increase" && groupId) eventType = "welcome";
  if (!eventType) return null;
  const id = `notice:${selfId}:${groupId}:${eventType}:${senderId}:${raw.time || Date.now()}:${raw.message_id || ""}`;
  return {
    ...base,
    eventType,
    eventId: id,
    messageId: id,
    traceId: id,
    text: eventType === "poke" ? "[对方戳了戳你]" : "[新成员入群]",
  };
}

export class InteractionService {
  constructor({ client, chat, tb }) {
    this.client = client;
    this.chat = chat;
    this.tb = tb;
  }

  async receive(raw) {
    const cfg = getConfig();
    const event = normalizeNotice(raw, cfg.bot.selfId);
    if (!event) return false;
    if (event.eventType === "typing") {
      this.chat.noteTyping(event);
      return true;
    }
    if (event.eventType === "welcome") {
      await this.tb?.welcome(event);
      return true;
    }
    const character = activeCharacter();
    const defaults = { ...cfg.interaction.poke, ...(character.poke || {}) };
    const settings = { ...defaults, ...(defaults.groups?.[event.groupId] || {}) };
    if (!(event.kind === "private" ? settings.privateEnabled : settings.groupEnabled)) return true;
    if (gate(event, { characterId: character.id }).action !== ACTION.REPLY) return true;
    if (
      !claimInteraction(
        `poke:${character.id}:${event.kind}:${event.groupId}:${event.senderId}`,
        Math.max(3, Number(settings.cooldownSec) || 15),
      )
    )
      return true;
    if (!claimInteraction(`event:${event.eventId}`, 86400)) return true;
    const text = String(settings.text || "我在。").slice(0, 500);
    const result = await this.chat.deliverEvent(event, text, { generated: settings.mode === "persona" });
    if (result.ok) noteReply({ kind: event.kind, groupId: event.groupId, peerId: event.senderId, eventType: "poke" });
    return true;
  }

  async adminCommand(event) {
    if (event.kind !== "group" || !event.isMention) return false;
    const match = /^(重置额度|豁免额度|取消豁免)\s+([1-9]\d*)\s*$/.exec(String(event.text).trim());
    if (!match) return false;
    const cfg = getConfig();
    const enabled = match[1] === "重置额度" ? cfg.interaction.adminReset : cfg.interaction.adminExempt;
    if (
      !enabled ||
      gate({ ...event, eventType: "admin" }, { characterId: cfg.activeCharacter }).action !== ACTION.REPLY
    )
      return true;
    const member = await this.client.getGroupMemberInfo(event.groupId, event.senderId);
    if (!["owner", "admin"].includes(member?.role)) return true;
    const now = getConfig();
    if (
      now.activeCharacter !== cfg.activeCharacter ||
      !(match[1] === "重置额度" ? now.interaction.adminReset : now.interaction.adminExempt)
    )
      return true;
    if (gate({ ...event, eventType: "admin" }, { characterId: cfg.activeCharacter }).action !== ACTION.REPLY)
      return true;
    if (!claimInteraction(`admin:${event.groupId}:${event.senderId}`, 5)) return true;
    if (match[1] === "重置额度") resetReplyQuota(event.groupId, match[2]);
    else if (match[1] === "豁免额度")
      run("insert or ignore into quota_exemptions values(?, ?, ?)", [cfg.activeCharacter, event.groupId, match[2]]);
    else
      run("delete from quota_exemptions where character_id = ? and group_id = ? and peer_id = ?", [
        cfg.activeCharacter,
        event.groupId,
        match[2],
      ]);
    await this.chat.deliverEvent({ ...event, eventType: "admin" }, `已${match[1]}：${match[2]}。`);
    return true;
  }
}
