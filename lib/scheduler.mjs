/**
 * 调度中心（规划书 08、FR-501~506）。
 *
 * 关键设计：
 *   - scheduled_jobs.job_key 唯一 → 同一个节日/生日/问候任务在某一年某一天只会执行一次
 *   - 「随机触发时间」与「允许发送」是两件事：scheduler 只负责唤醒，能不能发由本模块的策略决定
 *   - 静默时段、未回复次数上限、最小间隔、发送失败退避全部在此落地
 *   - 离线错过的提醒按策略补发或跳过，绝不无条件补轰炸
 *   - 所有主动行为都计入预算与日志（费用闸门在 LLM 网关里）
 */
import { all, one, run, tx, audit } from "./db.mjs";
import { getConfig, activeCharacter } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { cleanReply, clamp, dayKey, formatNow, inQuietHours, monthDayKey, parseHm, parseTime, stripEmoji, formatTime } from "./util.mjs";
import { pauseState, checkBlocked } from "./policy.mjs";
import { ensureSession, insertMessage, scopeLabel } from "./storage.mjs";
import { promptBlock, nudgeState, decayState } from "./life.mjs";
import { retrieveMemories } from "./memory.mjs";
import { forecast, buildAlerts, selectedAlerts, promptBlockFor, summarize } from "./weather.mjs";

const log = createLogger("Schedule");
const MIN = 60000;

/** 公历固定节日（农历节日用自定义日期补）。 */
export const SOLAR_HOLIDAYS = [
  { date: "01-01", name: "元旦" },
  { date: "02-14", name: "情人节" },
  { date: "03-08", name: "妇女节" },
  { date: "04-01", name: "愚人节" },
  { date: "05-01", name: "劳动节" },
  { date: "05-04", name: "青年节" },
  { date: "06-01", name: "儿童节" },
  { date: "09-10", name: "教师节" },
  { date: "10-01", name: "国庆节" },
  { date: "12-24", name: "平安夜" },
  { date: "12-25", name: "圣诞节" },
];

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

const pad = (n) => String(n).padStart(2, "0");

export function todayHolidays(date = new Date()) {
  const md = monthDayKey(date);
  const list = SOLAR_HOLIDAYS.filter((item) => item.date === md);
  const year = date.getFullYear();
  if (md === `05-${pad(nthWeekday(year, 5, 0, 2))}`) list.push({ date: md, name: "母亲节" });
  if (md === `06-${pad(nthWeekday(year, 6, 0, 3))}`) list.push({ date: md, name: "父亲节" });
  // 农历节日只在自定义列表里提供，避免内置一份不可靠的农历表
  return list;
}

const MEALS = {
  morning: { label: "早安", prompt: "现在是早上，用一句简短的早安把对方叫醒，可以顺带提醒吃早饭、注意天气或今天的安排。" },
  noon: { label: "午安", prompt: "现在是中午，说一句午安，关心对方有没有吃饭、要不要午休一会儿。" },
  night: { label: "晚安", prompt: "现在是深夜，说一句晚安，语气放软，可以提到今天的小事，让他早点休息。" },
};

export const OCCASIONS = [
  { id: "proactive", label: "随机搭话" },
  { id: "morning", label: "早安" },
  { id: "noon", label: "午安" },
  { id: "night", label: "晚安" },
  { id: "weather", label: "天气提醒" },
  { id: "holiday", label: "节日祝福" },
  { id: "birthday", label: "生日祝福" },
  { id: "reminder", label: "事件提醒" },
];

/* ------------------------------ 任务幂等 ------------------------------ */

/** 声明并占用一个任务键。返回 false 表示这次不该再执行（幂等的核心）。 */
export function claimJob(jobKey, { kind = "generic", scopeKey = "" } = {}) {
  return tx(() => {
    const existing = one("select job_key from job_runs where job_key = ?", [jobKey]);
    if (existing) return false;
    run("insert into job_runs(job_key, at, detail) values(?, ?, '')", [jobKey, Date.now()]);
    run(
      `insert into scheduled_jobs(job_key, kind, scope_key, next_run, state, last_run, created_at)
       values(?, ?, ?, 0, 'done', ?, ?)
       on conflict(job_key) do update set state = 'done', last_run = excluded.last_run`,
      [jobKey, kind, scopeKey, Date.now(), Date.now()],
    );
    return true;
  });
}

