/**
 * 配置与角色卡。
 *
 * 设计原则：
 *  - 所有字段都有默认值：缺文件、坏文件、缺字段都不会让服务起不来
 *  - deepMerge 只忽略 undefined：false / 0 / "" 都是用户真实想要的值
 *  - 默认值遵循规划书附录 A「推荐默认配置基线」：群聊仅 @、主动消息默认关闭、空间写操作默认审批
 *  - API Key 支持从环境变量 / DSH .env 自动发现一次，省掉第一次手填
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { paths, readJson, writeJson } from "./paths.mjs";
import { PROVIDERS, DEFAULT_TRIAL_KEY, findProvider, MAX_OUTPUT_TOKENS } from "./providers.mjs";
import { mergeProfile } from "./credentials.mjs";
import { NEXT_MEMORY, NEXT_INTERACTION, TB_OPTIONS } from "./next-options.mjs";

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = {
  nextMemory: NEXT_MEMORY,
  interaction: NEXT_INTERACTION,
  tb: TB_OPTIONS,
  configVersion: CONFIG_VERSION,
  bot: {
    /**
     * 机器人 QQ 号。**默认留空**：每个部署都不一样，写死一个号只会让别人的第一次启动连不上。
     * 面板「QQ 账号」里填，或者点「用协议端当前登录的号」自动读出来。
     */
    selfId: 0,
    masterId: 0,
    masterName: "指挥官",
    onebotWsUrl: "ws://127.0.0.1:3101/",
    onebotHttpUrl: "http://127.0.0.1:3100/",
    /**
     * 协议端访问令牌。**每台机器各自生成**，不写死任何公共值——
     * 留空时启动会自动生成一个随机令牌（见 index.mjs 的 ensureLocalToken）。
     */
    accessToken: "",
    panelHost: "127.0.0.1",
    panelPort: 5311,
  },
  activeCharacter: "example",
  /** 首次启动向导是否已完成。没有完成时，面板会强制引导，避免「装上了但不知道要填什么」。 */
  onboarding: { done: false, completedAt: 0, steps: {} },
  llm: {
    /** 当前使用的 Profile 名称（见 profiles）。 */
    activeProfile: "default",
    profiles: {
      default: {
        name: "默认",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "",
        model: "deepseek-flash",
        temperature: 1.15,
        maxTokens: 700,
        topP: 0.95,
        timeoutMs: 90000,
        maxConcurrency: 4,
        priceIn: 1,
        priceOut: 2,
        contextTokens: 131072,
        vision: true,
        enabled: true,
      },
    },
    /** 按任务路由到不同 Profile（规划书 FR-702）。 */
    taskRoutes: {
      chat: "default",
      moderation: "default",
      summary: "default",
      reflection: "default",
      intent: "default",
      qzone: "default",
    },
    systemSuffix: "",
    /** 供应商预设目录最后同步时间（面板展示用）。 */
    lastTestAt: 0,
    lastTestOk: false,
    lastTestMessage: "",
  },
  budget: {
    enabled: true,
    /** 全局日预算，单位与供应商报价一致（默认元）。0 = 不限制。 */
    globalDaily: 3,
    globalMonthly: 60,
    warnRatio: 0.8,
    /** 群聊 / 私聊分别的日预算。 */
    privateDaily: 1.5,
    groupDaily: 2,
    /** 触发熔断时的对外表现。 */
    onExceeded: "silent",
  },
  chat: {
    replyPrivate: true,
    privateMergeWindowSec: 3,
    privateMaxWaitSec: 15,
    waitForTyping: true,
    replyPrivateAutoEnable: false,
    greetOnFirstConnect: true,
    replyGroupAt: true,
    replyGroupAll: false,
    groupAllowList: [],
    typingDelayMs: 900,
    firstDelayMs: 700,
    maxReplyChars: 120,
    maxBubbles: 3,
    splitBubbles: true,
    useEmoji: true,
    /**
     * 对话活跃度 0~100。
     * 越高：一次回得更"多段"（往 maxBubbles 靠），并且更可能主动追一句继续聊；
     * 越低：一句就完，回得短，不追话。注意它只是「最多几条」的倾向，不是必须回这么多。
     */
    activity: 55,
    /** 主动追一句（在她刚回完之后，隔几秒再补一条，像真人接着说）。 */
    followUp: { enabled: true, chance: 0.5, delaySec: 9, maxPerTurn: 1 },
    /**
     * 反卡壳：她只说了开场白（「嗯，我按我理解的说哦，说得不对你别笑我呀。」）就停住时，
     * 自动再要一次「接着说」，把正文补在后面发出去。
     * 关掉的话会原样发出去——只有一句话没有后面，很难看，所以默认开着。
     */
    antiStall: true,
    quietHours: { enabled: false, from: "01:00", to: "07:00" },
    historyTurns: 16,
    rememberFacts: true,
    /** 群里连续多条消息合并成一个上下文快照的聚合窗口（规划书 15.6：5–20 秒）。 */
    groupMergeWindowSec: 8,
    /** 单条消息最多看几张图。 */
    maxImagesPerMessage: 3,
    /**
     * 对方发来的文件。
     * 只读文字类文件（txt/md/csv/代码…）和 .docx；图片、压缩包、PDF 一律老实说读不了。
     * maxChars 是塞进提示词的字数上限，超了留头留尾、中间标明省略——不然一个 6 万字的文件
     * 会把每一轮对话都撑爆。
     */
    files: { enabled: true, maxBytes: 2097152, maxChars: 12000, maxPerMessage: 3, keepTurns: 2 },
    /** 图片最大字节数。 */
    imageMaxBytes: 8388608,
    /** 发送前二次校验（是否已被拉黑 / 预算是否撤销）。 */
    preflightCheck: true,
    /**
     * 插件/技能的工具调用（function calling）。
     * 关掉后模型不再拿到任何扩展工具，但扩展的提示词片段与钩子仍然生效——
     * 适合「模型不支持 tools」或者不想让她自己动手（记账/发图/查数据）的场景。
     */
    toolsEnabled: true,
    /** 一轮对话里最多允许几轮工具调用（防止模型来回刷工具烧钱）。 */
    toolRounds: 6,
  },
  weather: {
    enabled: true,
    /** 手填城市（例如「杭州」）。留空就用 IP 自动定位。 */
    city: "",
    autoLocate: true,
    cacheMinutes: 30,
    proactive: {
      enabled: true,
      /** 每天什么时候提一次天气。 */
      at: "07:30",
      /** 过了这个分钟数就不再补发（避免中午突然收到"今天记得带伞"）。 */
      windowMinutes: 150,
      /** 只在有值得说的情况时才开口（晴天大太阳就不打扰）。 */
      onlyOnAlert: true,
      /**
       * 只有到这个级别才主动开口：
       *   warn —— 真的会影响出门（下雨/下雪/雷雨/骤降≥8℃/≥35℃/≤-5℃/大风≥50）
       *   info —— 有点影响，但不值得专门发一条
       *   soft —— 几乎不算事
       * 默认 warn：预报是市级的，一个市里几个区天气可能完全不一样，
       * 拿「可能有零星小雨」去打扰人只会招烦。
       */
      minLevel: "warn",
      /** 允许主动说的天气类型，见 weather.ALERT_KINDS。 */
      kinds: ["rain", "snow", "thunder", "temp_drop", "heat", "cold", "wind"],
    },
  },
  group: {
    allowList: [],
    denyList: [],
    memberSync: { enabled: true, intervalMinutes: 30 },
    defaultAttitude: "普通的群友，礼貌但不熟。",
    memberOverrides: {},
    groupOverrides: {},
    rate: {
      enabled: true,
      applyToPrivate: true,
      perUserPerHour: 30,
      perUserPerDay: 200,
      perGroupPerHour: 60,
      perGroupPerDay: 400,
      globalPerDay: 1200,
      minGapSeconds: 15,
      maxConsecutive: 8,
      silentMinutes: 20,
    },
    filter: {
      enabled: true,
      words: [],
      regex: [],
      /** warn_then_block（默认）| warn_only | block_now | log_only */
      action: "warn_then_block",
      maxWarnings: 1,
      warnSource: "fixed",
      warnText: "……这句话心语不太想接呢，换个说法好不好？",
      warnTemplate: "以心语的口吻，用一句话提醒对方：不要在群里说「{word}」这类话。语气温柔但认真，不要解释规则，不要提「屏蔽词」三个字，一句就够了。",
      warnCooldownMinutes: 15,
      notifyMaster: true,
      /** group（默认，只管群）| all */
      scope: "group",
      /** 计数策略：permanent | rolling | daily */
      countPolicy: "permanent",
      countWindowHours: 24,
    },
    /** 群消息回复方式默认值，可被成员策略覆盖。 */
    defaultTrigger: "at",
  },
  memory: {
    enabled: true,
    summaryEnabled: true,
    summaryEveryMessages: 24,
    summaryMaxChars: 300,
    injectSummary: true,
    injectExperiences: 6,
    injectDiary: 2,
    injectFacts: 12,
    /** 检索评分权重（规划书 15.2）。 */
    scoreWeights: { relevance: 0.4, importance: 0.25, recency: 0.2, confidence: 0.15 },
    maxCandidates: 40,
    /** 事实提取（长期记忆归档）开关与周期。 */
    extractEnabled: true,
    extractEveryMinutes: 120,
    extractMinNewMessages: 12,
    /** 跨场景授权共享默认关闭（规划书 FR-307）。 */
    allowCrossScopeShare: false,
    /** 原始聊天记录保留天数，0 = 永久。 */
    rawRetentionDays: 0,
  },
  life: {
    enabled: true,
    archive: {
      enabled: true,
      everyMinutes: 120,
      minNewMessages: 12,
      maxEntriesPerRun: 3,
      fromHour: 7,
      toHour: 23,
    },
    diary: { enabled: true, at: "22:30", keepDays: 90 },
    reflection: { enabled: true, minEvidence: 3, everyHours: 24, maxPerRun: 2 },
    state: { enabled: true, decayPerHour: 0.04 },
    relationship: { enabled: true, maxDeltaPerEvent: 0.05, smoothing: 0.3 },
    /** 模拟生活（标记 simulated，不与真实互动混淆）。 */
    simulated: { enabled: false, enabledAt: 0 },
    manualScopes: [],
  },
  greet: {
    proactive: {
      enabled: false,
      useLifeContext: true,
      quietHours: { enabled: true, from: "23:30", to: "07:30" },
      targets: [],
      /** 连续 N 次主动消息无人回复后自动停手（规划书 FR-505）。 */
      maxUnanswered: 3,
      skipIfTalkedWithinMinutes: 60,
      jitterRatio: 0.3,
    },
    morning: { enabled: false, at: "08:30", text: "", workdayOnly: false, randomDelayMinutes: 0 },
    noon: { enabled: false, at: "12:30", text: "", workdayOnly: false, randomDelayMinutes: 0 },
    night: { enabled: false, at: "23:00", text: "", workdayOnly: false, randomDelayMinutes: 0 },
    holidays: { enabled: true, builtin: true, custom: [] },
    birthdays: { enabled: true, list: [] },
    reminders: { enabled: true, list: [], offlinePolicy: "skip" },
    /** 完全手动 / 待审核 / 有限自动（规划书 FR-506）。 */
    automationMode: "limited_auto",
  },
  qzone: {
    enabled: false,
    autoPost: {
      enabled: false,
      requireApproval: true,
      minIntervalMinutes: 180,
      maxIntervalMinutes: 420,
      ugcRight: 1,
      imagePool: [],
      maxImages: 1,
      hint: "",
    },
    autoReact: {
      enabled: false,
      requireApproval: true,
      targets: [],
      selfSpace: true,
      like: true,
      comment: true,
      commentChance: 0.7,
      scanIntervalMinutes: 10,
      maxAgeHours: 48,
      maxPerRun: 3,
    },
    manualCommentStyle: "温柔自然，像女朋友在动态下撒娇或者关心，不要太长，不要用括号写动作。",
  },
};

