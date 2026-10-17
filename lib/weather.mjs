/**
 * 天气与位置（规划书 08「主动社交」的延伸能力）。
 *
 * 要解决的事：每天早上看一眼天气，用她自己的话提醒一句（下雨带伞、降温加衣服、高温别出门）。
 *
 * 三个来源，按可靠性排序：
 *   ① 用户在面板里手填的城市 —— 最可靠，先地理编码再查天气；
 *   ② 用公网 IP 猜位置 —— 不用任何权限，绝大多数情况下能猜到一个城市级别的位置；
 *   ③ 都没有就老老实实说「不知道你在哪」，绝不让她自己编一个城市出来。
 *
 * 所有网络请求都带超时、都吞异常：没网、接口挂了、被限流，只会让「今天不说天气」，
 * 不会影响聊天与其它主动消息。
 *
 * 数据来源（都不需要 API Key）：
 *   - 位置猜测：https://ipapi.co/json/（失败退 http://ip-api.com/json/）
 *   - 地理编码 + 天气：Open-Meteo（免费、无 Key、返回 JSON）
 */
import fs from "node:fs";
import path from "node:path";
import { paths, readJson, writeJson } from "./paths.mjs";
import { getConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("Weather");

const CACHE_FILE = path.join(paths.state, "weather.json");
const LOCATION_TTL = 12 * 3600000; // 位置猜一次用半天
const FORECAST_TTL = 30 * 60000; // 天气缓存 30 分钟

/** WMO 天气代码 → 中文说法。Open-Meteo 用的就是这套码。 */
const WMO = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "有雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "细雨",
  56: "冻雨",
  57: "冻雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "雷暴伴冰雹",
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const THUNDER_CODES = new Set([95, 96, 99]);

export function weatherLabel(code) {
  return WMO[Number(code)] ?? "天气不明";
}

export function weatherKind(code) {
  const value = Number(code);
  if (THUNDER_CODES.has(value)) return "thunder";
  if (SNOW_CODES.has(value)) return "snow";
  if (RAIN_CODES.has(value)) return "rain";
  return "clear";
}

/** 给面板用的天气图标名（前端有对应图标）。 */
export function weatherIcon(code) {
  const kind = weatherKind(code);
  if (kind === "thunder") return "cloudRain";
  if (kind === "snow") return "cloudRain";
  if (kind === "rain") return "cloudRain";
  if (Number(code) <= 1) return "sun";
  return "cloud";
}

/* ------------------------------- 缓存 ------------------------------- */

function readCache() {
  const raw = readJson(CACHE_FILE, {});
  return raw && typeof raw === "object" ? raw : {};
}

function writeCache(patch) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeJson(CACHE_FILE, { ...readCache(), ...patch });
  } catch (error) {
    log.warn(`天气缓存写入失败（不影响使用）：${error?.message ?? error}`);
  }
}

export function clearCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/* ---------------------------- 网络小工具 ---------------------------- */