export function jobDone(jobKey) {
  return Boolean(one("select job_key from job_runs where job_key = ?", [jobKey]));
}

/* ------------------------------ 主动消息策略 ------------------------------ */

class ProactiveState {
  constructor() {
    this.cache = new Map();
  }
  key(peerId) {
    return `proactive:${peerId}`;
  }
  get(peerId) {
    const key = this.key(peerId);
    const value = one("select * from scheduled_jobs where job_key = ?", [key]);
    const policy = value ? JSON.parse(value.policy_json || "{}") : {};
    return {
      nextAt: Number(policy.nextAt ?? 0),
      day: String(policy.day ?? ""),
      count: Number(policy.count ?? 0),
      unanswered: Number(policy.unanswered ?? 0),
      lastSentAt: Number(policy.lastSentAt ?? 0),
      backoffUntil: Number(policy.backoffUntil ?? 0),
    };
  }
  set(peerId, next) {
    const key = this.key(peerId);
    run(
      `insert into scheduled_jobs(job_key, kind, scope_key, policy_json, next_run, state, created_at)
       values(?, 'proactive', ?, ?, ?, 'pending', ?)
       on conflict(job_key) do update set policy_json = excluded.policy_json, next_run = excluded.next_run`,
      [key, `private_${peerId}`, JSON.stringify(next), Number(next.nextAt) || 0, Date.now()],
    );
    return next;
  }
}

export class Scheduler {
  constructor({ client, llm, life }) {
    this.client = client;
    this.llm = llm;
    this.life = life;
    this.proactiveState = new ProactiveState();
    this.timer = null;
    this.lastTickAt = 0;
    this.lastError = "";
    this.lastSent = null;
    this.history = [];
  }

  character() {
    return activeCharacter();
  }

  masterId() {
    return String(getConfig().bot.masterId ?? "");
  }

  masterName() {
    return getConfig().bot.masterName || "指挥官";
  }

  /* ---------------------------- 生成与投递 ---------------------------- */

  async compose({ occasion, peerId, extra = "", kind = "proactive" }) {
    const cfg = getConfig();
    const character = this.character();
    const scopeKey = `private_${peerId}`;
    const who = String(peerId) === this.masterId() ? cfg.bot.masterName || "指挥官" : `QQ ${peerId}`;
    const memory = promptBlock({
      characterId: character.id,
      scopeKey,
      query: occasion,
      subjectId: String(peerId),
      masterId: this.masterId(),
      masterName: cfg.bot.masterName,
    });
    const prompt = [
      `现在是 ${formatNow()}。`,
      occasion ? `这次要主动说的事：${occasion}` : "",
      extra,
      `你要主动给「${who}」发一条 QQ 消息。要求：1~2 句，口语短句，像真人在 QQ 上突然想起来发一句；不要每次都问「在干嘛」，不要用「亲爱的」这类称呼。`,
      "直接输出要发的内容，不要引号、不要解释、不要括号动作。",
    ]
      .filter(Boolean)
      .join("\n");
    const result = await this.llm.speak(character, prompt, {
      task: "intent",
      history: [],
      facts: [],
      extra: [memory.block, `场合：${kind}`].filter(Boolean).join("\n\n"),
      masterName: cfg.bot.masterName,
      scopeKey,
      characterId: character.id,
      budgetScope: "private",
      isGroup: false,
      overrides: { maxTokens: 400 },
    });
    let text = cleanReply(result.text, { characterName: character.name }).slice(0, 240);
    if (cfg.chat?.useEmoji === false) text = stripEmoji(text);
    return { text, requestId: result.requestId, cost: result.usage?.cost ?? 0 };
  }