function discoverApiKey() {
  if (process.env.HEARTECHO_API_KEY) return process.env.HEARTECHO_API_KEY.trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const candidates = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh", ".env") : null,
    process.env.HOME ? path.join(process.env.HOME, ".dsh", ".env") : null,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const match = fs.readFileSync(file, "utf8").match(/^\s*(?:HEARTECHO_API_KEY|DEEPSEEK_API_KEY)\s*=\s*"?([^"\r\n]+)"?\s*$/m);
      if (match) return match[1].trim();
    } catch {
      /* 没有就算了 */
    }
  }
  return "";
}

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== "object" || typeof patch !== "object" || base === null || patch === null) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

let cached = null;

function normalize(config) {
  const next = structuredClone(config);
  // 供应商预设校正：用户选的是预设，但 BaseUrl 被改过时不做覆盖，只补空缺
  const profiles = next.llm?.profiles ?? {};
  for (const [id, profile] of Object.entries(profiles)) {
    const provider = findProvider(profile.provider);
    if (provider && !String(profile.baseUrl ?? "").trim() && provider.baseUrl) profile.baseUrl = provider.baseUrl;
    profile.name ||= provider?.name ?? id;
    profile.maxTokens = Math.max(64, Math.min(MAX_OUTPUT_TOKENS, Number(profile.maxTokens) || 700));
    profile.temperature = Math.max(0, Math.min(2, Number(profile.temperature ?? 1.15)));
  }
  if (!profiles[next.llm.activeProfile]) next.llm.activeProfile = Object.keys(profiles)[0] ?? "default";
  return next;
}

