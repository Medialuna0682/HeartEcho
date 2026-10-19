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
import fs from "node:fs";
import { audienceFor } from "./privacy.mjs";
import { scopeGeneration, isCurrentScope, drainScopeSends, trackScopeSend } from "./scope-lifecycle.mjs";
import path from "node:path";
import { getConfig, activeCharacter, activeCharacterId, saveConfig, replyStyle } from "./config.mjs";
import { paths } from "./paths.mjs";
import { createLogger } from "./log.mjs";
import { cleanReply, splitBubbles, stripEmoji, formatNow, inQuietHours, sleep, estimateTokens, isStallReply } from "./util.mjs";
import { ACTION, gate, preflight, noteReply, pauseState, checkBlocked, rateCheck } from "./policy.mjs";
import { checkBudget } from "./budget.mjs";
import { run, one, audit } from "./db.mjs";
import {
  clearMessages,
  assertScopeKey,
  ensureSession,
  ensureContact,
  insertMessage,
  recentMessages,
  scopeLabel,
  resolveMemberPolicy,
  getSession,
} from "./storage.mjs";
import { rememberQuick, pinnedFacts } from "./memory.mjs";
import { extractText, windowText, sanitizeFileName, extensionOf, formatSize } from "./files.mjs";
import { promptBlock, nudgeState, updateRelationship, addGoal, contextFor } from "./life.mjs";
import { forecast, buildAlerts, selectedAlerts, promptBlockFor, cachedWeatherBlock, detectWeatherFeedback, recordWeatherFeedback, recordWeatherMention, weatherFeedbackBlock, isWeatherMuted } from "./weather.mjs";

const log = createLogger("Chat");

const MAX_IMAGES_PER_MESSAGE = 3;
/** 同一会话最多攒几条待处理消息（防止有人狂刷把内存和费用顶爆）。 */
const MAX_PENDING_PER_SCOPE = 6;

/**
 * 判「这句话在聊天气」用的两套词表。
 *
 * strict 用于「静音时把带天气的句子摘掉」——宁可漏判也不能把普通句子删掉，
 * 所以只放几乎不会误伤的词（雨、伞、天气、降温……），不放「热」「冷」「风」「度」
 * 这种日常用语（「热情」「态度」会被误杀）。
 * broad 用于「她这句算不算提过天气」，宽一点没关系。
 */