  /** 真正发出并留痕（含出站队列状态）。 */
  async deliver({ peerId, text, kind, meta = {}, idempotencyKey = "" }) {
    const cfg = getConfig();
    const scopeKey = `private_${peerId}`;
    const key = idempotencyKey || `out:${kind}:${peerId}:${Math.floor(Date.now() / 1000)}`;
    if (!text) return null;
    const preflight = pauseState.paused ? { ok: false, reason: "自动化已暂停" } : checkBlocked({ kind: "private", peerId });
    if (preflight?.blocked || preflight?.ok === false) {
      log.warn(`主动消息未发出（${preflight.reason || "在黑名单里"}）→ ${peerId}`);
      run(
        `insert or ignore into outgoing(idempotency_key, scope_key, kind, target_id, body, reason, status, error, created_at)
         values(?, ?, ?, ?, ?, ?, 'blocked', ?, ?)`,
        [key, scopeKey, kind, String(peerId), text, kind, preflight.reason ?? "在黑名单里", Date.now()],
      );
      return null;
    }
    run(
      `insert or ignore into outgoing(idempotency_key, scope_key, kind, target_id, body, reason, status, created_at)
       values(?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [key, scopeKey, kind, String(peerId), text, kind, Date.now()],
    );
    try {
      const sent = await this.client.sendPrivateMsg(peerId, text, { idempotencyKey: `msg:${key}` });
      run("update outgoing set status = ?, attempts = attempts + 1, platform_message_id = ?, sent_at = ? where idempotency_key = ?", [
        "sent",
        String(sent?.message_id ?? ""),
        Date.now(),
        key,
      ]);
      ensureSession(scopeKey, { accountId: this.client.selfId });
      insertMessage({
        eventKey: `out:${key}`,
        scopeKey,
        direction: "out",
        senderId: this.client.selfId,
        kind: "private",
        at: Date.now(),
        body: text,
        status: "sent",
      });
      this.lastSent = { at: Date.now(), peerId: String(peerId), text, kind, ...meta };
      this.history.unshift(this.lastSent);
      this.history = this.history.slice(0, 50);
      log.info(`主动消息（${kind}）→ ${peerId}：${text}`);
      return this.lastSent;
    } catch (error) {
      run("update outgoing set status = ?, attempts = attempts + 1, error = ? where idempotency_key = ?", [
        "unknown",
        String(error?.message ?? error).slice(0, 300),
        key,
      ]);
      this.lastError = String(error?.message ?? error);
      log.warn(`主动消息发送失败（状态未知，不重发）：${this.lastError}`);
      return null;
    }
  }

  /** 面板「立刻让她主动发一条」与命令行自检都走这里。 */
  async greetNow({ kind = "proactive", userId = "", text = "", occasion = "" } = {}) {
    const cfg = getConfig();
    const peerId = String(userId || this.masterId() || "");
    if (!peerId) throw new Error("还没有设置对方 QQ 号（面板「运行环境」里填 masterId）");
    const content = String(text ?? "").trim() || (await this.compose({ occasion: occasion || MEALS[kind]?.prompt || "", peerId, kind })).text;
    if (!content) return null;
    return this.deliver({ peerId, text: content, kind, idempotencyKey: `manual:${kind}:${peerId}:${Date.now()}` });
  }

  /** 面板「立刻发一条天气提醒」：真发出去，用来验证整条链路通不通。 */
  async greetWeatherNow({ userId = "" } = {}) {
    const cfg = getConfig();
    const peerId = String(userId || this.masterId() || "");
    if (!peerId) throw new Error("还没有设置对方 QQ 号（面板「QQ 账号」里填一下）");
    const data = await forecast({ force: true });
    if (!data?.ok) throw new Error(data?.error || "查不到天气");
    const alerts = selectedAlerts(buildAlerts(data));
    const occasion = alerts.length
      ? `用你自己的话提醒对方今天出门要注意的事（${alerts.map((item) => item.text).join("；")}）。`
      : "随口提一句今天的天气，不用特意提醒什么。";
    const content = (
      await this.compose({
        occasion,
        peerId,
        kind: "weather",
        extra: promptBlockFor(data, alerts),
      })
    ).text;
    if (!content) return null;
    return this.deliver({ peerId, text: content, kind: "weather", meta: { city: data.city, manual: true }, idempotencyKey: `weather:manual:${peerId}:${Date.now()}` });
  }

  /* ---------------------------- 各类定时任务 ---------------------------- */

  async tickMeals(now) {
    const cfg = getConfig();
    const today = dayKey(now);
    const results = [];
    for (const kind of ["morning", "noon", "night"]) {
      const conf = cfg.greet?.[kind];
      if (!conf?.enabled) continue;
      const at = parseHm(conf.at);
      if (at === null) continue;
      const target = now.getHours() * 60 + now.getMinutes() - (Number(conf.randomDelayMinutes) || 0);
      if (target < at) continue;
      if (conf.workdayOnly && (now.getDay() === 0 || now.getDay() === 6)) continue;
      for (const peerId of this.targets()) {
        const jobKey = `meal:${kind}:${peerId}:${today}`;
        if (!claimJob(jobKey, { kind, scopeKey: `private_${peerId}` })) continue;
        try {
          const content = String(conf.text ?? "").trim() || (await this.compose({ occasion: MEALS[kind].prompt, peerId, kind })).text;
          const sent = await this.deliver({ peerId, text: content, kind, idempotencyKey: jobKey });
          if (sent) results.push({ kind, peerId, text: content });
        } catch (error) {
          this.lastError = String(error?.message ?? error);
          log.warn(`${MEALS[kind].label}问候失败：${this.lastError}`);
        }
      }
    }
    return results;
  }

  async tickHolidays(now) {
    const cfg = getConfig();
    const conf = cfg.greet?.holidays;
    if (!conf?.enabled) return [];
    const md = monthDayKey(now);
    const list = [...(conf.builtin === false ? [] : todayHolidays(now))];
    for (const item of conf.custom ?? []) {
      if (String(item.date ?? "") === md && item.name) list.push(item);
    }
    const results = [];
    for (const holiday of list) {
      for (const peerId of this.targets()) {
        const jobKey = `holiday:${holiday.name}:${peerId}:${now.getFullYear()}`;
        if (!claimJob(jobKey, { kind: "holiday", scopeKey: `private_${peerId}` })) continue;
        try {
          const occasion = holiday.hint || `今天是${holiday.name}，主动说一句和这个节日有关的祝福，可以结合你最近记得的事。`;
          const content = (await this.compose({ occasion, peerId, kind: "holiday" })).text;
          const sent = await this.deliver({ peerId, text: content, kind: "holiday", meta: { name: holiday.name }, idempotencyKey: jobKey });
          if (sent) results.push({ kind: "holiday", name: holiday.name, peerId, text: content });
        } catch (error) {
          this.lastError = String(error?.message ?? error);
          log.warn(`节日问候失败：${this.lastError}`);
        }
      }
    }
    return results;
  }

  async tickBirthdays(now) {
    const cfg = getConfig();
    const conf = cfg.greet?.birthdays;
    if (!conf?.enabled) return [];
    const md = monthDayKey(now);
    const results = [];
    for (const item of conf.list ?? []) {
      if (String(item.date ?? "") !== md) continue;
      const peerId = String(item.userId || this.masterId() || "");
      if (!peerId) continue;
      const jobKey = `birthday:${peerId}:${now.getFullYear()}`;
      if (!claimJob(jobKey, { kind: "birthday", scopeKey: `private_${peerId}` })) continue;
      try {
        const occasion = `今天是${item.name || "对方"}的生日，专门送上一句生日快乐，可以带上你自己准备的小心意。`;
        const content = (await this.compose({ occasion, peerId, kind: "birthday" })).text;
        const sent = await this.deliver({ peerId, text: content, kind: "birthday", meta: { name: item.name }, idempotencyKey: jobKey });
        if (sent) results.push({ kind: "birthday", name: item.name, peerId, text: content });
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        log.warn(`生日问候失败：${this.lastError}`);
      }
    }
    return results;
  }

  async tickReminders(now) {
    const cfg = getConfig();
    if (cfg.greet?.reminders?.enabled === false) return [];
    const rows = all("select * from reminders where enabled = 1 and at <= ? order by at asc limit 20", [now.getTime()]);
    const results = [];
    for (const row of rows) {
      const lateMs = now.getTime() - Number(row.at);
      const graceMs = 6 * 3600000;
      const offlinePolicy = cfg.greet?.reminders?.offlinePolicy ?? "skip";
      if (lateMs > graceMs && offlinePolicy === "skip") {
        run("update reminders set enabled = 0, updated_at = ? where id = ?", [now.getTime(), row.id]);
        audit({ eventType: "reminder_skipped", reason: `离线错过 ${(lateMs / 3600000).toFixed(1)} 小时，按策略跳过`, detail: { id: row.id, text: row.text } });
        continue;
      }
      const peerId = String(row.target_id || this.masterId() || "");
      const jobKey = `reminder:${row.id}:${Math.floor(Number(row.at) / 1000)}`;
      run("update reminders set last_fired = ?, updated_at = ? where id = ?", [now.getTime(), now.getTime(), row.id]);
      if (row.repeat_rule === "daily") {
        run("update reminders set at = at + 86400000, enabled = 1 where id = ?", [row.id]);
      } else if (row.repeat_rule === "weekly") {
        run("update reminders set at = at + 604800000, enabled = 1 where id = ?", [row.id]);
      } else {
        run("update reminders set enabled = 0 where id = ?", [row.id]);
      }
      if (!claimJob(jobKey, { kind: "reminder", scopeKey: `private_${peerId}` })) continue;
      try {
        const occasion = row.polish
          ? `你要提醒对方这件事：${row.text}。用你自己的话提醒，别像闹钟一样播报。`
          : `原样说出这句话：${row.text}`;
        const content = row.polish ? (await this.compose({ occasion, peerId, kind: "reminder" })).text : String(row.text);
        const sent = await this.deliver({ peerId, text: content, kind: "reminder", meta: { reminderId: row.id }, idempotencyKey: jobKey });
        if (sent) results.push({ kind: "reminder", peerId, text: content });
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        log.warn(`提醒失败：${this.lastError}`);
      }
    }
    return results;
  }

  /* ---------------------------- 天气提醒 ---------------------------- */

  /**
   * 天气提醒（每天最多一次，而且只在真的有值得说的事时才开口）。
   *
   * 为什么要有「窗口」：如果早上 7:30 电脑没开，11:40 开机后突然收到
   * 「今天记得带伞」就没什么意义了。所以只在 at ~ at+windowMinutes 之间补，
   * 错过就等明天。
   */
  async tickWeather(now) {
    const cfg = getConfig();
    const conf = cfg.weather?.proactive;
    if (cfg.weather?.enabled === false || !conf?.enabled) return [];
    const at = parseHm(conf.at);
    if (at === null) return [];
    const minutes = now.getHours() * 60 + now.getMinutes();
    const windowMinutes = Math.max(0, Number(conf.windowMinutes) || 150);
    if (minutes < at || minutes > at + windowMinutes) return [];
    if (inQuietHours(cfg.chat.quietHours, now)) return [];

    let data;
    try {
      data = await forecast();
    } catch (error) {
      log.warn(`天气查询失败，今天就不说天气了：${error?.message ?? error}`);
      return [];
    }
    if (!data?.ok) {
      log.debug(`今天没有天气数据：${data?.error ?? "未知原因"}`);
      return [];
    }
    const alerts = selectedAlerts(buildAlerts(data));
    if (conf.onlyOnAlert !== false && !alerts.length) {
      log.debug(`${data.city}今天天气没什么特别的，不打扰`);
      return [];
    }

    const today = dayKey(now);
    const results = [];
    for (const peerId of this.targets()) {
      const jobKey = `weather:${today}:${peerId}`;
      if (!claimJob(jobKey, { kind: "weather", scopeKey: `private_${peerId}` })) continue;
      try {
        const hintLines = [
          `【今天的真实天气（可信数据）】位置：${data.city}${data.region ? `（${data.region}）` : ""}`,
          summarize(data),
          alerts.length ? `值得提醒的：${alerts.map((item) => item.text).join("；")}` : "",
          alerts.length ? `你要表达的重点：${alerts.map((item) => item.hint).join(" ")}` : "可以随口提一句天气，不用特意提醒什么。",
          "不要像天气预报一样播报温度，用你自己的话说，一句到两句。",
        ].filter(Boolean);
        const occasion = "早上主动跟对方说一句天气相关的话，重点是让对方今天过得舒服一点。";
        const content = (await this.compose({ occasion, peerId, kind: "weather", extra: hintLines.join("\n") })).text;
        const sent = await this.deliver({
          peerId,
          text: content,
          kind: "weather",
          meta: { city: data.city, alerts: alerts.map((item) => item.id) },
          idempotencyKey: jobKey,
        });
        if (sent) results.push({ kind: "weather", peerId, text: content, city: data.city, alerts: alerts.map((item) => item.id) });
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        log.warn(`天气提醒失败：${this.lastError}`);
      }
    }
    return results;
  }

  async tickProactive(now) {
    const cfg = getConfig();
    const conf = cfg.greet?.proactive;
    if (!conf?.enabled) return [];
    if (inQuietHours(conf.quietHours, now)) return [];
    const results = [];
    for (const peerId of this.targets()) {
      const state = this.proactiveState.get(peerId);
      const today = dayKey(now);

      // 用户刚聊过 → 跳过本轮（规划书 FR-501）
      const sessionRow = one("select max(at) as at from messages where scope_key = ? and direction = 'in'", [`private_${peerId}`]);
      const lastUserAt = Number(sessionRow?.at ?? 0);
      const quietMinutes = Math.max(0, Number(conf.skipIfTalkedWithinMinutes) || 60);
      if (lastUserAt && now.getTime() - lastUserAt < quietMinutes * MIN) {
        this.proactiveState.set(peerId, { ...state, nextAt: 0 });
        continue;
      }

      const target = (cfg.greet?.proactive?.targets ?? []).find((item) => String(item.userId) === String(peerId));
      const dailyMax = Math.max(0, Number(target?.dailyMax ?? 3));
      const maxUnanswered = Math.max(1, Number(conf.maxUnanswered) || 3);
      if (state.day !== today) {
        state.day = today;
        state.count = 0;
        state.nextAt = 0;
      }
      if (dailyMax && state.count >= dailyMax) continue;
      if (state.unanswered >= maxUnanswered) continue;
      if (state.backoffUntil && now.getTime() < state.backoffUntil) continue;

      if (!state.nextAt) {
        const min = Math.max(5, Number(target?.minMinutes) || 180);
        const max = Math.max(min, Number(target?.maxMinutes) || 480);
        state.nextAt = now.getTime() + (min + Math.random() * (max - min)) * MIN;
        this.proactiveState.set(peerId, state);
        continue;
      }
      if (now.getTime() < state.nextAt) continue;

      try {
        const character = this.character();
        const stateRow = decayState(character.id);
        const extra =
          conf.useLifeContext && Number(stateRow.social_drive) < 0.35
            ? "你现在有点没精神，语气可以再淡一点、短一点，不要勉强自己说很多。"
            : "";
        const occasion =
          "没什么特别的事，就是突然想起他，主动说一句。可以用你最近记得的小事当话头，也可以只是说说你自己此刻在做什么。";
        const content = (await this.compose({ occasion, peerId, kind: "proactive", extra })).text;
        const sent = await this.deliver({ peerId, text: content, kind: "proactive", idempotencyKey: `proactive:${peerId}:${today}:${state.count + 1}` });
        if (sent) {
          state.count += 1;
          state.unanswered = Number(state.unanswered) + 1;
          nudgeState(character.id, { socialDrive: -0.03, valence: 0.02 });
          results.push({ kind: "proactive", peerId, text: content });
        }
        const min = Math.max(5, Number(target?.minMinutes) || 180);
        const max = Math.max(min, Number(target?.maxMinutes) || 480);
        state.nextAt = now.getTime() + (min + Math.random() * (max - min)) * MIN;
        state.lastSentAt = now.getTime();
        this.proactiveState.set(peerId, state);
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        log.warn(`主动消息失败：${this.lastError}`);
        // 失败退避：指数增长但不超过 2 小时
        state.backoffUntil = now.getTime() + Math.min(120 * MIN, 15 * MIN * 2 ** Math.min(3, state.count));
        this.proactiveState.set(peerId, state);
      }
    }
    return results;
  }

  targets() {
    const cfg = getConfig();
    const list = (cfg.greet?.proactive?.targets ?? []).map((item) => String(item.userId || "")).filter(Boolean);
    if (list.length) return [...new Set(list)];
    const master = this.masterId();
    return master ? [master] : [];
  }

  /** 用户回话时调用：把「未回复计数」清掉，并记一点正向关系变化。 */
  noteUserReply(peerId) {
    const state = this.proactiveState.get(String(peerId));
    this.proactiveState.set(String(peerId), { ...state, unanswered: 0, backoffUntil: 0 });
    const character = this.character();
    nudgeState(character.id, { valence: 0.06, socialDrive: 0.05 });
  }

  /* ------------------------------- 主循环 ------------------------------- */

  async tick(now = new Date()) {
    this.lastTickAt = Date.now();
    if (pauseState.paused) return { skipped: true, reason: "自动化已暂停" };
    const meals = await this.tickMeals(now);
    const weather = await this.tickWeather(now);
    const holidays = await this.tickHolidays(now);
    const birthdays = await this.tickBirthdays(now);
    const reminders = await this.tickReminders(now);
    const proactive = await this.tickProactive(now);
    return { meals, weather, holidays, birthdays, reminders, proactive };
  }

  start(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => log.error(`调度异常：${error?.message ?? error}`));
    }, intervalMs);
    this.timer.unref?.();
    log.info("主动问候与提醒调度已启动（每 60 秒检查一次）");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* -------------------------------- 面板 -------------------------------- */

  snapshot() {
    const cfg = getConfig();
    const now = Date.now();
    return {
      active: this.lastSent,
      history: this.history.slice(0, 20),
      automationMode: cfg.greet?.automationMode ?? "limited_auto",
      paused: pauseState.snapshot(),
      proactive: {
        ...cfg.greet?.proactive,
        state: this.targets().map((peerId) => ({ peerId, ...this.proactiveState.get(peerId) })),
      },
      morning: cfg.greet?.morning ?? {},
      noon: cfg.greet?.noon ?? {},
      night: cfg.greet?.night ?? {},
      holidays: cfg.greet?.holidays ?? {},
      birthdays: cfg.greet?.birthdays ?? {},
      todayHolidays: todayHolidays(new Date()).map((item) => item.name),
      reminders: all("select * from reminders order by enabled desc, at asc limit 100").map((row) => ({
        ...row,
        atText: formatTime(row.at),
        enabled: Boolean(row.enabled),
      })),
      upcoming: all("select * from scheduled_jobs where state <> 'done' order by next_run asc limit 20"),
      pending: all("select * from outgoing where status in ('pending','unknown') order by created_at desc limit 20"),
      recentJobs: all("select * from job_runs order by at desc limit 20"),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      serverNow: now,
    };
  }
}

/* ------------------------------- 提醒管理 ------------------------------- */

export function addReminder({ targetId = "", text, at, repeatRule = "none", polish = true, advanceMinutes = 0, scopeKey = "" }) {
  const when = typeof at === "number" ? at : parseTime(at);
  if (!when) throw new Error("提醒时间看不懂，请用「2026-10-18 09:00」这种格式");
  const content = String(text ?? "").trim();
  if (!content) throw new Error("提醒内容不能为空");
  run(
    `insert into reminders(scope_key, target_id, text, at, repeat_rule, polish, advance_minutes, enabled, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [scopeKey, String(targetId), content, when, repeatRule, polish ? 1 : 0, Number(advanceMinutes) || 0, Date.now(), Date.now()],
  );
  return one("select * from reminders order by id desc limit 1");
}

export function updateReminder(id, patch) {
  const current = one("select * from reminders where id = ?", [Number(id)]);
  if (!current) throw new Error("提醒不存在");
  const next = { ...current, ...patch };
  if (patch.at !== undefined) {
    const when = typeof patch.at === "number" ? patch.at : parseTime(patch.at);
    if (!when) throw new Error("提醒时间看不懂");
    next.at = when;
  }
  run(
    `update reminders set target_id = ?, text = ?, at = ?, repeat_rule = ?, polish = ?, advance_minutes = ?, enabled = ?, updated_at = ?
     where id = ?`,
    [
      String(next.target_id),
      String(next.text),
      Number(next.at),
      next.repeat_rule,
      next.polish ? 1 : 0,
      Number(next.advance_minutes) || 0,
      next.enabled ? 1 : 0,
      Date.now(),
      Number(id),
    ],
  );
  return one("select * from reminders where id = ?", [Number(id)]);
}

export function deleteReminder(id) {
  run("delete from reminders where id = ?", [Number(id)]);
}

export function listReminders() {
  return all("select * from reminders order by enabled desc, at asc");
}

/* ------------------------------- 生日管理 ------------------------------- */

export function addBirthday({ peerId = "", name = "", monthDay, calendar = "solar", privacy = "private" }) {
  const md = String(monthDay ?? "").trim();
  if (!/^\d{2}-\d{2}$/.test(md)) throw new Error("生日要写成 MM-DD，例如 03-15");
  run("insert into anniversaries(kind, peer_id, name, month_day, calendar, privacy, enabled, created_at) values('birthday', ?, ?, ?, ?, ?, 1, ?)", [
    String(peerId),
    String(name),
    md,
    calendar,
    privacy,
    Date.now(),
  ]);
  return one("select * from anniversaries order by id desc limit 1");
}

export function deleteBirthday(id) {
  run("delete from anniversaries where id = ?", [Number(id)]);
}

export function listBirthdays() {
  return all("select * from anniversaries where kind = 'birthday' order by month_day asc");
}

export { audit, clamp, scopeLabel, retrieveMemories };