export function loadConfig() {
  const raw = readJson(paths.config, {});
  const merged = normalize(deepMerge(structuredClone(DEFAULT_CONFIG), raw));
  if (!merged.llm.profiles.default.apiKey && raw.llm?.profiles?.default?.apiKey === undefined &&
      merged.llm.profiles.default.baseUrl === DEFAULT_CONFIG.llm.profiles.default.baseUrl) {
    const discovered = discoverApiKey() || DEFAULT_TRIAL_KEY;
    if (discovered) merged.llm.profiles.default.apiKey = discovered;
  }
  merged.configVersion = CONFIG_VERSION;
  cached = merged;
  return merged;
}

export function getConfig() {
  if (!cached) loadConfig();
  return cached;
}

export function saveConfig(patch) {
  const current = getConfig();
  const next = normalize(deepMerge(current, patch ?? {}));
  for (const [id, profilePatch] of Object.entries(patch?.llm?.profiles ?? {})) {
    next.llm.profiles[id].apiKey = mergeProfile(current.llm.profiles[id], profilePatch).apiKey ?? "";
  }
  writeJson(paths.config, next);
  cached = next;
  return next;
}

export function patchConfig(section, patch) {
  return saveConfig({ [section]: patch });
}

export function ensureConfigFile() {
  if (!fs.existsSync(paths.config)) writeJson(paths.config, getConfig());
}

