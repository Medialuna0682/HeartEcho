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
 * 每个 alert 都带一句可以直接塞进提示词的 hint —— 她照着这个意思用自己的话说。
 */
export function buildAlerts(data) {
  if (!data?.ok || !data.today) return [];
  const today = data.today;
  const tomorrow = data.tomorrow;
  const out = [];
  const push = (alert) => out.push({ level: "info", ...alert });

  if (today.kind === "thunder") {
    push({ id: "thunder", text: `今天${today.text}`, hint: `今天有雷雨（${today.text}），提醒对方别在空旷处久留、注意收好阳台的东西，语气关切但别吓人。` });
  }
  if (today.kind === "rain" || today.rainProb >= 50 || today.rainSum >= 1) {
    push({
      id: "rain",
      text: `今天${today.text}，降雨概率 ${Math.round(today.rainProb)}%`,
      hint: `今天会下雨（${today.text}，降雨概率 ${Math.round(today.rainProb)}%），一定要提醒对方带伞，最好再说一句别淋湿。`,
    });
  }
  if (today.kind === "snow") {
    push({ id: "snow", text: `今天${today.text}`, hint: `今天下雪（${today.text}），提醒对方注意路滑、多穿一点。` });
  }
  if (!out.some((item) => item.id === "rain") && today.rainProb >= 30 && today.rainProb < 50) {
    push({ id: "rain", level: "soft", text: `今天可能有零星小雨（${Math.round(today.rainProb)}%）`, hint: `今天降雨概率 ${Math.round(today.rainProb)}%，有点悬，可以提醒对方带着伞以防万一。` });
  }

  if (tomorrow && Number.isFinite(today.max) && Number.isFinite(tomorrow.max) && tomorrow.max - today.max <= -6) {
    push({
      id: "temp_drop",
      text: `明天比今天低 ${Math.round(today.max - tomorrow.max)}℃`,
      hint: `明天最高温只有 ${Math.round(tomorrow.max)}℃，比今天低不少，提醒对方明天加衣服。`,
    });
  }
  if (Number.isFinite(today.max) && today.max >= 33) {
    push({ id: "heat", text: `最高 ${Math.round(today.max)}℃`, hint: `今天最高 ${Math.round(today.max)}℃，提醒对方少在中午出门、多喝水。` });
  }
  if (Number.isFinite(today.min) && today.min <= 0) {
    push({ id: "cold", text: `最低 ${Math.round(today.min)}℃`, hint: `今天最低 ${Math.round(today.min)}℃，有可能结冰，提醒对方穿厚一点、出门当心路滑。` });
  }
  if (Number.isFinite(today.windMax) && today.windMax >= 39) {
    push({ id: "wind", text: `阵风 ${Math.round(today.windMax)} km/h`, hint: `今天风很大（阵风约 ${Math.round(today.windMax)} km/h），提醒对方注意别被吹着、收好晾在外面的衣服。` });
  }
  if (Number.isFinite(today.uvMax) && today.uvMax >= 7) {
    push({ id: "uv", level: "soft", text: `紫外线指数 ${Math.round(today.uvMax)}`, hint: `今天紫外线挺强（指数 ${Math.round(today.uvMax)}），可以提醒对方防晒。` });
  }
  return out;
}

/** 按配置筛出允许的提醒类型。 */
export function selectedAlerts(alerts) {
  const cfg = getConfig();
  const kinds = cfg.weather?.proactive?.kinds;
  const list = Array.isArray(kinds) && kinds.length ? kinds : ALERT_KINDS.map((item) => item.id);
  return alerts.filter((item) => list.includes(item.id));
}

/** 一句话天气概况（面板显示 + 塞进提示词）。 */
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
 * 同步版：从磁盘缓存里取「今天的天气提示块」。
 *
 * 为什么需要同步版：拼提示词是在一次聊天里同步完成的，不能为了天气去等一次网络。
 * 所以调度器负责刷新缓存，聊天只读缓存。缓存超过 6 小时、或者不是今天的，就当没有——
 * 宁可不说天气，也不能把昨天的「今天有雨」说出来。
 */
export function cachedWeatherBlock() {
  try {
    if (getConfig().weather?.enabled === false) return "";
    const cache = readCache();
    const data = cache.forecast;
    if (!data?.ok || !data.today) return "";
    if (Date.now() - Number(cache.forecastAt ?? 0) > 6 * 3600000) return "";
    const today = localDateString();
    if (data.today.date && data.today.date !== today) return "";
    return promptBlockFor(data, selectedAlerts(buildAlerts(data)));
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
      alertKinds: ALERT_KINDS,
      proactive: cfg.weather?.proactive ?? {},
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
