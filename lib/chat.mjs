/**
 * 会话编排（规划书 06、12.2、15.6、FR-105）。
 *
 * 一次完整链路：
 *   OneBot 事件 → 标准化 → 幂等入箱 → Policy Gate → 预算闸门 → 记忆检索 →
 *   分层 Prompt → 模型生成 → 拆气泡 → 发送前复核 → 发送 → 落库/审计
 *
 * 关键事务分界：事件先入库去重；生成是异步的；发送成功后才把「已发送」提交。
 * 发送状态不确定时进入 unknown 待核验，绝不盲目重发。
 */
import { getConfig, activeCharacter, activeCharacterId, saveConfig, replyStyle } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { cleanReply, splitBubbles, stripEmoji, formatNow, inQuietHours, sleep, estimateTokens } from "./util.mjs";
import { ACTION, gate, preflight, noteReply, pauseState, checkBlocked, rateCheck } from "./policy.mjs";
import { checkBudget } from "./budget.mjs";
import { run, one, audit } from "./db.mjs";
import {
  ensureSession,
  ensureContact,
  insertMessage,
  recentMessages,
  scopeLabel,
  resolveMemberPolicy,
  getSession,
} from "./storage.mjs";
import { rememberQuick } from "./memory.mjs";
import { promptBlock, nudgeState, updateRelationship, addGoal, contextFor } from "./life.mjs";
import { forecast, buildAlerts, selectedAlerts, promptBlockFor, cachedWeatherBlock } from "./weather.mjs";

const log = createLogger("Chat");

const MAX_IMAGES_PER_MESSAGE = 3;

/** 「记住：xxx」指令（否定预查挡掉「记下了」这类回应）。 */
export function parseFactCommand(text) {
  const raw = String(text ?? "").trim();
  const match = /^(?:请?记住|记一下|记下|记牢|帮我记住)(?![来了过])\s*[:：,，]?\s*(.+)$/.exec(raw);
  if (!match) return null;
  const fact = match[1].replace(/^[,，。.、\s]+/, "").trim();
  return fact.length >= 2 && fact.length <= 120 ? fact : null;
}

/* ---------------------------- 群聊多消息合并 ---------------------------- */

/**
 * 群内连续消息聚合（规划书 15.6）：在窗口内把同一个群的相关消息合成一个上下文快照，
 * 窗口到期后只做一次策略判定与一次生成，避免每条普通消息都触发独立模型调用。
 * 黑名单与屏蔽词判定在合并前就已经完成（在 gate 里）。
 */
export class GroupMergeBuffer {
  constructor({ windowMs = 8000, maxMessages = 8, onFlush }) {
    this.windowMs = windowMs;
    this.maxMessages = maxMessages;
    this.onFlush = onFlush;
    this.buffers = new Map();
  }

  get size() {
    return this.buffers.size;
  }