/**
 * 确保本机有一个自己的协议端访问令牌。
 *
 * 为什么不在默认配置里写死一个：仓库是公开的，写死的令牌等于「全世界共用一个口令」。
 * 这里第一次启动时随机生成一个，只存在本机的 config.json 里。
 */
export function ensureLocalToken() {
  const cfg = getConfig();
  if (String(cfg.bot?.accessToken ?? "").trim()) return { token: cfg.bot.accessToken, created: false };
  const token = `he-${randomBytes(18).toString("hex")}`;
  saveConfig({ bot: { accessToken: token } });
  return { token, created: true };
}

/** 当前生效的模型 Profile（带任务路由）。 */
export function profileFor(task = "chat") {
  const cfg = getConfig();
  const id = cfg.llm.taskRoutes?.[task] || cfg.llm.activeProfile;
  const profile = cfg.llm.profiles?.[id] ?? cfg.llm.profiles?.[cfg.llm.activeProfile] ?? Object.values(cfg.llm.profiles ?? {})[0];
  return { id, profile, provider: findProvider(profile?.provider) };
}

export function listProfiles() {
  const cfg = getConfig();
  return Object.entries(cfg.llm.profiles ?? {}).map(([id, profile]) => ({
    id,
    ...profile,
    providerName: findProvider(profile.provider)?.name ?? profile.provider,
  }));
}