async function getJson(url, { timeoutMs = 9000 } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "HeartEcho/1.0 (local companion app)", Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* ------------------------------- 定位 ------------------------------- */

/** 用公网 IP 猜一个城市级位置（不需要系统定位权限）。 */
async function locateByIp() {
  const sources = [
    {
      name: "ipapi.co",
      url: "https://ipapi.co/json/",
      map: (json) => ({
        city: json.city || json.region || "",
        region: json.region || "",
        country: json.country_name || json.country || "",
        lat: Number(json.latitude),
        lon: Number(json.longitude),
      }),
    },
    {
      name: "ip-api.com",
      url: "http://ip-api.com/json/?lang=zh-CN&fields=status,city,regionName,country,lat,lon",
      map: (json) => (json?.status === "success"
        ? { city: json.city || json.regionName || "", region: json.regionName || "", country: json.country || "", lat: Number(json.lat), lon: Number(json.lon) }
        : null),
    },
  ];
  const errors = [];
  for (const source of sources) {
    try {
      const json = await getJson(source.url);
      const mapped = source.map(json);
      if (mapped && Number.isFinite(mapped.lat) && Number.isFinite(mapped.lon) && mapped.city) {
        return { ...mapped, source: `ip:${source.name}`, at: Date.now() };
      }
      errors.push(`${source.name}：没有返回可用的城市`);
    } catch (error) {
      errors.push(`${source.name}：${error?.message ?? error}`);
    }
  }
  return { error: errors.join("；") };
}

/** 城市名 → 经纬度（中文城市名直接可用）。 */
export async function geocodeCity(name) {
  const query = String(name ?? "").trim();
  if (!query) throw new Error("城市名不能为空");
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`;
  const json = await getJson(url);
  const hit = json?.results?.[0];
  if (!hit) throw new Error(`没找到「${query}」这个城市`);
  return {
    city: hit.name || query,
    region: hit.admin1 || "",
    country: hit.country || "",
    lat: Number(hit.latitude),
    lon: Number(hit.longitude),
    timezone: hit.timezone || "",
    source: "manual",
    at: Date.now(),
  };
}

/**
 * 当前认定的位置。
 * 优先用配置里手填的城市（用户说的最算），否则用 IP 猜，猜过就用缓存。
 */
export async function locate({ force = false } = {}) {
  const cfg = getConfig();
  const weather = cfg.weather ?? {};
  const manual = String(weather.city ?? "").trim();
  const cache = readCache();

  if (manual) {
    if (!force && cache.location?.source === "manual" && cache.location?.query === manual) return { ...cache.location, cached: true };
    try {
      const found = await geocodeCity(manual);
      const next = { ...found, query: manual };
      writeCache({ location: next, locationAt: Date.now() });
      return next;
    } catch (error) {
      // 手填城市查不到时，退回上次成功的位置，别直接失效
      if (cache.location) return { ...cache.location, cached: true, warning: `「${manual}」没查到，先用上次的位置` };
      return { error: String(error?.message ?? error), manual };
    }
  }

  if (weather.autoLocate === false) {
    return { error: "没有设置城市，而且自动定位已关闭" };
  }

  if (!force && cache.location && Date.now() - Number(cache.locationAt ?? 0) < LOCATION_TTL) {
    return { ...cache.location, cached: true };
  }

  const guessed = await locateByIp();
  if (guessed.error) {
    if (cache.location) return { ...cache.location, cached: true, warning: `这次没定位到（${guessed.error}），先用上次的位置` };
    return { error: `定位失败：${guessed.error}` };
  }
  writeCache({ location: guessed, locationAt: Date.now() });
  return guessed;
}

/* ------------------------------- 天气 ------------------------------- */

function normalizeForecast(json, location) {
  const daily = json?.daily ?? {};
  const days = (daily.time ?? []).map((date, index) => ({
    date,
    code: Number(daily.weather_code?.[index] ?? -1),
    text: weatherLabel(daily.weather_code?.[index]),
    kind: weatherKind(daily.weather_code?.[index]),
    max: Number(daily.temperature_2m_max?.[index]),
    min: Number(daily.temperature_2m_min?.[index]),
    rainProb: Number(daily.precipitation_probability_max?.[index] ?? 0),
    rainSum: Number(daily.precipitation_sum?.[index] ?? 0),
    windMax: Number(daily.wind_speed_10m_max?.[index] ?? 0),
    uvMax: Number(daily.uv_index_max?.[index] ?? 0),
  })).filter((item) => item.date);

  const current = json?.current
    ? {
        temp: Number(json.current.temperature_2m),
        feels: Number(json.current.apparent_temperature),
        code: Number(json.current.weather_code),
        text: weatherLabel(json.current.weather_code),
        kind: weatherKind(json.current.weather_code),
        wind: Number(json.current.wind_speed_10m ?? 0),
        humidity: Number(json.current.relative_humidity_2m ?? 0),
        at: Date.now(),
      }
    : null;

  return {
    city: location.city,
    region: location.region || "",
    country: location.country || "",
    timezone: json?.timezone || location.timezone || "",
    source: location.source,
    today: days[0] ?? null,
    tomorrow: days[1] ?? null,
    days,
    current,
    fetchedAt: Date.now(),
  };
}

/** 查天气。缓存 30 分钟，force 可以强制刷新。 */
export async function forecast({ force = false } = {}) {
  const cfg = getConfig();
  const weather = cfg.weather ?? {};
  const cache = readCache();
  const ttl = Math.max(5, Number(weather.cacheMinutes) || 30) * 60000;

  if (!force && cache.forecast && Date.now() - Number(cache.forecastAt ?? 0) < ttl) {
    return { ...cache.forecast, cached: true };
  }

  const location = await locate({ force });
  if (location.error) return { ok: false, error: location.error, location: null };

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${location.lat}&longitude=${location.lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max" +
    "&forecast_days=3&timezone=auto&wind_speed_unit=kmh";

  try {
    const json = await getJson(url);
    const data = { ok: true, ...normalizeForecast(json, location) };
    writeCache({ forecast: data, forecastAt: Date.now(), location });
    return data;
  } catch (error) {
    if (cache.forecast) {
      return { ...cache.forecast, cached: true, warning: `这次没查到天气（${error?.message ?? error}），显示的是上次的结果` };
    }
    return { ok: false, error: `查天气失败：${error?.message ?? error}`, location };
  }
}

/* ---------------------------- 值得提醒的点 ---------------------------- */

export const ALERT_KINDS = [
  { id: "rain", label: "有雨（提醒带伞）" },
  { id: "snow", label: "下雪" },
  { id: "thunder", label: "雷雨" },
  { id: "temp_drop", label: "明显降温" },
  { id: "heat", label: "高温" },
  { id: "cold", label: "低温 / 结冰" },
  { id: "wind", label: "大风" },
  { id: "uv", label: "紫外线强" },
];

/**
 * 从预报里挑出「值得专门提一句」的情况。
 *
 * level 决定它够不够格触发一次主动消息：
 *   warn  —— 真的会影响出门（下雨/下雪/雷雨/骤降/酷热/严寒/大风），默认只有这些才主动开口
 *   info  —— 有点影响，可以顺口提，但不值得专门发一条
 *   soft  —— 几乎不算事（零星小雨、紫外线强），只在聊天里顺带说说
 *
 * 注意：这里的 hint 只给「一次性主动提醒」用。日常聊天里绝不能用这种命令口吻，
 * 否则她每一句都会拐到天气上去（这是踩过的坑）。
 */
export function buildAlerts(data) {
  if (!data?.ok || !data.today) return [];
  const today = data.today;
  const tomorrow = data.tomorrow;
  const out = [];
  const push = (alert) => out.push({ level: "info", ...alert });

  if (today.kind === "thunder") {
    push({ id: "thunder", level: "warn", text: `今天${today.text}`, hint: `今天有雷雨（${today.text}），提醒对方别在空旷处久留、注意收好阳台的东西，语气关切但别吓人。` });
  }
  if (today.kind === "rain") {
    push({
      id: "rain",
      level: today.rainProb >= 60 || today.rainSum >= 3 ? "warn" : "info",
      text: `今天${today.text}，降雨概率 ${Math.round(today.rainProb)}%`,
      hint: `今天会下雨（${today.text}，降雨概率 ${Math.round(today.rainProb)}%），提醒对方带伞，再顺一句别淋湿。`,
    });
  } else if (today.rainProb >= 50 || today.rainSum >= 1) {
    push({
      id: "rain",
      level: today.rainProb >= 60 ? "warn" : "info",
      text: `今天可能有雨，降雨概率 ${Math.round(today.rainProb)}%`,
      hint: `预报说今天可能下雨（降雨概率 ${Math.round(today.rainProb)}%），提醒对方带伞以防万一。`,
    });
  } else if (today.rainProb >= 30) {
    push({ id: "rain", level: "soft", text: `今天可能有零星小雨（${Math.round(today.rainProb)}%）`, hint: `今天降雨概率 ${Math.round(today.rainProb)}%，有点悬，可以提一句带着伞。` });
  }
  if (today.kind === "snow") {
    push({ id: "snow", level: "warn", text: `今天${today.text}`, hint: `今天下雪（${today.text}），提醒对方注意路滑、多穿一点。` });
  }

  const drop = tomorrow && Number.isFinite(today.max) && Number.isFinite(tomorrow.max) ? today.max - tomorrow.max : 0;
  if (drop >= 8) {
    push({
      id: "temp_drop",
      level: "warn",
      text: `明天比今天低 ${Math.round(drop)}℃`,
      hint: `明天最高温只有 ${Math.round(tomorrow.max)}℃，比今天低 ${Math.round(drop)}℃，提醒对方明天加衣服。`,
    });
  } else if (drop >= 5) {
    push({
      id: "temp_drop",
      text: `明天比今天低 ${Math.round(drop)}℃`,
      hint: `明天最高温 ${Math.round(tomorrow.max)}℃，比今天凉一些，可以提一句明天加件外套。`,
    });
  }

  if (Number.isFinite(today.max) && today.max >= 35) {
    push({ id: "heat", level: "warn", text: `最高 ${Math.round(today.max)}℃`, hint: `今天最高 ${Math.round(today.max)}℃，提醒对方别在中午出门、多喝水。` });
  } else if (Number.isFinite(today.max) && today.max >= 33) {
    push({ id: "heat", text: `最高 ${Math.round(today.max)}℃`, hint: `今天最高 ${Math.round(today.max)}℃，有点热，可以提醒对方注意补水。` });
  }
  if (Number.isFinite(today.min) && today.min <= -5) {
    push({ id: "cold", level: "warn", text: `最低 ${Math.round(today.min)}℃`, hint: `今天最低 ${Math.round(today.min)}℃，会结冰，提醒对方穿厚一点、出门当心路滑。` });
  } else if (Number.isFinite(today.min) && today.min <= 0) {
    push({ id: "cold", text: `最低 ${Math.round(today.min)}℃`, hint: `今天最低 ${Math.round(today.min)}℃，有可能结冰，可以提醒对方穿厚一点。` });
  }
  if (Number.isFinite(today.windMax) && today.windMax >= 50) {
    push({ id: "wind", level: "warn", text: `阵风 ${Math.round(today.windMax)} km/h`, hint: `今天风很大（阵风约 ${Math.round(today.windMax)} km/h），提醒对方注意别被吹着、收好晾在外面的衣服。` });
  } else if (Number.isFinite(today.windMax) && today.windMax >= 39) {
    push({ id: "wind", text: `阵风 ${Math.round(today.windMax)} km/h`, hint: `今天风有点大（阵风约 ${Math.round(today.windMax)} km/h），可以提一句。` });
  }
  if (Number.isFinite(today.uvMax) && today.uvMax >= 8) {
    push({ id: "uv", level: "soft", text: `紫外线指数 ${Math.round(today.uvMax)}`, hint: `今天紫外线挺强（指数 ${Math.round(today.uvMax)}），可以提醒对方防晒。` });
  }
  const order = { warn: 0, info: 1, soft: 2 };
  return out.sort((a, b) => (order[a.level] ?? 1) - (order[b.level] ?? 1));
}

/** 按配置筛出允许的提醒类型。 */
export function selectedAlerts(alerts) {
  const cfg = getConfig();
  const kinds = cfg.weather?.proactive?.kinds;
  const list = Array.isArray(kinds) && kinds.length ? kinds : ALERT_KINDS.map((item) => item.id);
  return alerts.filter((item) => list.includes(item.id));
}

/** 值得专门发一条主动消息的提醒（只有 warn 级，且类型被允许）。 */
export function actionableAlerts(alerts) {
  const cfg = getConfig();
  const minLevel = cfg.weather?.proactive?.minLevel || "warn";
  const rank = { warn: 0, info: 1, soft: 2 };
  const limit = rank[minLevel] ?? 0;
  return selectedAlerts(alerts).filter((item) => (rank[item.level] ?? 1) <= limit);
}

/* ---------------------- 用户反馈：纠正 / 叫停 / 我知道了 ---------------------- */

/**
 * 天气预报是「市级」的，一个市里几个区天气不一样是常态。
 * 所以用户说「我这边大太阳」「别再说了」的时候，必须让预报让位——这是本模块存在的意义。
 *
 * 状态存在 state/weather.json 的 feedback 字段里：
 *   mutedUntil  到什么时候为止不要再主动提天气
 *   note        用户说的实际情况（原话摘要），比预报可信
 *   noteAt      这条 note 什么时候记的
 *   mentions    今天已经提过哪几类（用来避免同一天反复说同一件事）
 */
const MUTE_HOURS = { stop: 12, ack: 8, correction: 12 };

function readFeedback() {
  const cache = readCache();
  const fb = cache.feedback;
  return fb && typeof fb === "object"
    ? { mutedUntil: 0, note: "", noteAt: 0, mentions: {}, ...fb }
    : { mutedUntil: 0, note: "", noteAt: 0, mentions: {} };
}

function writeFeedback(patch) {
  writeCache({ feedback: { ...readFeedback(), ...patch } });
}

/** 现在是不是「不要再提天气」的状态。 */
export function isWeatherMuted(now = Date.now()) {
  const fb = readFeedback();
  return Number(fb.mutedUntil) > now ? { muted: true, until: Number(fb.mutedUntil), note: fb.note } : { muted: false, until: 0, note: fb.note };
}

/** 今天已经提过哪些类型（面板展示用）。 */
export function weatherMentions() {
  const fb = readFeedback();
  const today = localDateString();
  return fb.mentions && fb.mentions.date === today ? fb.mentions : { date: today, kinds: [] };
}

/** 记一次「提过天气」，用来避免同一天反复提同一件事。 */
export function recordWeatherMention(kinds = []) {
  const today = weatherMentions();
  const merged = [...new Set([...(today.kinds || []), ...kinds.map(String)])];
  writeFeedback({ mentions: { date: localDateString(), kinds: merged, at: Date.now() } });
  return merged;
}

export function clearWeatherFeedback() {
  writeFeedback({ mutedUntil: 0, note: "", noteAt: 0, mentions: { date: localDateString(), kinds: [] } });
}

/**
 * 从用户的一句话里判断他是不是在「纠正天气」或「叫停天气提醒」。
 *
 * 用关键词而不是模型判断：这是高频路径，必须零成本、零延迟、结果稳定。
 * 误判的代价只是「今天不提天气了」，比「他明明说了别再提、她还在提」轻得多。
 */
export function detectWeatherFeedback(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 80) return null;
  const s = raw.replace(/\s+/g, "");

  // ① 明确叫停
  const stopPatterns = [
    /(别|不要|不用|甭|少)(再|老是|总是)?(说|提|念|报|提醒|扯)(天气|下雨|带伞|这个|这些|气温)/,
    /(别|不要|不用)(再)?(说|提|念)了/,
    /说(过|了)了|讲过了|重复了|念了|烦不烦|别念了|听不懂吗|知道了啦/,
  ];
  if (stopPatterns.some((re) => re.test(s))) return { type: "stop", note: "" };

  // ② 纠正：我这边和预报不一样
  const corrections = [
    { re: /(没|不|并没|根本没)(有)?(下|来)(雨|雪)/, note: "没有下雨" },
    { re: /(大)?晴天|大太阳|出太阳|放晴|太阳(很|好|大|晒|猛)|万里无云/, note: "是大晴天" },
    { re: /晒死|很晒|好晒|太阳晒/, note: "很晒" },
    { re: /热死|好热|太热了?|闷热/, note: "很热" },
    { re: /冷死|好冷|太冷了?/, note: "很冷" },
    { re: /(预报|天气)(不|没)(准|对)/, note: "预报不准" },
    { re: /不是(武汉|本地|这里)|我(这边|这儿|这里).{0,4}(不|没)(下雨|雨)/, note: "实际情况和预报不一样" },
  ];
  const notes = [...new Set(corrections.filter((item) => item.re.test(s)).map((item) => item.note))];
  if (notes.length) return { type: "correction", note: notes.slice(0, 2).join("，") };

  // ③ 「我知道了」：只有在刚提醒过天气的时候才算叫停，否则只是普通的应答
  if (/^[嗯哦啊额]*[,，。]?\s*(知道了|我知道(了)?|晓得了|收到(了)?|看到(了)?|明白了|好的|好好好|行行行|嗯嗯嗯)[。！!~～,.，、 ]*$/.test(s)) {
    const mentions = weatherMentions();
    const recently = Date.now() - Number(mentions.at ?? 0) < 90 * 60000;
    if (recently) return { type: "ack", note: "" };
  }
  return null;
}

/**
 * 记录一次反馈。返回 { muted, until, note, type }。
 * 只影响「她主动提天气」和「提示词里的天气块」，不影响她正常聊天。
 */
export function recordWeatherFeedback({ type, note = "", text = "", hours = 0 } = {}) {
  const now = Date.now();
  const muteHours = Number(hours) > 0 ? Number(hours) : (MUTE_HOURS[type] ?? 12);
  const fb = readFeedback();
  const next = {
    mutedUntil: now + muteHours * 3600000,
    lastType: type,
    lastText: String(text).slice(0, 60),
    at: now,
  };
  // 纠正会留下「他那边真实情况」；叫停/应答不动已有的 note
  if (type === "correction" && note) {
    next.note = note;
    next.noteAt = now;
  } else if (type === "stop") {
    next.note = fb.note || "";
  }
  writeFeedback(next);
  return { muted: true, until: next.mutedUntil, note: next.note || "", type };
}

/**
 * 拼进提示词的「用户反馈」块（为空就是没反馈）。
 *
 * 这段是整套「被纠正后必须收手」里最关键的一环：
 * 只说「别提天气」模型经常会绕回去，所以这里把「承认对方说得对」这个动作也写清楚。
 * note 来自我们自己维护的固定短语（不是用户原话），所以不存在提示词注入的问题。
 */
export function weatherFeedbackBlock() {
  const fb = readFeedback();
  const muted = Number(fb.mutedUntil) > Date.now();
  const noteFresh = fb.note && Date.now() - Number(fb.noteAt ?? 0) < 24 * 3600000;
  if (!muted && !noteFresh) return "";
  const lines = [];
  if (noteFresh) {
    lines.push("【对方刚纠正过天气（比任何预报都可信，就当事实）】");
    lines.push(`对方说他那边实际是：${fb.note}。`);
    lines.push("你要做的：先自然地承认他说得对（比如「那可能是我这边报错了」「那我记岔了」），然后顺着他现在说的话聊下去。");
    lines.push("不要做的：不要拿预报反驳、不要说「可是预报显示」「不过还是带把伞吧」、不要换一种说法重复天气。");
  } else {
    lines.push("【对方已经不想听天气提醒了】");
    lines.push("不要再主动提天气，不要用「不过预报说…」绕回来，也不要换个说法重复。等他主动聊到再说。");
  }
  return lines.join("\n");
}

export function summarize(data) {
  if (!data?.ok || !data.today) return "";
  const today = data.today;
  const parts = [`${data.city || "本地"}今天${today.text}`];
  if (Number.isFinite(today.min) && Number.isFinite(today.max)) parts.push(`${Math.round(today.min)}~${Math.round(today.max)}℃`);
  if (today.rainProb > 0) parts.push(`降雨概率 ${Math.round(today.rainProb)}%`);
  return parts.join("，");
}

/** 给模型的天气提示块（没有数据就返回空串，绝不编造）。 */
export function promptBlockFor(data, alerts = []) {
  if (!data?.ok || !data.today) return "";
  const lines = [`【今天的真实天气（可信数据，别编）】`, summarize(data)];
  const today = data.today;
  if (Number.isFinite(today.windMax)) lines.push(`风力：阵风约 ${Math.round(today.windMax)} km/h`);
  if (data.current && Number.isFinite(data.current.temp)) lines.push(`此刻体感：${Math.round(data.current.temp)}℃（体感 ${Math.round(data.current.feels)}℃）`);
  if (data.tomorrow) {
    lines.push(`明天：${data.tomorrow.text}，${Math.round(data.tomorrow.min)}~${Math.round(data.tomorrow.max)}℃`);
  }
  if (alerts.length) lines.push(`值得提醒：${alerts.map((item) => item.text).join("；")}`);
  return lines.join("\n");
}

/**
 * 聊天里用的天气块（同步读缓存）。
 *
 * 与旧版最大的区别：**不再命令她「一定要提醒带伞」**。
 * 旧的写法会在每一轮对话里都塞一句「值得提醒：今天阵雨」，她就每句都往天气上拐
 * ——用户的原话是「不停地提醒」，这个坑必须堵住。
 *
 * 现在的写法是：数据给她（万一聊到用得上），但明确要求「别主动播报、别反复提」，
 * 并且把「今天已经提过了」「用户说那边实际是晴天」这两个状态一起告诉她。
 */
export function cachedWeatherBlock(override = null) {
  try {
    const cfg = getConfig();
    if (cfg.weather?.enabled === false) return "";
    if (isWeatherMuted().muted) return "";
    const cache = override ? {} : readCache();
    const data = override || cache.forecast;
    if (!data?.ok || !data.today) return "";
    if (!override && Date.now() - Number(cache.forecastAt ?? 0) > 6 * 3600000) return "";
    const today = localDateString();
    if (data.today.date && data.today.date !== today) return "";

    const alerts = buildAlerts(data);
    const says = summarize(data);
    const lines = [];
    lines.push("【你手上的天气预报（市级预报，仅供参考，不是每句话都要用）】");
    lines.push(says);
    if (alerts.length) lines.push(`预报里的看点：${alerts.map((item) => item.text).join("；")}`);
    lines.push("这是整个市的预报，对方所在的具体区域可能完全不一样（比如市区报雨、某个区是大太阳）。所以：");
    lines.push("① 不要主动播报天气，也不要每隔一两句就提一次；对方没聊到天气，你就别提。");
    lines.push("② 对方说「我这边没下雨 / 是大晴天」这类实际情况时，以他说的为准，别拿预报去纠正他。");
    const mentions = weatherMentions();
    if (mentions.kinds && mentions.kinds.length) {
      lines.push(`③ 今天你已经提过天气了（${mentions.kinds.join("、")}）。不要再提第二次，也不要换个说法重复。`);
    }
    const fb = readFeedback();
    if (fb.note && Date.now() - Number(fb.noteAt ?? 0) < 24 * 3600000) {
      lines.push(`④ 对方告诉过你他那边实际是「${fb.note}」，这就是事实，别说「可是预报……」`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** 同步读缓存摘要（总览页这类地方用，不能为了一个数字等网络）。 */
export function cachedSummary() {
  try {
    const cache = readCache();
    const data = cache.forecast;
    if (!data?.ok || !data.today) return null;
    const fresh = Date.now() - Number(cache.forecastAt ?? 0) <= 6 * 3600000 && (!data.today.date || data.today.date === localDateString());
    return {
      ok: true,
      city: data.city,
      summary: summarize(data),
      text: data.today.text,
      code: data.today.code,
      icon: weatherIcon(data.today.code),
      min: data.today.min,
      max: data.today.max,
      rainProb: data.today.rainProb,
      alerts: buildAlerts(data).map((item) => ({ id: item.id, text: item.text })),
      fetchedAt: data.fetchedAt ?? 0,
      stale: !fresh,
    };
  } catch {
    return null;
  }
}

function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 面板与 API 用的完整状态。 */
export async function weatherStatus({ force = false } = {}) {  const cfg = getConfig();
  try {
    const data = await forecast({ force });
    const alerts = buildAlerts(data);
    return {
      ok: Boolean(data.ok),
      enabled: cfg.weather?.enabled !== false,
      city: cfg.weather?.city || "",
      autoLocate: cfg.weather?.autoLocate !== false,
      location: data.location ?? (data.ok ? { city: data.city, region: data.region, source: data.source } : null),
      summary: summarize(data),
      today: data.today ?? null,
      tomorrow: data.tomorrow ?? null,
      days: data.days ?? [],
      current: data.current ?? null,
      alerts,
      selectedAlerts: selectedAlerts(alerts),
      actionable: actionableAlerts(alerts),
      alertKinds: ALERT_KINDS,
      proactive: cfg.weather?.proactive ?? {},
      feedback: {
        ...isWeatherMuted(),
        noteAt: readFeedback().noteAt || 0,
        mentions: weatherMentions(),
      },
      fetchedAt: data.fetchedAt ?? 0,
      cached: Boolean(data.cached),
      warning: data.warning || "",
      error: data.error || "",
      icon: weatherIcon(data.today?.code ?? -1),
    };
  } catch (error) {
    return { ok: false, enabled: cfg.weather?.enabled !== false, error: String(error?.message ?? error), alerts: [], days: [], alertKinds: ALERT_KINDS };
  }
}

/** 面板用的反馈状态（不查网络，纯读本地）。 */
export function weatherFeedbackStatus() {
  const mute = isWeatherMuted();
  const fb = readFeedback();
  return {
    muted: mute.muted,
    mutedUntil: mute.until,
    note: fb.note || "",
    noteAt: Number(fb.noteAt ?? 0),
    lastType: fb.lastType || "",
    lastText: fb.lastText || "",
    mentions: weatherMentions(),
  };
}