  push(event) {
    const key = `group_${event.groupId}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = { key, groupId: event.groupId, messages: [], timer: null, startedAt: Date.now() };
      this.buffers.set(key, buffer);
    }
    buffer.messages.push(event);
    buffer.lastAt = Date.now();
    if (buffer.timer) clearTimeout(buffer.timer);
    const flush = () => this.#flush(key);
    if (buffer.messages.length >= this.maxMessages) {
      clearTimeout(buffer.timer);
      flush();
      return;
    }
    buffer.timer = setTimeout(flush, this.windowMs);
    buffer.timer.unref?.();
  }

  #flush(key) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);
    if (buffer.timer) clearTimeout(buffer.timer);
    if (!buffer.messages.length) return;
    const merged = {
      ...buffer.messages[buffer.messages.length - 1],
      mergedMessages: buffer.messages.map((item) => ({ senderId: item.senderId, senderName: item.senderName, text: item.text, at: item.timestampMs })),
      text: buffer.messages.map((item) => item.text).filter(Boolean).join("\n"),
      isMention: buffer.messages.some((item) => item.isMention),
      images: buffer.messages.flatMap((item) => item.images ?? []),
      messageIds: buffer.messages.map((item) => item.messageId),
      traceId: buffer.messages[0].traceId,
    };
    Promise.resolve(this.onFlush(merged)).catch((error) => log.error(`合并消息处理失败：${error?.message ?? error}`));
  }

  clear() {
    for (const buffer of this.buffers.values()) if (buffer.timer) clearTimeout(buffer.timer);
    this.buffers.clear();
  }
}

/* ------------------------------ 对话引擎 ------------------------------ */

export class ChatEngine {
  constructor({ client, llm, life, scheduler, onReply }) {
    this.client = client;
    this.llm = llm;
    this.life = life;
    this.scheduler = scheduler;
    this.onReply = onReply ?? (() => {});
    this.busy = new Set();
    this.lastReply = null;
    this.followTimers = new Set();
    this.mergeBuffer = new GroupMergeBuffer({
      windowMs: Math.max(0, Number(getConfig().chat.groupMergeWindowSec) || 8) * 1000,
      onFlush: (merged) => this.handle(merged),
    });
    this.decisions = [];
  }

  character() {
    return activeCharacter();
  }

  /** 记录一次准入判定，面板「决策审计」可查（FR-207）。 */
  #noteDecision(entry) {
    this.decisions.unshift({ at: Date.now(), ...entry });
    this.decisions = this.decisions.slice(0, 200);
  }

  /** 从一条真实消息提取可执行的上下文（含合并消息）。 */
  buildContext({ event, character }) {
    const cfg = getConfig();
    const scopeKey = event.scopeKey;
    const history = recentMessages(scopeKey, Math.max(2, Number(cfg.chat.historyTurns) || 16) * 2).map((row) => ({
      role: row.direction === "out" ? "assistant" : "user",
      content: row.body,
    }));

    const query = event.text || "";
    const memory = promptBlock({
      characterId: character.id,
      scopeKey,
      query,
      subjectId: event.senderId,
      masterId: cfg.bot.masterId,
      masterName: cfg.bot.masterName,
      accountId: event.accountId,
    });

    const memberPolicy = resolveMemberPolicy({ characterId: character.id, groupId: event.groupId || "*", peerId: event.senderId });
    const cfgMaster = cfg.bot.masterId;
    const isMaster = String(event.senderId) === String(cfgMaster);
    const who = isMaster ? cfg.bot.masterName || "指挥官" : event.senderName || `QQ ${event.senderId}`;

    const relationshipLines = [];
    if (event.kind === "group") {
      const groupName = event.groupName || "";
      relationshipLines.push(`你正在群 ${event.groupId}${groupName ? `（${groupName}）` : ""} 里说话，@你的这个人是「${who}」。`);
      if (memberPolicy.attitude) relationshipLines.push(`你对 ta 的态度：${memberPolicy.attitude}。`);
      if (memberPolicy.note) relationshipLines.push(`关于 ta 你要记住：${memberPolicy.note}。`);
      if (memberPolicy.nickname) relationshipLines.push(`你称呼 ta 为「${memberPolicy.nickname}」。`);
      relationshipLines.push("群里说话要短，不要在群里提私聊里的私事。");
    } else {
      relationshipLines.push(`你在和「${who}」私聊。`);
      if (memberPolicy.attitude) relationshipLines.push(`你对 ta 的态度：${memberPolicy.attitude}。`);
      else if (isMaster) relationshipLines.push("这是你最喜欢的人，语气可以亲昵、可以撒娇。");
      if (memberPolicy.note) relationshipLines.push(`关于 ta 你要记住：${memberPolicy.note}。`);
      if (memberPolicy.nickname) relationshipLines.push(`你称呼 ta 为「${memberPolicy.nickname}」。`);
    }

    const extras = [`【环境】现在是 ${formatNow()}。`];
    if (inQuietHours(cfg.chat.quietHours)) {
      extras.push("现在是深夜，对方这个点还没睡，语气要更轻更软一点，可以小小地念叨他一句。");
    }
    const lifeState = contextFor({
      characterId: character.id,
      scopeKey,
      query,
      subjectId: event.senderId,
      masterId: cfg.bot.masterId,
      masterName: cfg.bot.masterName,
    }).state;
    if (lifeState) extras.push(`【你自己的状态】此刻你${lifeState.mood}，${lifeState.energy}。`);
    if (cfg.llm.systemSuffix) extras.push(cfg.llm.systemSuffix);
    if (event.mergedMessages?.length > 1) {
      extras.push("对方连着发了好几条，你要把这几条当成一口气说完的话来理解，只回一次，不要一条条回。");
    }

    const userText = this.composeUserText(event);
    const weatherBlock = getConfig().weather?.enabled === false ? "" : cachedWeatherBlock();

    return {
      scopeKey,
      history,
      memory,
      relationship: relationshipLines.join("\n"),
      extras: extras.filter(Boolean).join("\n"),
      userText,
      who,
      isMaster,
      memberPolicy,
      facts: [],
      query,
      weatherBlock,
    };
  }

  composeUserText(event) {
    const text = String(event.text ?? "").trim();
    const hasImages = (event.images ?? []).length > 0;
    if (event.mergedMessages?.length > 1) {
      return event.mergedMessages
        .map((item) => `${item.senderName || item.senderId}：${item.text || "[图片]等非文字内容"}`)
        .join("\n");
    }
    if (text) return text;
    if (hasImages) return "（对方发来一张图片，没有配文字）";
    if (event.hasFace) return "（对方发了个表情）";
    return "（对方发来一条只有非文字内容的消息）";
  }

  /** 只生成不发送（面板试聊与真实聊天共用）。 */
  async generate({ event, images = [], character = null }) {
    const cfg = getConfig();
    const target = character ?? this.character();
    const ctx = this.buildContext({ event, character: target });
    const budgetScope = event.kind === "group" ? "group" : "private";
    const style = replyStyle();

    const result = await this.llm.speak(target, ctx.userText, {
      task: "chat",
      history: ctx.history,
      facts: ctx.facts,
      extra: ctx.extras,
      relationship: ctx.relationship,
      memory: ctx.memory.block,
      masterName: ctx.isMaster ? cfg.bot.masterName || "指挥官" : ctx.who,
      images,
      isGroup: event.kind === "group",
      scopeKey: ctx.scopeKey,
      characterId: target.id,
      budgetScope,
      style,
      weatherBlock: ctx.weatherBlock,
    });

    const rawBubbles = splitBubbles(result.text, {
      maxChars: style.maxChars,
      maxBubbles: style.maxBubbles,
      enabled: cfg.chat.splitBubbles,
    });
    const bubbles = cfg.chat.useEmoji === false ? rawBubbles.map(stripEmoji).filter(Boolean) : rawBubbles;

    return {
      character: target,
      bubbles,
      raw: result.text,
      requestId: result.requestId,
      usage: result.usage,
      context: ctx,
      style,
    };
  }

  /** 处理一条（可能已合并的）真实消息。 */
  async handle(event) {
    const cfg = getConfig();
    const character = this.character();
    const decision = gate(event, { characterId: character.id });
    this.#noteDecision({
      scopeKey: event.scopeKey,
      senderId: event.senderId,
      preview: String(event.text ?? "").slice(0, 60),
      action: decision.action,
      reason: decision.reason,
      trace: decision.trace,
    });

    if (decision.action === ACTION.SILENT || decision.action === ACTION.SKIP) {
      log.debug(`不回复（${decision.reason}）`, { scope: event.scopeKey });
      return { replied: false, reason: decision.reason };
    }

    // 入箱：无论回不回，先把真实消息落库（审计与检索都要用）
    const stored = insertMessage({
      eventKey: event.eventId,
      platformMessageId: event.messageId,
      scopeKey: event.scopeKey,
      direction: "in",
      senderId: event.senderId,
      senderName: event.senderName,
      kind: event.kind,
      at: event.timestampMs,
      body: event.text || (event.images?.length ? "[图片]" : "[非文字内容]"),
      segments: event.segments,
      attachments: (event.images ?? []).map((image) => ({ type: "image", file: image.file, url: image.url })),
      isMention: event.isMention,
      replyTo: event.replyTo,
      traceId: event.traceId,
      characterId: character.id,
      accountId: event.accountId,
    });
    ensureContact(event.senderId, { accountId: event.accountId, displayName: event.senderName });
    if (stored.duplicated) log.debug(`重复事件已忽略：${event.eventId}`);

    // 用户回话了：清掉「未回复计数」，状态往好的方向走一点
    if (event.kind === "private") this.scheduler?.noteUserReply?.(event.senderId);

    if (decision.action === ACTION.WARN) {
      return this.#handleModeration(event, decision);
    }

    // 「记住：xxx」快捷指令
    const fact = cfg.chat.rememberFacts ? parseFactCommand(event.text) : null;
    if (fact && !(event.images ?? []).length) {
      const added = rememberQuick({
        scopeKey: event.scopeKey,
        text: fact,
        peerId: event.senderId,
        characterId: character.id,
      });
      const template = character.rememberReplyTemplate || `嗯嗯，${character.name}记下啦——{fact}。以后再也不会忘记了呢。`;
      const reply = String(template).replaceAll("{fact}", fact).replaceAll("{name}", character.name);
      await this.#deliverBubbles(event, [reply], { character });
      return { replied: true, remembered: fact, memoryId: added?.id ?? null };
    }

    if (this.busy.has(event.scopeKey)) {
      log.debug("上一条还在处理中，跳过");
      return { replied: false, reason: "busy" };
    }
    this.busy.add(event.scopeKey);
    try {
      const images = await this.collectImages(event);
      const { bubbles, usage, requestId, context, style } = await this.generate({ event, images, character });
      if (!bubbles.length) return { replied: false, reason: "空回复" };

      const sent = await this.#deliverBubbles(event, bubbles, { character, traceId: event.traceId });
      if (!sent.ok) return sent;

      noteReply({ kind: event.kind, groupId: event.groupId, peerId: event.senderId });
      this.#afterReply({ event, character, usage, requestId, context });
      this.lastReply = { at: Date.now(), scopeKey: event.scopeKey, bubbles };
      this.onReply({ event, bubbles, usage, requestId });
      // 活跃度够高时，隔几秒再主动补一句（「主动继续发起对话」）
      const followUp = this.#scheduleFollowUp({ event, character, bubbles, style, context });
      return { replied: true, bubbles, usage, followUp };
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`生成/发送失败：${message}`);
      audit({ eventType: "reply_failed", scopeKey: event.scopeKey, reason: message, traceId: event.traceId });
      return { replied: false, reason: message };
    } finally {
      this.busy.delete(event.scopeKey);
    }
  }

  async #handleModeration(event, decision) {
    const cfg = getConfig();
    const character = this.character();
    const filter = cfg.group?.filter ?? {};
    let warnText = decision.warnText;
    if (!warnText) {
      warnText = await this.#buildWarnText({ word: decision.hit?.word ?? "", name: event.senderName, groupId: event.groupId });
    }
    try {
      const isGroup = event.kind === "group";
      // 警告语是给对方的最后一次提示：即使刚被拉黑也要发出去；
      // 真正被拉黑的人，之后连 gate 都过不了，不会有第二条消息。
      if (warnText) {
        if (isGroup) await this.client.sendGroupMsg(event.groupId, warnText);
        else await this.client.sendPrivateMsg(event.senderId, warnText);
        run(
          `insert or ignore into outgoing(idempotency_key, scope_key, kind, target_id, body, reason, status, attempts, created_at, sent_at)
           values(?, ?, ?, ?, ?, 'moderation_warn', 'sent', 1, ?, ?)`,
          [`warn:${event.messageId}`, event.scopeKey, event.kind, isGroup ? event.groupId : event.senderId, warnText, Date.now(), Date.now()],
        );
      }
      if (decision.blocked && filter.notifyMaster !== false) {
        const master = String(cfg.bot.masterId ?? "");
        if (master) {
          const where = isGroup ? `群 ${event.groupId}` : "私聊";
          const note = `[群管] 我把 ${event.senderName || event.senderId}（${event.senderId}）拉黑了，因为 ta 在${where}说了「${decision.hit?.word}」。（第 ${decision.moderation?.count ?? 1} 次触发屏蔽词）`;
          await this.client.sendPrivateMsg(master, note).catch((error) => log.warn(`通知管理员失败：${error?.message ?? error}`));
        }
      }
      audit({
        eventType: decision.blocked ? "moderation_block" : "moderation_warn",
        scopeKey: event.scopeKey,
        actor: event.senderId,
        reason: decision.reason,
        detail: { word: decision.hit?.word, count: decision.moderation?.count },
      });
      return { replied: true, warned: true, blocked: Boolean(decision.blocked), reason: decision.reason };
    } catch (error) {
      log.warn(`发警告失败：${error?.message ?? error}`);
      return { replied: false, reason: String(error?.message ?? error) };
    }
  }

  async #buildWarnText({ word, name, groupId }) {
    const cfg = getConfig();
    const character = this.character();
    const filter = cfg.group?.filter ?? {};
    const fill = (template) =>
      String(template ?? "")
        .replaceAll("{word}", word ?? "")
        .replaceAll("{name}", name || "这位群友")
        .replaceAll("{group}", String(groupId ?? ""))
        .replaceAll("{char}", character.name);
    if (filter.warnSource === "custom" || filter.warnSource === "fixed" || !filter.warnSource) {
      return fill(filter.warnText) || `……这句话${character.name}不太想接呢。`;
    }
    if (filter.warnSource === "template") {
      return fill(filter.warnTemplate || "{name}，别说「{word}」这种话啦。");
    }
    try {
      const prompt = fill(filter.warnTemplate || `以${character.name}的口吻，用一句话提醒对方不要在群里说「{word}」这类话。一句就好。`);
      const result = await this.llm.speak(character, prompt, {
        task: "moderation",
        history: [],
        facts: [],
        extra: "这是对群里某个群友的提醒。不要写括号动作，不要提到规则或屏蔽词，不要超过 40 字。",
        overrides: { maxTokens: 220 },
        scopeKey: "moderation",
      });
      const text = cleanReply(result.text).slice(0, 80);
      if (text) return text;
    } catch (error) {
      log.warn(`让模型写提醒失败，改用固定文案：${error?.message ?? error}`);
    }
    return fill(filter.warnText) || `……这句话${character.name}不太想接呢。`;
  }

  /** 发送：带打字节奏、发送前复核、出站落库、状态未知不重发。 */
  async #deliverBubbles(event, bubbles, { character, traceId = "" }) {
    const cfg = getConfig();
    const isGroup = event.kind === "group";
    const targetId = isGroup ? event.groupId : event.senderId;
    for (const [index, bubble] of bubbles.entries()) {
      if (cfg.chat.preflightCheck) {
        const check = preflight({ kind: event.kind, groupId: event.groupId, peerId: event.senderId, characterId: character.id });
        if (!check.ok) {
          log.warn(`发送前复核未通过，本条不再发出：${check.reason}`);
          return { ok: false, reason: check.reason };
        }
      }
      const delay = index === 0 ? Number(cfg.chat.firstDelayMs) || 0 : Math.min(2500, 300 + bubble.length * 12);
      if (delay > 0) await sleep(Math.max(0, delay) * (index === 0 ? 1 : 1));
      const idempotencyKey = `reply:${event.messageId}:${index}`;
      const key = idempotencyKey;
      run(
        `insert or ignore into outgoing(idempotency_key, scope_key, kind, target_id, body, reason, status, trace_id, created_at)
         values(?, ?, ?, ?, ?, 'reply', 'pending', ?, ?)`,
        [key, event.scopeKey, event.kind, String(targetId), bubble, traceId, Date.now()],
      );
      try {
        const sent = isGroup
          ? await this.client.sendGroupMsg(event.groupId, bubble, { idempotencyKey: `msg:${key}` })
          : await this.client.sendPrivateMsg(event.senderId, bubble, { idempotencyKey: `msg:${key}` });
        run("update outgoing set status = 'sent', attempts = attempts + 1, platform_message_id = ?, sent_at = ? where idempotency_key = ?", [
          String(sent?.message_id ?? ""),
          Date.now(),
          key,
        ]);
        insertMessage({
          eventKey: `out:${key}`,
          platformMessageId: String(sent?.message_id ?? ""),
          scopeKey: event.scopeKey,
          direction: "out",
          senderId: event.accountId,
          senderName: character.name,
          kind: event.kind,
          at: Date.now(),
          body: bubble,
          status: "sent",
          traceId,
          characterId: character.id,
          accountId: event.accountId,
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        run("update outgoing set status = 'unknown', attempts = attempts + 1, error = ? where idempotency_key = ?", [
          message.slice(0, 300),
          key,
        ]);
        log.warn(`这条没发出去（状态未知，不自动重发）：${message}`);
        return { ok: false, reason: message };
      }
    }
    return { ok: true, sent: bubbles.length };
  }

  /**
   * 追一句（对话活跃度的一部分）。
   *
   * 「活跃度」高的时候，她回完不会就此停下，而是隔几秒再补一条，
   * 像一个真人在 QQ 上聊着聊着又想起什么。几条硬规矩：
   *   - 只在私聊里追，群里追话等于刷屏；
   *   - 概率 = 设置里的概率 × 活跃度，活跃度低就直接不追；
   *   - 只追一条（maxPerTurn），而且内容必须跟刚才那轮有关；
   *   - 静默时段、暂停、被拉黑、预算超限一律不追（走 scheduler.deliver 的闸门）。
   */
  #scheduleFollowUp({ event, character, bubbles, style, context }) {
    const cfg = getConfig();
    if (!style?.followUpEnabled || style.followUpMaxPerTurn < 1) return { scheduled: false, reason: "未开启追话" };
    if (event.kind !== "private") return { scheduled: false, reason: "群里不追话" };
    if (!this.scheduler?.deliver) return { scheduled: false, reason: "没有投递通道" };
    if (inQuietHours(cfg.chat.quietHours)) return { scheduled: false, reason: "静默时段" };
    if (Math.random() >= style.followUpChance) return { scheduled: false, reason: `这次不追（概率 ${(style.followUpChance * 100).toFixed(0)}%）` };

    const peerId = String(event.senderId);
    const turnKey = `followup:${event.messageId}:1`;
    const delayMs = Math.max(2, style.followUpDelaySec) * 1000;
    const timer = setTimeout(async () => {
      this.followTimers.delete(timer);
      try {
        if (pauseState.paused) return;
        const prompt = [
          `你刚才已经给对方发过：${bubbles.join(" / ")}`,
          "现在再补一句，就像聊着聊着又想起一件事。",
          "要求：只一句，很短；不要重复刚才说过的话，不要连着问问题，不要写括号动作。",
          "直接输出要发的内容。",
        ].join("\n");
        const result = await this.llm.speak(character, prompt, {
          task: "chat",
          history: [],
          facts: [],
          extra: "这是你主动补的一句，不是回复对方的新消息。",
          masterName: cfg.bot.masterName || "指挥官",
          scopeKey: event.scopeKey,
          characterId: character.id,
          budgetScope: "private",
          weatherBlock: context?.weatherBlock || "",
          style: { ...style, activity: 25, maxBubbles: 1, wantBubbles: 1, instruction: "只回一句，30 字以内。" },
        });
        let text = cleanReply(result.text, { characterName: character.name }).slice(0, 90);
        if (cfg.chat.useEmoji === false) text = stripEmoji(text);
        if (!text) return;
        const sent = await this.scheduler.deliver({ peerId, text, kind: "followup", idempotencyKey: turnKey });
        if (sent) {
          this.lastReply = { at: Date.now(), scopeKey: event.scopeKey, bubbles: [text] };
          nudgeState(character.id, { socialDrive: -0.01, valence: 0.02 });
          this.onReply({ event, bubbles: [text], usage: result.usage, requestId: result.requestId, followUp: true });
        }
      } catch (error) {
        log.debug(`追一句失败（不影响本轮回复）：${error?.message ?? error}`);
      }
    }, delayMs);
    timer.unref?.();
    this.followTimers.add(timer);
    return { scheduled: true, afterMs: delayMs, key: turnKey };
  }

  /** 回复后的副作用：状态、关系、约定、归档触发。 */
  #afterReply({ event, character, usage, requestId, context }) {
    try {
      nudgeState(character.id, {
        valence: event.kind === "private" ? 0.05 : 0.02,
        energy: -0.01,
        socialDrive: event.kind === "private" ? 0.04 : 0.01,
      });
      const cfg = getConfig();
      if (cfg.life?.relationship?.enabled !== false) {
        updateRelationship({
          characterId: character.id,
          accountId: event.accountId,
          contextId: event.scopeKey,
          subjectId: event.senderId,
          delta: event.kind === "private" ? { familiarity: 0.03, affection: 0.02, trust: 0.01 } : { familiarity: 0.01 },
        });
      }
      const commitment = /(记得|别忘了|说好了|答应|明天|下周|到时候)/.test(String(event.text ?? ""));
      if (commitment && context?.who) {
        addGoal({
          characterId: character.id,
          scopeKey: event.scopeKey,
          kind: "followup",
          content: String(event.text ?? "").slice(0, 120),
        });
      }
      if (usage) {
        audit({
          eventType: "reply_sent",
          scopeKey: event.scopeKey,
          actor: character.id,
          detail: { cost: usage.cost, tokens: usage.tokensIn + usage.tokensOut, requestId },
          traceId: event.traceId,
        });
      }
    } catch (error) {
      log.warn(`回复后处理失败（不影响回复）：${error?.message ?? error}`);
    }
  }

  async collectImages(event) {
    const cfg = getConfig();
    const limit = Math.max(1, Math.min(MAX_IMAGES_PER_MESSAGE, Number(cfg.chat.maxImagesPerMessage) || 3));
    const list = (event.images ?? []).slice(0, limit);
    if (!list.length) return [];
    if (!this.client?.downloadImage) return [];
    const out = [];
    for (const image of list) {
      try {
        const { dataUrl, source } = await this.client.downloadImage(image, { maxBytes: Number(cfg.chat.imageMaxBytes) || 8388608 });
        out.push(dataUrl);
        log.debug(`图片已取到（来源 ${source}，约 ${(dataUrl.length / 1024).toFixed(0)} KB）`);
      } catch (error) {
        log.warn(`图片取不到，这条只按文字回：${error?.message ?? error}`);
      }
    }
    return out;
  }

  /** 入口：真实事件进来先做「合并 or 直接处理」。 */
  async receive(event) {
    const cfg = getConfig();
    if (pauseState.paused) return { replied: false, reason: "自动化已暂停" };
    if (event.kind === "group" && Number(cfg.chat.groupMergeWindowSec) > 0) {
      // @ 我的消息不进合并窗口，立即响应（优先级更高）
      if (event.isMention) return this.handle(event);
      this.mergeBuffer.push(event);
      return { queued: true };
    }
    return this.handle(event);
  }

  snapshot() {
    const cfg = getConfig();
    return {
      lastReply: this.lastReply,
      busy: [...this.busy],
      merging: this.mergeBuffer.size,
      decisions: this.decisions.slice(0, 60),
      replyPrivate: cfg.chat.replyPrivate,
      replyGroupAt: cfg.chat.replyGroupAt,
      replyGroupAll: cfg.chat.replyGroupAll,
      quietHours: cfg.chat.quietHours,
      budget: checkBudget(),
    };
  }

  /** 面板试聊：不发送到 QQ。 */
  async sandbox({ text, images = [], scopeKey = "panel_sandbox", peerId = "" }) {
    const cfg = getConfig();
    const now = Date.now();
    const event = {
      eventId: `sandbox:${now}`,
      platform: "qq",
      accountId: String(this.client?.selfId ?? cfg.bot.selfId),
      scopeType: "sandbox",
      scopeId: scopeKey,
      scopeKey,
      kind: "private",
      senderId: String(peerId || cfg.bot.masterId || "sandbox"),
      senderName: cfg.bot.masterName,
      groupId: "",
      messageId: `sandbox-${now}`,
      timestampMs: now,
      segments: [],
      text: String(text ?? ""),
      images: [],
      isMention: false,
      hasFace: false,
      traceId: `sandbox-${now}`,
    };
    const { bubbles, usage, requestId } = await this.generate({ event, images });
    insertMessage({
      eventKey: event.eventId,
      scopeKey,
      direction: "in",
      senderId: event.senderId,
      kind: "private",
      at: now,
      body: event.text || "[图片]",
      traceId: event.traceId,
    });
    insertMessage({
      eventKey: `out:${event.eventId}`,
      scopeKey,
      direction: "out",
      senderId: event.accountId,
      kind: "private",
      at: Date.now(),
      body: bubbles.join("\n"),
      traceId: event.traceId,
    });
    return { bubbles, usage, requestId, note: "这是试聊，没有发到 QQ" };
  }

  stop() {
    this.mergeBuffer.clear();
    for (const timer of this.followTimers) clearTimeout(timer);
    this.followTimers.clear();
  }
}

export { scopeLabel, getSession, getConfig, activeCharacterId, saveConfig, estimateTokens, one, ensureSession, checkBlocked };