/* ---------------------------- 对话风格（长度/条数/活跃度） ---------------------------- */

/** 回复长度的三档预设。用户也可以直接填字数。 */
export const LENGTH_PRESETS = [
  { id: "short", label: "短（一句就够）", chars: 60 },
  { id: "medium", label: "中（正常聊天）", chars: 120 },
  { id: "long", label: "长（愿意多说几句）", chars: 220 },
];

export const ACTIVITY_PRESETS = [
  { id: "quiet", label: "安静", value: 15, note: "一句就完，几乎不追话" },
  { id: "normal", label: "正常", value: 55, note: "大多数时候 1~2 条，偶尔追一句" },
  { id: "lively", label: "活泼", value: 80, note: "常常分几条发，比较会追话" },
  { id: "clingy", label: "黏人", value: 100, note: "尽量多条，几乎每条都会接着说" },
];

function clampNum(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/**
 * 把「长度 / 最多几条 / 活跃度」翻译成生成时的具体参数。
 *
 * 关键：maxBubbles 是**上限**，不是必须发这么多条。
 * wantBubbles 只是「这次最多想要几条」，活跃度越高越接近上限，
 * 实际发几条仍然由模型按内容决定（短回复就是一条，不会为了凑数硬拆）。
 */
export function replyStyle() {
  const cfg = getConfig();
  const chat = cfg.chat ?? {};
  const maxChars = clampNum(chat.maxReplyChars, 20, 600);
  const maxBubbles = Math.round(clampNum(chat.maxBubbles, 1, 8));
  const activity = Math.round(clampNum(chat.activity, 0, 100));
  // 活跃度 → 想要几条：0 → 1 条；100 → 上限
  const wantBubbles = Math.max(1, Math.min(maxBubbles, 1 + Math.round(((maxBubbles - 1) * activity) / 100)));
  const followUp = chat.followUp ?? {};
  const followUpEnabled = followUp.enabled !== false && maxBubbles >= 1;
  const followUpChance = followUpEnabled
    ? clampNum(Number(followUp.chance ?? 0.5) * (activity / 100), 0, 0.95)
    : 0;
  return {
    maxChars,
    maxBubbles,
    activity,
    wantBubbles,
    followUpEnabled,
    followUpChance,
    followUpDelaySec: clampNum(followUp.delaySec ?? 9, 2, 120),
    followUpMaxPerTurn: Math.round(clampNum(followUp.maxPerTurn ?? 1, 0, 3)),
    /** 给提示词用的一句话指令。 */
    instruction: (() => {
      if (activity <= 25) {
        return `一次只回一句，${maxChars} 字以内，别啰嗦，别追问太多。`;
      }
      if (activity <= 60) {
        return `一次回 1~${wantBubbles} 句，总共不超过 ${maxChars} 字；想说的多就分成几行。`;
      }
      return `这次可以回 ${wantBubbles} 条短消息（最多 ${maxBubbles} 条），每条都是一两句口语，像真人一边想一边打字；如果没什么可说的，一条也完全可以。`;
    })(),
  };
}

/* ---------------------------------- 角色卡 --------------------------------- */

const ID_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{1,40}$/;

export function characterPath(id) {
  if (!ID_PATTERN.test(String(id ?? ""))) throw new Error("角色 id 不合法（只允许中英文、数字、下划线、短横线）");
  return path.join(paths.characters, `${id}.json`);
}

export function listCharacters() {
  try {
    return fs
      .readdirSync(paths.characters)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.basename(name, ".json"));
  } catch {
    return [];
  }
}