const WEATHER_TALK = /(下雨|小雨|中雨|大雨|暴雨|阵雨|雷雨|雷阵雨|雨伞|带伞|伞|下雪|雪天|天气|气温|降温|升温|转凉|多穿|加衣|淋湿|℃|零下|潮湿)/;
const WEATHER_TALK_BROAD = new RegExp(WEATHER_TALK.source + "|热|冷|晒|风|度");

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
      sourceGenerations: buffer.messages.map((item) => ({ scopeKey: item.scopeKey, generation: item.scopeGeneration })),
      mergedMessages: buffer.messages.map((item) => ({ senderId: item.senderId, senderName: item.senderName, text: item.text, at: item.timestampMs })),
      text: buffer.messages.map((item) => item.text).filter(Boolean).join("\n"),
      isMention: buffer.messages.some((item) => item.isMention),
      images: buffer.messages.flatMap((item) => item.images ?? []),
      files: buffer.messages.flatMap((item) => item.files ?? []),
      messageIds: buffer.messages.map((item) => item.messageId),
      traceId: buffer.messages[0].traceId,
    };
    Promise.resolve(this.onFlush(merged)).catch((error) => log.error(`合并消息处理失败：${error?.message ?? error}`));
  }

  clearScope(scopeKey) {
    for (const [key, buffer] of this.buffers) {
      buffer.messages = buffer.messages.filter((event) => event.scopeKey !== scopeKey);
      if (!buffer.messages.length) {
        clearTimeout(buffer.timer);
        this.buffers.delete(key);
      }
    }
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
    this.busyOwners = new Map();
    /** 同一会话上一轮还没结束时攒下的消息（先排队，不丢）。 */
    this.pending = new Map();
    /**
     * 最近读过的文件（每个会话留一份）。
     *
     * 为什么需要：文件内容只在「收到的那一轮」进提示词，下一轮她手里只剩
     * 「[文件:xxx.txt]」这个占位和上次自己的回复。用户紧接着问「第二章写了什么」，
     * 她就没内容可看了。所以这里留一份，往后 keepTurns 轮里以「还留着」的身份再带上，
     * 让她能接着聊；超过就丢掉，免得每轮都白烧一万字。
     */
    this.recentFiles = new Map();
    this.lastReply = null;
    this.followTimers = new Map();
    this.mergeBuffer = new GroupMergeBuffer({
      windowMs: Math.max(0, Number(getConfig().chat.groupMergeWindowSec) || 8) * 1000,
      onFlush: (merged) => this.handle(merged),
    });
    this.decisions = [];
  }

  #tagEvent(event) {
    return event.scopeGeneration === undefined ? { ...event, scopeGeneration: scopeGeneration(event.scopeKey) } : event;
  }

  #current(event) {
    return isCurrentScope(event.scopeKey, event.scopeGeneration) &&
      (event.sourceGenerations ?? []).every((item) => isCurrentScope(item.scopeKey, item.generation));
  }

  #scopeKeys(event) {
    return [event.scopeKey, ...(event.sourceGenerations ?? []).map((item) => item.scopeKey)];
  }

  #check(event) {
    if (!this.#current(event)) throw Object.assign(new Error("会话已清空，旧任务已丢弃"), { kind: "scope_cleared" });
  }

  async clearConversation(scopeKey, options = {}) {
    scopeKey = assertScopeKey(scopeKey);
    const result = clearMessages(scopeKey, options);
    this.recentFiles.delete(scopeKey);
    this.pending.delete(scopeKey);
    this.busy.delete(scopeKey);
    this.busyOwners.delete(scopeKey);
    this.mergeBuffer.clearScope(scopeKey);
    for (const [timer, key] of this.followTimers) {
      if (key === scopeKey) { clearTimeout(timer); this.followTimers.delete(timer); }
    }
    if (this.lastReply?.scopeKey === scopeKey) this.lastReply = null;
    this.decisions = this.decisions.filter((item) => item.scopeKey !== scopeKey);
    this.scheduler?.clearScope?.(scopeKey);
    await drainScopeSends(scopeKey);
    return result;
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
    const who = isMaster && event.kind === "private" && String(event.accountId) === String(cfg.bot.selfId)
      ? cfg.bot.masterName || "指挥官" : event.senderName || `QQ ${event.senderId}`;

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
    /*
     * 天气分三档（这是「说了别再提还一直提」的根因，必须分清楚）：
     *   ① 被纠正/叫停 → 预报整块不给（给了她就会一直往回拉），只给「对方说那边是 X」的反馈块；
     *   ② 正常 → 给一份明确写着「市级预报、别主动播报、别反复提」的参考数据；
     *   ③ 关闭 → 什么都不给。
     */
    const privateWeather = event.kind === "private" && String(event.senderId) === String(cfg.bot.masterId) && String(event.accountId) === String(cfg.bot.selfId);
    const feedbackBlock = privateWeather ? weatherFeedbackBlock() : "";
    const muted = !privateWeather || isWeatherMuted().muted;
    const weatherBlock = muted || getConfig().weather?.enabled === false ? "" : cachedWeatherBlock();

    return {
      scopeKey,
      audience: audienceFor(event),
      generation: event.scopeGeneration,
      scopeGenerations: event.sourceGenerations ?? [],
      history,
      memory,
      relationship: relationshipLines.join("\n"),
      extras: extras.filter(Boolean).join("\n"),
      userText,
      who,
      isMaster,
      memberPolicy,
      /*
       * 事实通道：不管这一句是「嗯」还是「你说吧」，长期事实都要在。
       * 以前这里写死成空数组，于是「关于对方的可信事实」那一节永远是空的。
       */
      facts: pinnedFacts({ scopeKey }),
      query,
      weatherBlock,
      weatherFeedback: feedbackBlock,
      weatherMuted: muted,
    };
  }

  /**
   * 记下「她今天已经提过天气了」。
   *
   * 为什么需要：提示词里塞了天气数据，她很容易在每一条回复里都拐过去。
   * 一旦她自己提过一次，后面每轮都会看到「今天你已经提过了，别再重复」，
   * 这是堵住「不停提醒」的最后一道闸。
   */
  #noteWeatherMention(bubbles) {
    try {
      if (getConfig().weather?.enabled === false) return null;
      const text = (bubbles ?? []).join(" ");
      const kinds = [];
      if (/雨|伞|淋/.test(text)) kinds.push("rain");
      if (/雪|结冰/.test(text)) kinds.push("snow");
      if (/雷/.test(text)) kinds.push("thunder");
      if (/降温|加衣|外套|变冷/.test(text)) kinds.push("temp_drop");
      if (/热|中暑|防晒|紫外/.test(text)) kinds.push("heat");
      if (/冷|零下/.test(text)) kinds.push("cold");
      if (/风大|刮风|阵风/.test(text)) kinds.push("wind");
      if (!kinds.length) return null;
      return recordWeatherMention(kinds);
    } catch {
      return null;
    }
  }

  /**
   * 从用户这句话里读「天气反馈」。
   *
   * 三件事必须一起做，否则就会出现「跟她说过了她还在提」：
   *   ① 记录（进 state 文件），让今天的主动天气消息和后续每一轮提示词都知道；
   *   ② 立刻在当前这一轮给模型一句「对方说那边实际是 X / 别再提了」；
   *   ③ 已经在提示词里注入的天气块要能撤掉——这条靠第 ① 步同步生效。
   */
  #readWeatherFeedback(event) {
    if (event.kind !== "private" || String(event.senderId) !== String(getConfig().bot.masterId) || String(event.accountId) !== String(getConfig().bot.selfId)) return null;
    const cfg = getConfig();
    if (cfg.weather?.enabled === false) return null;
    const detected = detectWeatherFeedback(event.text);
    if (!detected) return null;
    const recorded = recordWeatherFeedback({ type: detected.type, note: detected.note, text: event.text });
    log.info(
      detected.type === "correction"
        ? `用户纠正天气（${detected.note}）：今天不再提天气`
        : detected.type === "ack"
          ? "用户表示已知晓，今天不再重复天气提醒"
          : "用户要求别再提天气，今天不再提醒",
    );
    audit({ eventType: "weather_feedback", scopeKey: event.scopeKey, actor: event.senderId, reason: detected.type, detail: { note: detected.note } });
    return { ...detected, mutedUntil: recorded.until };
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

  /*
   * 反卡壳：她只说了开场白就停住时，用「接着说」把正文要回来。
   *
   * 为什么必须在代码里做，而不是加提示词：
   *   角色卡里有「不会说教式的长篇大论」「句子之间有停顿感，但整体仍然简短」，
   *   模型被问到「你怎么看」时经常只回一句「嗯，我按我理解的说哦，不专业的地方你别笑我呀。」
   *   然后停住。实测往提示词里加「必须说正文」的硬规则，3 次里仍然 0 次给出正文——
   *   而且它会照抄自己历史里的这类回复，越催越僵。
   *   但换一种问法立刻就好：把开场白当成已经说过的话，让它「顺着刚才那句往下讲」，
   *   实测 2/2 都能给出正文。
   *
   * 所以这里的做法是：保留开场白（真人也是先咳一声再讲），再补一次续写，接在后面发出去。
   * 只补一次，补不回来就照原样发，绝不连环重试烧钱。
   */
  async #continueAfterStall({ target, ctx, style, bubbles, cfg, images = [], files = [] }) {
    const opener = bubbles.join(" ");
    const demand = [
      "【这一次的硬要求】",
      "你上一条只说了开场白（「" + opener.slice(0, 40) + "」），正文一个字都没说，对方在等。",
      "接着刚才那句话往下讲：第一句就给出结论或你的理解，然后补一两句理由或例子。",
      "不要重新开场，不要再出现「让我想想」「我按我理解的说」「说得不对你别笑我」「不一定准」「等你想听我再讲」这类话。",
      "「简短」只是句子短，不是不说内容；「不说教」只是不居高临下，不是不给答案。",
      "也不要用「不要太勉强自己」「去休息」「给你温着饭」这种关心替换掉对方要的答案。",
    ].join("\n");
    try {
      const result = await this.llm.speak(target, "（接着刚才那句往下说，直接把内容讲出来）", {
        task: "chat",
        audience: ctx.audience,
        generation: ctx.generation,
        scopeGenerations: ctx.scopeGenerations,
        history: [...ctx.history, { role: "user", content: ctx.userText }, { role: "assistant", content: opener }],
        facts: ctx.facts,
        extra: `${ctx.extras}\n\n${demand}`,
        relationship: ctx.relationship,
        memory: ctx.memory.block,
        masterName: ctx.who,
        images,
        files,
        isGroup: false,
        scopeKey: ctx.scopeKey,
        characterId: target.id,
        budgetScope: "private",
        style: { ...style, activity: Math.max(style.activity, 70) },
        weatherBlock: ctx.weatherBlock,
        feedback: ctx.weatherFeedback,
      });
      const extraBubbles = splitBubbles(result.text, {
        maxChars: style.maxChars,
        maxBubbles: style.maxBubbles,
        enabled: cfg.chat.splitBubbles,
      });
      const cleaned = cfg.chat.useEmoji === false ? extraBubbles.map(stripEmoji).filter(Boolean) : extraBubbles;
      // 续写自己又卡住了（或者根本没内容）：那就不追加，免得发两条开场白
      if (!cleaned.length || isStallReply(cleaned, { userText: ctx.userText })) {
        log.warn(`续写补回来的还是开场白，这次就这样发出去：${cleaned.join(" / ").slice(0, 60)}`);
        return null;
      }
      log.info(`她只说了开场白，已自动续写正文（${cleaned.join("").length} 字）`);
      return { bubbles: cleaned, usage: result.usage, requestId: result.requestId };
    } catch (error) {
      log.warn(`续写失败（按原样发）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 只生成不发送（面板试聊与真实聊天共用）。 */
  async generate({ event, images = [], files = [], character = null }) {
    event = this.#tagEvent(event);
    this.#check(event);
    const cfg = getConfig();
    const target = character ?? this.character();
    const ctx = this.buildContext({ event, character: target });
    const budgetScope = event.kind === "group" ? "group" : "private";
    const style = replyStyle();

    /*
     * 这一轮要看哪些文件：优先用刚收到的；没有新文件，就把「最近读过、还留着」的那份带上，
     * 这样用户接着问「第二章写了什么」她还能答得上来。每带一次减一次，几轮之后自动消失。
     */
    if (!files.length) {
      const recent = this.recentFiles.get(ctx.scopeKey);
      if (recent && recent.turnsLeft > 0) {
        recent.turnsLeft -= 1;
        files = [{ ...recent, replay: true }];
        log.debug(`带上之前读过的文件：${recent.name}（还能带 ${recent.turnsLeft} 轮）`);
      }
    }

    const result = await this.llm.speak(target, ctx.userText, {
      task: "chat",
      audience: ctx.audience,
      generation: ctx.generation,
      scopeGenerations: ctx.scopeGenerations,
      history: ctx.history,
      facts: ctx.facts,
      extra: ctx.extras,
      relationship: ctx.relationship,
      memory: ctx.memory.block,
      masterName: ctx.who,
      images,
      files,
      isGroup: event.kind === "group",
      scopeKey: ctx.scopeKey,
      characterId: target.id,
      budgetScope,
      style,
      weatherBlock: ctx.weatherBlock,
      feedback: ctx.weatherFeedback,
    });

    this.#check(event);
    const toBubbles = (text) => {
      const raw = splitBubbles(text, { maxChars: style.maxChars, maxBubbles: style.maxBubbles, enabled: cfg.chat.splitBubbles });
      return cfg.chat.useEmoji === false ? raw.map(stripEmoji).filter(Boolean) : raw;
    };
    let bubbles = toBubbles(result.text);
    let finalResult = result;

    /*
     * 兜底：她已经被告知「别再提天气」，这次回复却还是拐回天气上了怎么办？
     *
     * 光靠提示词不保险（历史里还留着她之前那句「今天下阵雨」）。
     * 所以这里做一次确定性检查：静音状态 + 回复里出现天气词 + 对方这句话本身没在聊天气
     * → 让她重写一遍，并明确禁止出现这些词。重写还不行就把带天气的那几条摘掉，
     * 宁可这次少说一句，也不能一边答应「不唠叨了」一边继续提下雨。
     */
    const userTalksWeather = WEATHER_TALK_BROAD.test(String(ctx.userText ?? ""));
    if (ctx.weatherMuted && !userTalksWeather && bubbles.some((b) => WEATHER_TALK.test(b))) {
      log.info("她这轮又提到天气了（已静音），重写一次");
      try {
        const retry = await this.llm.speak(target, ctx.userText, {
          task: "chat",
          audience: ctx.audience,
          generation: ctx.generation,
          scopeGenerations: ctx.scopeGenerations,
          history: ctx.history,
          facts: ctx.facts,
          extra: `${ctx.extras}\n\n【这一次的硬要求】对方已经不想再听天气了。你的回复里**绝对不能出现**雨、雪、伞、天气、气温、降温、热、冷、晒、风这些词，也不要暗示天气、不要提醒带伞加衣。就当今天没看过天气预报。`,
          relationship: ctx.relationship,
          memory: ctx.memory.block,
          masterName: ctx.who,
          images,
          files,
          isGroup: event.kind === "group",
          scopeKey: ctx.scopeKey,
          characterId: target.id,
          budgetScope,
          style,
          weatherBlock: "",
          feedback: ctx.weatherFeedback,
        });
        this.#check(event);
        const retryBubbles = toBubbles(retry.text).filter((b) => !WEATHER_TALK.test(b));
        if (retryBubbles.length) {
          bubbles = retryBubbles;
          finalResult = retry;
        } else {
          const kept = bubbles.filter((b) => !WEATHER_TALK.test(b));
          bubbles = kept;
          log.warn("重写后仍然带天气，已把带天气的那几句摘掉");
        }
      } catch (error) {
        bubbles = bubbles.filter((b) => !WEATHER_TALK.test(b));
        log.warn(`天气静音兜底：重写失败，已摘掉带天气的句子（${error?.message ?? error}）`);
      }
    }

    /*
     * 反卡壳兜底。
     *
     * 走到这里说明这一轮已经定稿（天气兜底也过了）。如果她只留了一句开场白，
     * 就再要一次正文接在后面——用户看到的仍然是「先咳一声，再讲」，但至少有下文。
     */
    let stalled = false;
    let continued = false;
    if (cfg.chat.antiStall !== false && bubbles.length && isStallReply(bubbles, { userText: ctx.userText })) {
      stalled = true;
      const extra = await this.#continueAfterStall({
        target,
        ctx,
        style,
        bubbles,
        cfg,
        images,
        files,
      });
      if (extra) {
        bubbles = [...bubbles, ...extra.bubbles];
        continued = true;
        audit({
          eventType: "reply_continued",
          scopeKey: ctx.scopeKey,
          actor: event.senderId,
          reason: "只说了开场白",
          detail: { opener: bubbles[0]?.slice(0, 60), added: extra.bubbles.length },
          traceId: event.traceId,
        });
      } else {
        audit({
          eventType: "reply_stalled",
          scopeKey: ctx.scopeKey,
          actor: event.senderId,
          reason: "续写也没拿到正文",
          detail: { opener: bubbles.join(" / ").slice(0, 80) },
          traceId: event.traceId,
        });
      }
    }

    this.#check(event);
    return {
      character: target,
      bubbles,
      raw: finalResult.text,
      requestId: finalResult.requestId,
      usage: finalResult.usage,
      context: ctx,
      style,
      stalled,
      continued,
    };
  }

  /** 处理一条（可能已合并的）真实消息。 */
  async handle(event) {
    event = this.#tagEvent(event);
    if (!this.#current(event)) return { replied: false, reason: "scope_cleared" };
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

    /*
     * 入箱优先：**先落库，再判断回不回**。
     *
     * 以前是先过 gate、过了才写库，于是「被限流/被暂停/在黑名单」的消息在库里根本不存在，
     * 面板上看就是「我明明发出去了，她那边没收到」——用户没法判断到底是没收到还是不想回。
     * 现在真实消息一律先落库（审计、检索、面板都要用），gate 只决定要不要回。
     */
    // 合并后的「排队消息」已经各自入过库了，别写第二遍（也不该被当成重复事件丢掉）
    const stored = event.alreadyStored ? { duplicated: false } : insertMessage({
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

    // 重复投递：这条已经处理过了，别再回一遍
    if (stored.duplicated) {
      log.debug(`重复事件已忽略：${event.eventId}`);
      return { replied: false, reason: "duplicate", stored: true };
    }

    if (decision.action === ACTION.SILENT || decision.action === ACTION.SKIP) {
      // 记一笔原因，面板「决策审计」里能查到这个人为啥没回
      audit({
        eventType: "message_not_answered",
        scopeKey: event.scopeKey,
        actor: event.senderId,
        reason: decision.reason,
        detail: { preview: String(event.text ?? "").slice(0, 60) },
        traceId: event.traceId,
      });
      log.debug(`不回复（${decision.reason}），但消息已记录`, { scope: event.scopeKey });
      return { replied: false, reason: decision.reason, stored: true };
    }

    // 先读天气反馈再生成：这样这一轮就已经知道「他那边是晴天，别再提了」
    this.#readWeatherFeedback(event);

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

    /*
     * 上一轮还没生成完又来一条：**排队，不丢**。
     *
     * 以前这里是直接 return「busy」，用户连发两条时第二条就永远不会被回
     * （他自己看到的只是「她不回我」）。现在先攒起来，等这一轮结束再把攒下的
     * 几条合成一个上下文回一次——和群里「连着发几条」的处理方式一致。
     */
    if (this.busy.has(event.scopeKey)) {
      const list = this.pending.get(event.scopeKey) ?? [];
      list.push(event);
      if (list.length > MAX_PENDING_PER_SCOPE) list.shift();
      this.pending.set(event.scopeKey, list);
      log.debug(`上一轮还没结束，这条先排队（${list.length} 条待处理）`);
      return { replied: false, reason: "queued", stored: true, queued: list.length };
    }
    this.busy.add(event.scopeKey);
    const owner = Symbol();
    this.busyOwners.set(event.scopeKey, owner);
    try {
      const images = await this.collectImages(event);
      this.#check(event);
      const files = await this.collectFiles(event);
      this.#check(event);
      const { bubbles, usage, requestId, context, style, stalled } = await this.generate({ event, images, files, character });
      this.#check(event);
      if (!bubbles.length) return { replied: false, reason: "空回复" };

      const sent = await this.#deliverBubbles(event, bubbles, { character, traceId: event.traceId });
      if (!sent.ok) return sent;
      this.#check(event);

      noteReply({ kind: event.kind, groupId: event.groupId, peerId: event.senderId });
      this.#afterReply({ event, character, usage, requestId, context });
      this.#noteWeatherMention(bubbles);
      this.lastReply = { at: Date.now(), scopeKey: event.scopeKey, bubbles };
      this.onReply({ event, bubbles, usage, requestId });
      // 活跃度够高时，隔几秒再主动补一句（「主动继续发起对话」）
      const followUp = this.#scheduleFollowUp({ event, character, bubbles, style, context, stalled });
      return { replied: true, bubbles, usage, followUp };
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`生成/发送失败：${message}`);
      audit({ eventType: "reply_failed", scopeKey: event.scopeKey, reason: message, traceId: event.traceId });
      return { replied: false, reason: message };
    } finally {
      if (this.busyOwners.get(event.scopeKey) === owner) {
        this.busyOwners.delete(event.scopeKey);
        this.busy.delete(event.scopeKey);
        this.#drainPending(event.scopeKey);
      }
    }
  }

  /**
   * 把排队中的消息合成一条，再走一次完整流程。
   *
   * 为什么不逐条回：用户连发三条（「在吗」「我下班了」「今天好累」），
   * 逐条回会变成三连问，合成一次才像人在说话。这也是群里一直以来的做法。
   */
  #drainPending(scopeKey) {
    const list = this.pending.get(scopeKey);
    if (!list || !list.length) return;
    this.pending.delete(scopeKey);
    const last = list[list.length - 1];
    const merged = list.length === 1
      ? last
      : {
          ...last,
          sourceGenerations: list.flatMap((item) => [{ scopeKey: item.scopeKey, generation: item.scopeGeneration }, ...(item.sourceGenerations ?? [])]),
          mergedMessages: list.map((item) => ({ senderId: item.senderId, senderName: item.senderName, text: item.text, at: item.timestampMs })),
          text: list.map((item) => item.text).filter(Boolean).join("\n"),
          images: list.flatMap((item) => item.images ?? []),
          files: list.flatMap((item) => item.files ?? []),
          messageIds: list.map((item) => item.messageId),
          isMention: list.some((item) => item.isMention),
          // 这几条在排队时就已经各自落库了，合并后不要再写一遍
          alreadyStored: true,
        };
    log.debug(`开始处理排队中的 ${list.length} 条消息`);
    setImmediate(() => {
      Promise.resolve(this.handle(merged)).catch((error) => log.error(`排队消息处理失败：${error?.message ?? error}`));
    });
  }

  async #handleModeration(event, decision) {
    this.#check(event);
    const cfg = getConfig();
    const character = this.character();
    const filter = cfg.group?.filter ?? {};
    let warnText = decision.warnText;
    if (!warnText) {
      warnText = await this.#buildWarnText({ word: decision.hit?.word ?? "", name: event.senderName, groupId: event.groupId, event });
    }
    try {
      this.#check(event);
      const isGroup = event.kind === "group";
      // 警告语是给对方的最后一次提示：即使刚被拉黑也要发出去；
      // 真正被拉黑的人，之后连 gate 都过不了，不会有第二条消息。
      if (warnText) {
        await trackScopeSend(this.#scopeKeys(event), () => {
          this.#check(event);
          return isGroup ? this.client.sendGroupMsg(event.groupId, warnText) : this.client.sendPrivateMsg(event.senderId, warnText);
        });
        this.#check(event);
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
          await trackScopeSend(this.#scopeKeys(event), () => {
            this.#check(event);
            return this.client.sendPrivateMsg(master, note);
          }).catch((error) => log.warn(`通知管理员失败：${error?.message ?? error}`));
          this.#check(event);
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

  async #buildWarnText({ word, name, groupId, event }) {
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
        scopeKey: event.scopeKey,
        generation: event.scopeGeneration,
        scopeGenerations: event.sourceGenerations ?? [],
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
      this.#check(event);
      if (cfg.chat.preflightCheck) {
        const check = preflight({ kind: event.kind, groupId: event.groupId, peerId: event.senderId, characterId: character.id });
        if (!check.ok) {
          log.warn(`发送前复核未通过，本条不再发出：${check.reason}`);
          return { ok: false, reason: check.reason };
        }
      }
      const delay = index === 0 ? Number(cfg.chat.firstDelayMs) || 0 : Math.min(2500, 300 + bubble.length * 12);
      if (delay > 0) await sleep(Math.max(0, delay) * (index === 0 ? 1 : 1));
      this.#check(event);
      const idempotencyKey = `reply:${event.messageId}:${index}`;
      const key = idempotencyKey;
      run(
        `insert or ignore into outgoing(idempotency_key, scope_key, kind, target_id, body, reason, status, trace_id, created_at)
         values(?, ?, ?, ?, ?, 'reply', 'pending', ?, ?)`,
        [key, event.scopeKey, event.kind, String(targetId), bubble, traceId, Date.now()],
      );
      try {
        const keys = this.#scopeKeys(event);
        const sent = await trackScopeSend(keys, () => {
          this.#check(event);
          return isGroup ? this.client.sendGroupMsg(event.groupId, bubble, { idempotencyKey: `msg:${key}` })
            : this.client.sendPrivateMsg(event.senderId, bubble, { idempotencyKey: `msg:${key}` });
        });
        this.#check(event);
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
        if (!this.#current(event)) return { ok: false, reason: "scope_cleared" };
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
  #scheduleFollowUp({ event, character, bubbles, style, context, stalled = false }) {
    const cfg = getConfig();
    if (!style?.followUpEnabled || style.followUpMaxPerTurn < 1) return { scheduled: false, reason: "未开启追话" };
    if (event.kind !== "private") return { scheduled: false, reason: "群里不追话" };
    /*
     * 这一轮她其实什么都没说出来（续写也失败）：这时候再「追一句」，
     * 补出来的必然是「锅里温着饭呢」这种关心话——用户看到的就是「我问了三遍，她一直岔开」。
     * 所以卡壳的那一轮不追话。
     */
    if (stalled && isStallReply(bubbles, { userText: context?.userText })) return { scheduled: false, reason: "上一句卡在开场白，不追话" };
    if (!this.scheduler?.deliver) return { scheduled: false, reason: "没有投递通道" };
    if (inQuietHours(cfg.chat.quietHours)) return { scheduled: false, reason: "静默时段" };
    if (Math.random() >= style.followUpChance) return { scheduled: false, reason: `这次不追（概率 ${(style.followUpChance * 100).toFixed(0)}%）` };

    const peerId = String(event.senderId);
    const turnKey = `followup:${event.messageId}:1`;
    const delayMs = Math.max(2, style.followUpDelaySec) * 1000;
    const timer = setTimeout(async () => {
      this.followTimers.delete(timer);
      try {
        if (pauseState.paused || !this.#current(event)) return;
        /*
         * 追话的质量问题：以前这里只给了「再补一句，就像聊着聊着又想起一件事」，
         * 于是每次都补出一句「对了，锅里温着饭呢」「不要太勉强自己哦」——
         * 同一张关心牌打十遍，看起来像不会聊天，还会把人刚说的话题岔开。
         * 现在明确要求：接着刚才那件事补细节，并且禁掉这个开头和这句关心话。
         */
        const topic = String(context?.userText ?? "").replace(/\s+/g, " ").slice(0, 60);
        const prompt = [
          topic ? `对方刚才说的是：「${topic}」` : "",
          `你刚才已经给对方发过：${bubbles.join(" / ")}`,
          "现在再补一句，就像聊着聊着又想起一件事。",
          "要求：只一句，很短；内容必须是刚才这件事的补充（一个细节、一个例子、或者一句反问），不许换话题。",
          "不要用「对了，……」开头；不要再说「不要太勉强自己」「去休息」「给你温着饭」「留了点心」这类关心话——刚才那条已经很够了。",
          "不要重复刚才说过的话，不要连着问问题，不要写括号动作。",
          "直接输出要发的内容。",
        ]
          .filter(Boolean)
          .join("\n");
        const result = await this.llm.speak(character, prompt, {
          task: "chat",
          audience: context?.audience,
          generation: context?.generation,
          scopeGenerations: event.sourceGenerations ?? [],
          history: [],
          facts: [],
          extra: "这是你主动补的一句，不是回复对方的新消息。",
          masterName: context?.who || `QQ ${peerId}`,
          scopeKey: event.scopeKey,
          characterId: character.id,
          budgetScope: "private",
          weatherBlock: context?.weatherBlock || "",
          style: { ...style, activity: 25, maxBubbles: 1, wantBubbles: 1, instruction: "只回一句，30 字以内。" },
        });
        let text = cleanReply(result.text, { characterName: character.name }).slice(0, 90);
        if (cfg.chat.useEmoji === false) text = stripEmoji(text);
        if (!text) return;
        this.#check(event);
        const sent = await this.scheduler.deliver({ peerId, text, kind: "followup", idempotencyKey: turnKey, generation: event.scopeGeneration });
        this.#check(event);
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
    this.followTimers.set(timer, event.scopeKey);
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

  /**
   * 取对方发来的文件，读成文字。
   *
   * 分三步，任何一步失败都要留下「读不出来」的原因，而不是悄悄当没发生过——
   * 悄悄没了，她就会照着文件名编内容，那比说「我读不了」糟得多。
   *   ① 下字节（协议端本地缓存 → QQ 直链 → 问协议端要新地址）；
   *   ② 认编码、取文字（UTF-8 / GBK / UTF-16 / docx；图片和压缩包直接判死）；
   *   ③ 存一份原件到 data/media/files，面板和以后回看都能用。
   */
  async collectFiles(event) {
    event = this.#tagEvent(event);
    this.#check(event);
    const cfg = getConfig();
    const conf = cfg.chat?.files ?? {};
    if (conf.enabled === false) return [];
    const list = (event.files ?? []).slice(0, Math.max(1, Number(conf.maxPerMessage) || 3));
    if (!list.length) return [];

    const maxBytes = Math.max(16 * 1024, Number(conf.maxBytes) || 2 * 1024 * 1024);
    const maxChars = Math.max(200, Number(conf.maxChars) || 12000);
    const out = [];

    for (const file of list) {
      const name = sanitizeFileName(file.name || "文件");
      const sizeText = file.size ? formatSize(file.size) : "";
      const base = { name, size: file.size ?? 0, sizeText, ext: extensionOf(name), savedPath: "" };

      if (!this.client?.downloadFile) {
        out.push({ ...base, ok: false, note: "现在拿不到文件内容" });
        continue;
      }

      let buffer;
      try {
        const got = await this.client.downloadFile(file, {
          maxBytes,
          kind: event.kind,
          targetId: event.kind === "group" ? event.groupId : event.senderId,
        });
        this.#check(event);
        buffer = got.buffer;
        log.info(`文件已取到：${name}（${formatSize(got.bytes)}，来源 ${got.source}）`);
      } catch (error) {
        const reason = String(error?.message ?? error);
        log.warn(`文件取不到：${name}——${reason}`);
        out.push({ ...base, ok: false, note: `文件我没能下载下来（${reason.slice(0, 80)}）` });
        continue;
      }

      this.#check(event);
      // 存一份原件（失败不影响这一轮对话）
      try {
        const dir = path.join(paths.media, "files", sanitizeFileName(event.scopeKey, "scope"));
        fs.mkdirSync(dir, { recursive: true });
        const saved = path.join(dir, `${Date.now()}-${name}`);
        fs.writeFileSync(saved, buffer);
        base.savedPath = saved;
      } catch (error) {
        log.debug(`文件原件没存下来（不影响读取）：${error?.message ?? error}`);
      }

      const read = extractText(buffer, name, { maxBytes });
      if (!read.ok) {
        log.info(`文件读不出文字：${name}——${read.note}`);
        out.push({ ...base, ok: false, kind: read.kind, note: read.note });
        continue;
      }

      const window = windowText(read.text, maxChars);
      const entry = {
        ...base,
        ok: true,
        kind: read.kind,
        kindLabel: read.kind === "docx" ? "Word 文档" : "文字",
        encoding: read.encoding,
        chars: read.chars,
        truncated: window.truncated,
        text: window.text,
      };
      out.push(entry);
      // 留一份给后面几轮（只留最后一份，新的覆盖旧的）
      this.recentFiles.set(event.scopeKey, {
        ...entry,
        turnsLeft: Math.max(0, Math.min(5, Number(conf.keepTurns ?? 2))),
      });
      log.info(`文件已读入：${name}（${read.kind}，${read.encoding}，${read.chars} 字${window.truncated ? `，截取 ${maxChars} 字` : ""}）`);
    }
    return out;
  }

  /** 入口：真实事件进来先做「合并 or 直接处理」。 */
  async receive(event) {
    event = this.#tagEvent(event);
    if (!this.#current(event)) return { replied: false, reason: "scope_cleared" };
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
    const event = this.#tagEvent({
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
    });
    const { bubbles, usage, requestId } = await this.generate({ event, images });
    this.#check(event);
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
    for (const timer of this.followTimers.keys()) clearTimeout(timer);
    this.followTimers.clear();
  }
}

export { scopeLabel, getSession, getConfig, activeCharacterId, saveConfig, estimateTokens, one, ensureSession, checkBlocked };