export const CHARACTER_FIELDS = [
  { key: "name", label: "角色名", required: true, hint: "别人怎么叫她" },
  { key: "title", label: "头衔 / 一句话身份", hint: "例如「某艘驱逐舰的四号舰」或「隔壁面包店的学徒」" },
  { key: "worldview", label: "世界观", hint: "她生活在哪个世界：年代、地点、有没有奇幻/科幻设定、社会怎么运作" },
  { key: "persona", label: "她是谁（基础人设）", hint: "出身、身份、日常在做什么" },
  { key: "appearance", label: "外貌特征", hint: "只在她自然提到时才会用到，不必写太细" },
  { key: "personality", label: "性格", hint: "越像人话，她演得越准" },
  { key: "speechStyle", label: "说话风格", hint: "称呼、语气、口头禅、句尾习惯" },
  { key: "habits", label: "行为习惯", hint: "她平时的小动作与小毛病" },
  { key: "relations", label: "人际关系", hint: "和对方、和其他人的关系" },
  { key: "boundaries", label: "边界与底线", hint: "她不会做的事、不愿意聊的话题" },
  { key: "user", label: "关于对方（你）", hint: "姓名、性别、职业、所在城市、喜好、雷点 —— 她会把这些当成早就知道的事" },
  { key: "greeting", label: "第一句话", hint: "第一次连上 QQ 时主动发的那句" },
  { key: "exampleDialogue", label: "说话示例", hint: "几组对话，她照着这个语气说话" },
  { key: "extras", label: "补充设定", hint: "任何还想告诉她的东西" },
];

/** 「关于对方」的字段定义（面板会按这个顺序渲染）。 */
export const USER_FIELDS = [
  { key: "name", label: "对方的名字 / 昵称", hint: "她可以用名字叫你" },
  { key: "gender", label: "性别" },
  { key: "age", label: "年龄" },
  { key: "occupation", label: "职业 / 身份", hint: "学生、程序员、医生……" },
  { key: "city", label: "所在城市", hint: "和天气功能可以填同一个城市" },
  { key: "likes", label: "喜欢的东西", hint: "吃的、玩的、习惯" },
  { key: "dislikes", label: "不喜欢 / 忌口", hint: "她不会再推荐这些" },
  { key: "taboos", label: "雷区与禁忌", hint: "绝对不能提的话题" },
  { key: "notes", label: "其他设定", hint: "作息、口头习惯、你们的关系背景" },
];

export const EMPTY_USER = {
  name: "",
  gender: "",
  age: "",
  occupation: "",
  city: "",
  likes: "",
  dislikes: "",
  taboos: "",
  notes: "",
};

export const LOCKABLE_FIELDS = ["name", "worldview", "persona", "personality", "speechStyle", "boundaries"];

export function loadCharacter(id) {
  const char = readJson(characterPath(id), null);
  if (!char) throw new Error(`角色不存在：${id}`);
  return char;
}

export function activeCharacterId() {
  const cfg = getConfig();
  const ids = listCharacters();
  if (ids.includes(cfg.activeCharacter)) return cfg.activeCharacter;
  return ids[0] ?? "example";
}

export function activeCharacter() {
  const id = activeCharacterId();
  try {
    return loadCharacter(id);
  } catch {
    return {
      id,
      name: "心语",
      title: "",
      persona: "（角色卡还没建立，请在面板「角色工作室」里创建）",
      speechStyle: "语气自然，称呼对方为「你」。",
      greeting: "你好呀，我在的哦。",
    };
  }
}

const CHARACTER_TEMPLATE = {
  id: "",
  name: "未命名",
  title: "",
  avatar: "",
  worldview: "",
  persona: "",
  appearance: "",
  habits: "",
  personality: "",
  speechStyle: "",
  relations: "",
  boundaries: "",
  user: { ...EMPTY_USER },
  userOwnerId: "",
  userAccountId: "",
  greeting: "",
  exampleDialogue: "",
  extras: "",
  locked: [],
  version: 1,
  updatedAt: "",
};

export function saveCharacter(id, patch, { bumpVersion = false, create = false, requireExisting = false } = {}) {
  let current = {};
  const file = characterPath(id);
  if (!create) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`角色文件无法读取，原文件未修改：${error.message}`);
      if (requireExisting) throw new Error("角色不存在或已被删除，请刷新列表");
    }
    if (raw !== undefined) {
      try {
        current = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("角色内容不是对象");
      } catch (error) {
        throw new Error(`角色文件损坏，原文件未修改：${error.message}`);
      }
    }
  }
  const locked = Array.isArray(current.locked) ? current.locked : [];
  const incoming = { ...(patch ?? {}) };
  // 锁定字段在未显式解锁时不允许被覆盖（FR-105：用户输入不能改核心人格）
  for (const field of locked) {
    if (field in incoming && incoming[field] !== current[field]) delete incoming[field];
  }
  const next = {
    ...CHARACTER_TEMPLATE,
    ...current,
    ...incoming,
    id,
    version: Number(current.version ?? 1) + (bumpVersion ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  // 「关于对方」是小对象：允许部分更新，且空字符串字段会被保留（用户就是清空了它）
  next.user = { ...EMPTY_USER, ...(typeof current.user === "object" && current.user ? current.user : {}), ...(typeof incoming.user === "object" && incoming.user ? incoming.user : {}) };
  if (typeof incoming.user === "string") next.user = { ...EMPTY_USER, notes: incoming.user };
  for (const field of ["userOwnerId", "userAccountId"]) {
    next[field] = String(next[field] ?? "").trim();
    if (next[field] && !/^[1-9][0-9]*$/.test(next[field])) throw new Error("私人档案的所属 QQ 和机器人 QQ 必须是有效数字账号");
  }
  if (create) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.readdirSync(paths.characters).some((existing) => existing.toLowerCase() === `${id}.json`.toLowerCase())) {
      throw new Error("角色已存在，请重新创建，原角色没有被覆盖");
    }
    try {
      fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx" });
      if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(next)) {
        throw new Error("角色写入后校验失败，请检查数据目录");
      }
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("角色已存在，请重新创建，原角色没有被覆盖");
      throw error;
    }
  } else {
    writeJson(file, next);
  }
  return next;
}

export function deleteCharacter(id) {
  if (listCharacters().length <= 1) throw new Error("至少要保留一个角色");
  fs.rmSync(characterPath(id), { force: true });
  if (getConfig().activeCharacter === id) saveConfig({ activeCharacter: listCharacters()[0] });
}

export function newCharacterId(name) {
  const base =
    String(name || "character")
      .replace(/[^\w\u4e00-\u9fa5-]/g, "")
      .slice(0, 32) || "character";
  const safeBase = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `${base}_` : base;
  const ids = new Set(fs.existsSync(paths.characters) ? fs.readdirSync(paths.characters)
    .filter((file) => /\.json$/i.test(file)).map((file) => file.slice(0, -5).toLowerCase()) : []);
  let id = safeBase;
  let i = 2;
  while (ids.has(id.toLowerCase())) id = `${safeBase}${i++}`;
  return id;
}

export function cloneCharacter(sourceId, name) {
  const source = loadCharacter(sourceId);
  const id = newCharacterId(name || `${source.name}副本`);
  return saveCharacter(id, { ...source, id, name: name || `${source.name}副本`, version: 1 }, { create: true });
}

export { deepMerge, findProvider, PROVIDERS };
