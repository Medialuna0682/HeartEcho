/**
 * 插件 / 技能扩展宿主。
 *
 * 这套东西的来源：项目外有一套「QQ Agent」平台的插件（plugins/，确定性规则、钩子、能力）
 * 与技能（skills/，注册给模型的工具 + 提示词片段）生态，扩展包用 manifest + ESM 模块
 * 描述自己。这里把那套契约在心语里实现出来，并且**不引入任何第三方运行时依赖**。
 *
 * 契约（对扩展作者的唯一约定）见 docs/扩展宿主契约.md。要点：
 *   - 扩展 = extension 目录 + manifest(plugin.json/skill.json) + entry(index.js)
 *   - setup(api) 里注册工具；模块顶层导出 hooks / providers / promptSections / activate 等
 *   - 数据只写 DATA_DIR（<心语数据目录>/extensions）下的自己的目录
 *
 * 本模块只做「装载 + 配置 + 生命周期 + 分发」；真正的模型调用循环在 llm.mjs，
 * 消息发送在 chat.mjs，面板接口在 api.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "./paths.mjs";
import { getConfig, saveConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { ToolRegistry } from "./tools.mjs";
import { bindExtensionServices, extensionDataDir } from "./extensions-runtime.mjs";
import { all, one } from "./db.mjs";
import { createStickerStore } from "./stickers.mjs";

const log = createLogger("Extensions");

export const EXTENSION_KINDS = ["plugins", "skills"];
const MANIFEST_FILE = { plugins: "plugin.json", skills: "skill.json" };
const API_VERSION = 1;
const HOOK_TIMEOUT_MS = 5000;
const MAX_PROMPT_SECTIONS_TOTAL = 16000;
const SETTINGS_VERSION = 1;

/* ------------------------------ 小工具 ------------------------------ */

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function safeDirName(value) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(value ?? "")) ? String(value) : "";
}

/** 扩展里的 log('...%s', a) 用；不追求 util.format 全兼容。 */
export function formatExtensionArgs(args) {
  const list = [...(args ?? [])];
  if (!list.length) return "";
  const head = String(list.shift() ?? "");
  if (!/%[sdifjo%]/.test(head)) return [head, ...list].map((item) => (typeof item === "string" ? item : safeJson(item))).join(" ");
  let index = 0;
  const text = head.replace(/%([sdifjo%])/g, (match, type) => {
    if (type === "%") return "%";
    if (index >= list.length) return match;
    const value = list[index++];
    if (type === "d" || type === "i") return String(Math.trunc(Number(value) || 0));
    if (type === "f") return String(Number(value) || 0);
    if (type === "j") return safeJson(value);
    if (type === "o") return safeJson(value);
    return typeof value === "string" ? value : safeJson(value);
  });
  return [text, ...list.slice(index).map((item) => (typeof item === "string" ? item : safeJson(item)))].join(" ");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extensionLogger(id) {
  void id;
  const write = (level, args) => {
    const text = formatExtensionArgs(args);
    if (!text) return;
    try {
      log[level]?.(text);
    } catch {
      /* ignore */
    }
  };
  return {
    log: (...args) => write("info", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    debug: (...args) => write("debug", args),
  };
}

/**
 * 设置校验：manifest.configSchema 是唯一可信来源。
 * 非法值一律回落到 manifest.settings 里的默认值，绝不把 NaN / 越界值带进运行时。
 */
export function normalizeExtensionSettings(manifest = {}, saved = {}) {
  const defaults = manifest.settings && typeof manifest.settings === "object" ? manifest.settings : {};
  const schema = manifest.configSchema && typeof manifest.configSchema === "object" ? manifest.configSchema : {};
  const out = { ...defaults };
  if (saved && typeof saved === "object") {
    for (const [key, value] of Object.entries(saved)) {
      if (!(key in defaults) && !(key in schema)) continue;
      out[key] = value;
    }
  }
  for (const [key, rule] of Object.entries(schema)) {
    if (!rule || typeof rule !== "object") continue;
    out[key] = coerceSetting(key, rule, out[key], defaults[key]);
  }
  return out;
}

function coerceSetting(key, rule, value, fallback) {
  const type = String(rule.type ?? "").toLowerCase();
  try {
    if (type === "boolean") {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return fallback === true;
    }
    if (type === "number" || type === "integer") {
      let num = Number(value);
      if (!Number.isFinite(num)) num = Number(fallback);
      if (!Number.isFinite(num)) num = 0;
      if (Number.isFinite(Number(rule.min))) num = Math.max(Number(rule.min), num);
      if (Number.isFinite(Number(rule.max))) num = Math.min(Number(rule.max), num);
      return type === "integer" ? Math.round(num) : num;
    }
    if (type === "enum") {
      const values = Array.isArray(rule.values) ? rule.values.map(String) : [];
      const text = String(value ?? "");
      if (values.includes(text)) return text;
      return values.includes(String(fallback)) ? String(fallback) : values[0] ?? String(fallback ?? "");
    }
    // string / text / 未知类型：保持字符串
    if (value === undefined || value === null) return String(fallback ?? "");
    return String(value);
  } catch {
    return fallback;
  }
}

/* ------------------------------ 宿主 ------------------------------ */

export class ExtensionHost {
  /**
   * @param {object} options
   * @param {object} options.llm         心语的模型网关（LlmGateway）
   * @param {object} options.client      OneBot 客户端
   * @param {object} [options.engine]    ChatEngine（用于自主发送；可后绑定）
   * @param {string} [options.root]      扩展根目录（默认 <程序目录>/extensions）
   * @param {string} [options.dataDir]   扩展数据目录（默认 <数据目录>/extensions）
   */
  constructor({ llm = null, client = null, engine = null, root = "", dataDir = "", generated = null } = {}) {
    this.llm = llm;
    this.client = client;
    this.engine = engine;
    this.root = root || defaultExtensionRoot();
    this.dataDir = dataDir || extensionDataDir();
    this.generated = generated;
    this.stateFile = path.join(this.dataDir, "state.json");
    this.tools = new ToolRegistry();
    this.hooks = new Map();
    this.providers = new Map();
    this.staticSections = [];
    this.dynamicSectionFns = [];
    /** @type {Map<string, object>} key = `${kind}/${id}` */
    this.extensions = new Map();
    this.state = { version: SETTINGS_VERSION, plugins: {}, skills: {} };
    this.stickers = createStickerStore({ dataDir: this.dataDir, client: this.client });
    this.startedAt = Date.now();
    this.errors = [];
    this.sender = {
      sendText: (chatKey, text) => this.sendTo(chatKey, { text }),
      sendImage: (chatKey, image) => this.sendTo(chatKey, { image }),
      sendTextBatch: (chatKey, list) => this.sendBatchTo(chatKey, list),
    };
    this.#registerCoreTools();
  }

  /* --------------------------- 初始化 --------------------------- */

  async init({ setup = true, activate = true } = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    // 必须在导入任何扩展入口之前绑定：扩展是静态 import 兼容层（../../src/*），
    // DATA_DIR 等常量在模块求值时就固定了，晚绑会让自定义 dataDir 失效。
    this.#bindRuntime();
    this.#loadState();
    this.state.version = SETTINGS_VERSION;
    this.entries = await this.#discover();
    if (setup) {
      for (const entry of this.entries) {
        const config = this.#configFor(entry.kind, entry.id);
        if (!config.enabled) continue;
        await this.#setupExtension(entry);
      }
      if (activate) {
        for (const record of this.extensions.values()) {
          if (record.kind !== "plugins" || !record.enabled || !record.ok) continue;
          this.#callLifecycle(record, "activate");
        }
      }
    }
    log.info(`扩展宿主就绪：发现 ${this.entries.length} 个扩展，已启用 ${[...this.extensions.values()].filter((item) => item.ok).length} 个`);
    return this;
  }

  #bindRuntime() {
    bindExtensionServices({
      dataDir: this.dataDir,
      settingsFor: (kind, id) => this.settingsFor(kind, id),
      logger: (id) => extensionLogger(id),
      getConfig: () => getConfig(),
      updateConfig: (patch) => saveConfig(patch),
      chatCompletion: (options) => this.chatCompletion(options),
      resolveModelPrice: (model, cfg) => this.resolveModelPrice(model, cfg),
      getToolAvailability: (name) => {
        const entry = this.tools.get(name);
        return entry ? { ok: true } : { ok: false, reason: "工具没注册（可能对应扩展被关掉了）" };
      },
      stickerPathByUrl: (url) => this.stickers.pathByUrl(url),
      stickers: this.stickers,
    });
  }

  #loadState() {
    const raw = readJsonFile(this.stateFile, null);
    if (!raw || typeof raw !== "object") return;
    for (const kind of EXTENSION_KINDS) {
      if (raw[kind] && typeof raw[kind] === "object") this.state[kind] = raw[kind];
    }
  }

  #saveState() {
    writeJsonAtomic(this.stateFile, this.state);
  }

  #configFor(kind, id) {
    const saved = this.state[kind]?.[id] ?? {};
    const entry = this.entries?.find((item) => item.kind === kind && item.id === id) ?? null;
    const manifest = entry?.manifest ?? {};
    const settings = normalizeExtensionSettings(manifest, saved.settings ?? {});
    const enabled = typeof saved.enabled === "boolean" ? saved.enabled : manifest.enabledByDefault !== false;
    return { enabled, settings };
  }

  /* --------------------------- 发现 / 装载 --------------------------- */

  async #discover() {
    const generatedEntries = this.generated ?? (await this.#loadGenerated());
    if (Array.isArray(generatedEntries) && generatedEntries.length) return generatedEntries;
    return this.#scanDisk();
  }

  async #loadGenerated() {
    try {
      const mod = await import("./extensions.generated.mjs");
      return Array.isArray(mod?.generatedEntries) ? mod.generatedEntries : null;
    } catch (error) {
      if (isBundled()) {
        this.errors.push({ stage: "load-generated", message: String(error?.message ?? error) });
        log.error(`打包版扩展注册表加载失败：${error?.message ?? error}`);
      }
      return null;
    }
  }

  #scanDisk() {
    const entries = [];
    for (const kind of EXTENSION_KINDS) {
      const dir = path.join(this.root, kind);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const extDir = path.join(dir, name);
        let stat;
        try {
          stat = fs.statSync(extDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const manifestFile = path.join(extDir, MANIFEST_FILE[kind]);
        const manifest = readJsonFile(manifestFile, null);
        if (!manifest) {
          this.errors.push({ stage: "manifest", kind, id: name, message: `缺少或无法解析 ${MANIFEST_FILE[kind]}` });
          continue;
        }
        const entryFile = path.join(extDir, String(manifest.entry || "index.js"));
        if (!fs.existsSync(entryFile)) {
          this.errors.push({ stage: "manifest", kind, id: name, message: `入口文件不存在：${manifest.entry || "index.js"}` });
          continue;
        }
        const id = safeDirName(manifest.id || name);
        if (!id || id !== name) {
          this.errors.push({ stage: "manifest", kind, id: name, message: `扩展目录名与 manifest id 不一致（目录 ${name} / id ${manifest.id}）` });
        }
        entries.push({
          kind,
          id: id || name,
          dir: extDir,
          manifest,
          load: () => import(pathToFileURL(entryFile).href),
        });
      }
    }
    return entries;
  }

  #checkManifest(entry) {
    const manifest = entry.manifest ?? {};
    if (manifest.apiVersion !== undefined && Number(manifest.apiVersion) !== API_VERSION) {
      throw new Error(`不支持的扩展 API 版本：${manifest.apiVersion}（当前支持 ${API_VERSION}）`);
    }
    if (!String(manifest.id ?? entry.id).trim()) throw new Error("manifest 缺少 id");
    return true;
  }

  async #setupExtension(entry) {
    const key = `${entry.kind}/${entry.id}`;
    const record = {
      key,
      kind: entry.kind,
      id: entry.id,
      dir: entry.dir,
      manifest: entry.manifest,
      enabled: true,
      ok: false,
      error: "",
      available: { ok: true },
      tools: [],
      module: null,
      log: extensionLogger(entry.id),
    };
    try {
      this.#checkManifest(entry);
      const module = await entry.load();
      record.module = module;
      const api = this.#createApi(entry, record);
      const setupFn = module.setup ?? module.register ?? module.default;
      if (typeof setupFn !== "function") throw new Error("扩展没有导出 setup(api)");
      await setupFn(api);
      // 钩子 / 能力 / 提示词片段：必须模块顶层导出
      this.#collectHooks(entry, module);
      this.#collectProviders(entry, record, module);
      this.#collectPromptSections(entry, record, module);
      record.available = this.#checkAvailable(module, record);
      record.ok = true;
      // 模块可能在 setup 后导出 available() 为 false：工具仍注册，但对外标记不可用
      if (!record.available.ok) record.log.warn(`扩展不可用：${record.available.reason || "未知原因"}`);
      this.extensions.set(key, record);
      log.info(`已加载${entry.kind === "plugins" ? "插件" : "技能"} ${entry.id}（工具 ${record.tools.length} 个）`);
    } catch (error) {
      record.error = String(error?.message ?? error);
      record.available = { ok: false, reason: record.error };
      record.ok = false;
      this.extensions.set(key, record);
      this.errors.push({ stage: "setup", kind: entry.kind, id: entry.id, message: record.error });
      log.error(`加载扩展 ${key} 失败：${record.error}`);
    }
    return record;
  }

  #checkAvailable(module, _record) {
    try {
      if (typeof module.available !== "function") return { ok: true };
      const value = module.available();
      if (value === false) return { ok: false, reason: "available() 返回 false" };
      if (value && typeof value === "object" && value.ok === false) {
        return { ok: false, reason: String(value.reason ?? value.message ?? "available() 判定不可用") };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `available() 抛错：${String(error?.message ?? error)}` };
    }
  }

  #collectHooks(entry, module) {
    const hooks = module.hooks && typeof module.hooks === "object" ? module.hooks : null;
    if (!hooks) return;
    for (const [name, fn] of Object.entries(hooks)) {
      if (typeof fn !== "function") continue;
      if (!this.hooks.has(name)) this.hooks.set(name, []);
      this.hooks.get(name).push({ extensionId: entry.id, kind: entry.kind, fn });
    }
  }

  #collectProviders(entry, record, module) {
    const providers = module.providers && typeof module.providers === "object" ? module.providers : null;
    if (!providers) return;
    for (const [name, fn] of Object.entries(providers)) {
      if (typeof fn !== "function") continue;
      if (!this.providers.has(name)) this.providers.set(name, []);
      this.providers.get(name).push({ extensionId: entry.id, kind: entry.kind, fn });
      record.providers ||= [];
      record.providers.push(name);
      if (this.providers.get(name).length > 1) {
        log.warn(`能力 ${name} 有多个提供者：${this.providers.get(name).map((item) => item.extensionId).join(", ")}（用先加载的那个）`);
      }
    }
  }

  #collectPromptSections(entry, _record, module) {
    const manifestSections = Array.isArray(entry.manifest?.prompt?.sections) ? entry.manifest.prompt.sections : [];
    const sections = manifestSections
      .filter((item) => item && item.content)
      .map((item) => ({
        id: String(item.id || `${entry.id}-section`),
        title: String(item.title || entry.manifest.name || entry.id),
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 50,
        content: String(item.content),
        extensionId: entry.id,
        kind: entry.kind,
      }));
    // 上游约定：只有 instruction、没有 sections 的扩展，把 instruction 当成一段 main（priority 50）注入
    if (!sections.length && entry.manifest?.prompt?.instruction) {
      sections.push({
        id: "main",
        title: String(entry.manifest.name || entry.id),
        priority: 50,
        content: String(entry.manifest.prompt.instruction),
        extensionId: entry.id,
        kind: entry.kind,
      });
    }
    if (sections.length) this.staticSections.push(...sections);
    if (typeof module.promptSections === "function") {
      this.dynamicSectionFns.push({ extensionId: entry.id, kind: entry.kind, fn: module.promptSections });
    }
  }

  #callLifecycle(record, name) {
    try {
      const fn = record.module?.[name];
      if (typeof fn === "function") fn();
    } catch (error) {
      record.log.warn(`${name}() 失败：${String(error?.message ?? error)}`);
    }
  }

  /* --------------------------- 宿主 API --------------------------- */

  #createApi(entry, record) {
    const id = entry.id;
    const permissions = new Set(Array.isArray(entry.manifest?.permissions) ? entry.manifest.permissions.map(String) : []);
    const api = {
      config: () => this.settingsFor(entry.kind, entry.id),
      log: (...args) => record.log.info(...args),
      warn: (...args) => record.log.warn(...args),
      error: (...args) => record.log.error(...args),
      registerTool: (spec) => {
        const registered = this.tools.register(id, spec);
        record.tools.push({ id: registered.bareName, name: registered.name, spec });
        // 上游约定：返回「已加前缀」的最终工具名；少数扩展会拿它去拼 hooks 指令
        return registered.name;
      },
      isSkillActive: (skillId) => {
        const target = this.extensions.get(`skills/${String(skillId)}`);
        return Boolean(target?.ok && target.enabled && target.available?.ok);
      },
      /** 软依赖：取第一个可用的能力提供者并调用；没有/失败返回 undefined。 */
      capability: (name, args) => this.callProvider(String(name), args),
      hasCapability: (name) => {
        const list = this.providers.get(String(name)) ?? [];
        return list.some((item) => {
          const target = this.extensions.get(`${item.kind}/${item.extensionId}`);
          return Boolean(target?.ok && target.enabled && target.available?.ok);
        });
      },
      utils: {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60000, Number(ms) || 0)))),
        safeJsonParse: (text, fallback = null) => {
          try {
            return JSON.parse(String(text ?? ""));
          } catch {
            return fallback;
          }
        },
      },
      tools: {
        get: (name) => {
          const found = this.tools.get(name);
          return found ? found.spec : null;
        },
        byName: (name) => {
          const found = [...this.tools.all()].find((item) => item.spec.name === name);
          return found ? found.spec : null;
        },
        all: () => this.tools.all().map((item) => item.spec),
      },
      visionEnabled: this.#visionEnabled(),
      model: this.#activeProfile()?.model ?? "",
      baseUrl: this.#activeProfile()?.baseUrl ?? "",
      dataDir: this.dataDir,
      store: this.messageStore(),
      stickers: this.stickers.api(),
      onebot: this.onebot(),
      sender: this.sender,
      permissions,
      emit: () => {},
    };
    // 只给声明了 web_fetch 的扩展注入联网能力（契约 §10）
    if (permissions.has("web_fetch")) api.fetch = (url, init) => this.fetch(url, init);
    return api;
  }

  #visionEnabled() {
    try {
      const profile = this.#activeProfile();
      if (profile?.vision !== undefined) return profile.vision !== false;
      return true;
    } catch {
      return false;
    }
  }

  #activeProfile() {
    try {
      const cfg = getConfig();
      return cfg.llm?.profiles?.[cfg.llm.activeProfile] ?? null;
    } catch {
      return null;
    }
  }

  onebot() {
    const client = this.client;
    const self = this;
    return {
      get connected() {
        return Boolean(client?.connected);
      },
      get selfInfo() {
        return { user_id: Number(client?.selfId ?? 0), nickname: client?.status?.nickname ?? "" };
      },
      call: (action, params = {}, timeout = 60000) => {
        if (!client?.call) return Promise.reject(new Error("协议端还没连接"));
        const options = typeof timeout === "number" ? { timeoutMs: timeout } : timeout || {};
        return client.call(action, params, options);
      },
      getGroupMemberInfo: (groupId, userId) => {
        if (!client?.getGroupMemberInfo) return Promise.resolve(null);
        return client.getGroupMemberInfo(groupId, userId).catch(() => null);
      },
      get selfId() {
        return Number(client?.selfId ?? 0);
      },
      _host: self,
    };
  }

  /* --------------------------- 消息仓 / 发送 --------------------------- */

  /**
   * 心语的 scopeKey（group_<群号>_<成员号> / private_<QQ号>）→ 扩展认识的 chatKey
   * （group:<群号> / private:<QQ号>）。扩展生态里所有包都按后一种格式解析，所以
   * 宿主在边界上做这层翻译，扩展代码里永远看到 group:xxx / private:xxx。
   */
  messageStore() {
    const chatQuery = (chatKey) => {
      const key = String(chatKey ?? "");
      if (key.startsWith("group:")) return { clause: "scope_key like ?", args: [`group_${key.slice(6)}_%`] };
      if (key.startsWith("private:")) return { clause: "scope_key = ?", args: [`private_${key.slice(8)}`] };
      if (key.startsWith("group_")) return { clause: "scope_key like ?", args: [`${key.split("_").slice(0, 2).join("_")}_%`] };
      return { clause: "scope_key = ?", args: [key] };
    };
    return {
      recent: (chatKey, { limit = 50 } = {}) => {
        try {
          const { clause, args } = chatQuery(chatKey);
          const rows = all(`select * from messages where ${clause} order by at desc, id desc limit ?`, [
            ...args,
            Math.max(1, Math.min(400, Number(limit) || 50)),
          ]);
          return rows.reverse().map(extensionMessageRow);
        } catch {
          return [];
        }
      },
      findByMid: (chatKey, mid) => {
        try {
          const { clause, args } = chatQuery(chatKey);
          const row = one(
            `select * from messages where ${clause} and (platform_message_id = ? or event_key = ?) order by id desc limit 1`,
            [...args, String(mid), String(mid)],
          );
          return row ? extensionMessageRow(row) : null;
        } catch {
          return null;
        }
      },
    };
  }

  /** 自主发送（self-surf 这类定时插件用）：chatKey 必须是 group:<数字> / private:<数字>。 */
  async sendTo(chatKey, { text = "", image = null, images = [] } = {}) {
    if (!this.engine?.sendExtensionMessage) throw new Error("发送通道还没就绪");
    const key = String(chatKey ?? "").trim();
    if (!/^(group|private):\d+$/.test(key)) throw new Error(`发送目标不合法：${key || "（空）"}`);
    return this.engine.sendExtensionMessage({ chatKey: key, text, image, images });
  }

  async sendBatchTo(chatKey, list = []) {
    const out = [];
    for (const text of list) out.push(await this.sendTo(chatKey, { text }));
    return { sent: out.length, results: out };
  }

  /* --------------------------- 网络 --------------------------- */

  async fetch(url, init = {}) {
    const target = validateExternalUrl(url);
    /*
     * 请求头大小写不敏感合并：扩展可能写 "User-Agent"，也可能写 "user-agent"。
     * 以前直接展开对象会同时出现两个键，很多图床会因为 UA 变成
     * "HeartEcho-Extension/1.0, Mozilla/..." 直接 403。
     */
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("user-agent")) headers.set("user-agent", "HeartEcho-Extension/1.0");
    const response = await globalThis.fetch(target, {
      redirect: "follow",
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(20000),
    });
    if (response.url && response.url !== target) validateExternalUrl(response.url);
    /*
     * 响应体上限 8MB：扩展拿到的是普通 Response，但宿主不能无限把内存交给网络。
     * 有 content-length 先拦；没有就整块读出来再重建 Response（超过上限直接报错）。
     */
    const MAX_BYTES = 8 * 1024 * 1024;
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`响应体过大（${declared} 字节，上限 ${MAX_BYTES}）`);
    let body;
    try {
      body = await response.arrayBuffer();
    } catch {
      return response;
    }
    if (body.byteLength > MAX_BYTES) throw new Error(`响应体过大（${body.byteLength} 字节，上限 ${MAX_BYTES}）`);
    const responseHeaders = new Headers(response.headers);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  }

  /* --------------------------- 设置 / 状态 --------------------------- */

  settingsFor(kind, id) {
    return normalizeExtensionSettings(this.#manifestOf(kind, id), this.state[kind]?.[id]?.settings ?? {});
  }

  #manifestOf(kind, id) {
    return this.entries?.find((item) => item.kind === kind && item.id === id)?.manifest ?? {};
  }

  #writeConfig(kind, id, next) {
    this.state[kind] ||= {};
    this.state[kind][id] = { ...(this.state[kind][id] ?? {}), ...next };
    this.#saveState();
  }

  /**
   * 彻底拆掉一个已装载的扩展：生命周期回调 → 工具 → 钩子/能力/提示词片段 → 注册表记录。
   * 禁用和「重新启用」都先走这一步，保证 setup 的副作用不会重复累积、也不会丢。
   */
  #teardownExtension(record) {
    if (!record) return;
    try {
      this.#callLifecycle(record, "deactivate");
    } catch {
      /* lifecycle 内部已兜 */
    }
    try {
      this.#callLifecycle(record, "dispose");
    } catch {
      /* ignore */
    }
    const id = record.id;
    this.tools.clearExtension(id);
    for (const [name, list] of this.hooks) {
      const next = list.filter((item) => item.extensionId !== id);
      if (next.length) this.hooks.set(name, next);
      else this.hooks.delete(name);
    }
    for (const [name, list] of this.providers) {
      const next = list.filter((item) => item.extensionId !== id);
      if (next.length) this.providers.set(name, next);
      else this.providers.delete(name);
    }
    this.staticSections = this.staticSections.filter((item) => item.extensionId !== id);
    this.dynamicSectionFns = this.dynamicSectionFns.filter((item) => item.extensionId !== id);
    this.extensions.delete(`${record.kind}/${id}`);
  }

  async setEnabled(kind, id, enabled) {
    const key = `${kind}/${id}`;
    const entry = this.entries.find((item) => item.kind === kind && item.id === id);
    if (!entry) return { ok: false, error: `没找到扩展：${key}` };
    const next = Boolean(enabled);
    this.#writeConfig(kind, id, { enabled: next });
    if (!next) {
      this.#teardownExtension(this.extensions.get(key));
      return { ok: true, key, enabled: false };
    }
    /*
     * 启用：先彻底拆掉旧实例再重新 setup。
     * 不能只调 activate() —— 提示词片段、钩子、能力、工具都是 setup 期间收集的，
     * 只在 record.ok 时调 activate 会导致「禁用再启用后静态提示词片段永久丢失」。
     */
    this.#teardownExtension(this.extensions.get(key));
    const fresh = await this.#setupExtension(entry);
    if (fresh.ok && kind === "plugins") this.#callLifecycle(fresh, "activate");
    return fresh.ok ? { ok: true, key, enabled: true } : { ok: false, error: fresh.error };
  }

  async updateSettings(kind, id, patch = {}) {
    const manifest = this.#manifestOf(kind, id);
    if (!manifest || !Object.keys(manifest).length) return { ok: false, error: `没找到扩展：${kind}/${id}` };
    const current = this.settingsFor(kind, id);
    const merged = normalizeExtensionSettings(manifest, { ...current, ...(patch ?? {}) });
    this.#writeConfig(kind, id, { settings: merged });
    return { ok: true, settings: merged };
  }

  /** 面板用：全部扩展的状态。 */
  status() {
    const list = [];
    for (const entry of this.entries) {
      const record = this.extensions.get(`${entry.kind}/${entry.id}`);
      const config = this.#configFor(entry.kind, entry.id);
      list.push({
        kind: entry.kind,
        id: entry.id,
        name: String(entry.manifest.name ?? entry.id),
        version: String(entry.manifest.version ?? ""),
        author: String(entry.manifest.author ?? ""),
        category: String(entry.manifest.category ?? ""),
        description: String(entry.manifest.description ?? ""),
        enabled: config.enabled,
        loaded: Boolean(record?.ok),
        available: record?.available ?? { ok: true },
        error: record?.error ?? "",
        tools: (record?.tools ?? []).map((item) => ({ id: item.id, name: item.spec?.name ?? item.id, description: String(item.spec?.description ?? "").slice(0, 200) })),
        providers: record?.providers ?? [],
        settings: config.settings,
        configSchema: entry.manifest.configSchema ?? {},
        permissions: entry.manifest.permissions ?? [],
        prompt: entry.manifest.prompt ?? null,
        capabilities: entry.manifest.capabilities ?? [],
      });
    }
    const enabled = list.filter((item) => item.enabled && item.loaded && item.available?.ok);
    return {
      ok: true,
      root: this.root,
      dataDir: this.dataDir,
      loadedAt: this.startedAt,
      counts: {
        plugins: list.filter((item) => item.kind === "plugins").length,
        skills: list.filter((item) => item.kind === "skills").length,
        enabled: enabled.length,
        failed: list.filter((item) => item.enabled && !item.loaded).length,
      },
      errors: this.errors.slice(-50),
      extensions: list,
      tools: this.tools.all().map((item) => ({ name: item.name, description: String(item.spec.description ?? "").slice(0, 160), extensionId: item.extensionId })),
    };
  }

  /* --------------------------- 钩子 --------------------------- */

  async #runHooks(name, payload) {
    const list = this.hooks.get(name) ?? [];
    const results = [];
    for (const item of list) {
      const record = this.extensions.get(`${item.kind}/${item.extensionId}`);
      if (!record?.ok || !record.enabled || !record.available?.ok) continue;
      try {
        const value = await withTimeout(Promise.resolve().then(() => item.fn(payload)), HOOK_TIMEOUT_MS, `${name}@${item.extensionId}`);
        if (value !== undefined) results.push({ extensionId: item.extensionId, value });
      } catch (error) {
        record.log.warn(`钩子 ${name} 执行失败：${String(error?.message ?? error)}`);
      }
    }
    return results;
  }

  async beforeContext(ctx) {
    const payload = { ...ctx, api: undefined };
    return this.#runHooks("before-context", payload);
  }

  async beforeLlmMessages(ctx) {
    const payload = { ...ctx };
    await this.#runHooks("before-llm-messages", payload);
    return payload.messages;
  }

  async beforeTool(ctx) {
    const results = await this.#runHooks("before-tool", ctx);
    for (const item of results) {
      if (item.value && typeof item.value === "object" && item.value.block) {
        return { block: true, reason: String(item.value.reason ?? "工具被扩展拦截") };
      }
    }
    return { block: false };
  }
  async afterTool(ctx) {
    await this.#runHooks("after-tool", ctx);
  }

  async afterResponse(ctx) {
    await this.#runHooks("after-response", ctx);
  }

  /* --------------------------- 能力提供者 --------------------------- */

  async callProvider(name, args) {
    const list = this.providers.get(name) ?? [];
    for (const item of list) {
      const record = this.extensions.get(`${item.kind}/${item.extensionId}`);
      if (!record?.ok || !record.enabled || !record.available?.ok) continue;
      try {
        const value = await item.fn(args);
        if (value !== undefined) return value;
      } catch (error) {
        record.log.warn(`能力 ${name} 提供者 ${item.extensionId} 失败：${String(error?.message ?? error)}`);
      }
    }
    return undefined;
  }

  async wakePolicy(args) {
    return this.callProvider("wake.burst-policy", args);
  }

  /**
   * 同步版的唤醒策略（群消息缓冲/私聊防抖是同步调用的）。
   * burst-merge 的 decide 是纯函数，这里直接同步调用；万一提供者返回 Promise，
   * 就忽略它（宁可按时响应，也不能让消息永远悬着）。
   */
  wakePolicySync(args) {
    for (const item of this.providers.get("wake.burst-policy") ?? []) {
      const record = this.extensions.get(`${item.kind}/${item.extensionId}`);
      if (!record?.ok || !record.enabled || !record.available?.ok) continue;
      try {
        const value = item.fn(args);
        if (value && typeof value.then === "function") {
          record.log.warn("wake.burst-policy 提供者是异步的，宿主只支持同步判定，已忽略");
          continue;
        }
        if (value !== undefined) return value;
      } catch (error) {
        record.log.warn(`唤醒策略失败（按时响应）：${String(error?.message ?? error)}`);
      }
    }
    return undefined;
  }

  async interestJudge(args) {
    return this.callProvider("reply.interest-judge", args);
  }

  async personCard(args) {
    return this.callProvider("memory.person-card", args);
  }

  async requestParams(body, context) {
    const value = await this.callProvider("llm.request-params", { body, context });
    if (value && typeof value === "object" && value.body && typeof value.body === "object") return value.body;
    return undefined;
  }

  /* --------------------------- 提示词片段 --------------------------- */

  promptSections(ctx = {}) {
    const collected = [];
    let seq = 0;
    const pushSection = (item, { dynamic = false, extensionId = "" } = {}) => {
      const content = String(item?.content ?? "").trim();
      if (!content) return;
      const fallback = dynamic ? 40 : 50;
      const priority = Number.isFinite(Number(item.priority)) ? Math.min(99, Number(item.priority)) : fallback;
      collected.push({
        id: String(item.id || (dynamic ? `${extensionId}-dynamic` : `${extensionId}-section`)),
        title: String(item.title || extensionId),
        priority,
        content,
        extensionId,
        seq: seq++,
      });
    };
    for (const item of this.staticSections) pushSection(item, { extensionId: item.extensionId });
    for (const item of this.dynamicSectionFns) {
      const record = this.extensions.get(`${item.kind}/${item.extensionId}`);
      if (!record?.ok || !record.enabled || !record.available?.ok) continue;
      try {
        const value = item.fn(ctx);
        if (Array.isArray(value)) {
          for (const section of value) {
            if (!section) continue;
            if (typeof section === "string") {
              pushSection({ id: `${item.extensionId}-dynamic`, title: record.manifest?.name ?? item.extensionId, content: section }, { dynamic: true, extensionId: item.extensionId });
            } else {
              pushSection({ ...section, title: section.title || record.manifest?.name || item.extensionId }, { dynamic: true, extensionId: item.extensionId });
            }
          }
        } else if (typeof value === "string") {
          pushSection({ id: `${item.extensionId}-dynamic`, title: record.manifest?.name ?? item.extensionId, content: value }, { dynamic: true, extensionId: item.extensionId });
        }
      } catch (error) {
        record.log.warn(`promptSections 失败：${String(error?.message ?? error)}`);
      }
    }
    // 上游约定：按 id 去重（后写覆盖先写）→ 按 priority 降序 → 同 priority 保持原始顺序
    const byId = new Map();
    for (const item of collected) byId.set(item.id, item);
    const ordered = [...byId.values()].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let used = 0;
    const out = [];
    for (const item of ordered) {
      if (used + item.content.length > MAX_PROMPT_SECTIONS_TOTAL) break;
      used += item.content.length;
      out.push({ id: item.id, title: item.title, content: item.content, priority: item.priority });
    }
    return out;
  }

  /* --------------------------- 工具 / 模型 --------------------------- */

  toolDefinitions() {
    const allow = [];
    for (const record of this.extensions.values()) {
      if (!record.ok || !record.enabled || !record.available?.ok) continue;
      for (const tool of record.tools) allow.push(tool.name);
    }
    // 核心工具（finish / collect_sticker / list_stickers）不属于任何扩展，但模型必须能看到；
    // 一个扩展工具都没有时就不暴露它们，免得模型对着一堆没用的工具乱调。
    if (allow.length) {
      for (const entry of this.tools.all()) {
        if (entry.extensionId === "core" && !allow.includes(entry.name)) allow.push(entry.name);
      }
    }
    if (!allow.length) return [];
    return this.tools.definitions({ allow });
  }

  async runTool(name, ctx, argsRaw, options) {
    const toolName = String(name ?? "");
    const entry = this.tools.get(toolName);
    /*
     * 单个工具的超时是可以由扩展自己声明的（spec.timeoutMs，上限 180s）：
     * 发说说、上传大图这类协议端动作本身就要一两分钟，固定的 30 秒会误杀，
     * 而超时后动作可能已经在协议端执行，模型重试就会重复发送。
     */
    const specTimeout = Number(entry?.spec?.timeoutMs);
    const optionsTimeout = Number(options?.timeoutMs);
    const timeoutMs = Math.max(1000, Math.min(180000, Number.isFinite(specTimeout) ? specTimeout : Number.isFinite(optionsTimeout) ? optionsTimeout : 30000));
    const block = await this.beforeTool({ ...ctx, toolName, argsRaw, args: ctx?.args ?? safeParseArgs(argsRaw) });
    if (block.block) return { content: `本轮不能调用这个工具：${block.reason}`, isError: true, blocked: true };
    const result = await this.tools.execute(toolName, ctx, argsRaw, { timeoutMs });
    const args = ctx?.args ?? safeParseArgs(argsRaw);
    await this.afterTool({ ...ctx, toolName, argsRaw, args, result });
    return result;
  }

  /** 工具执行 ctx 里的 args 便利字段（上游只在 execute 第二参数给 args，这里补一份只读副本）。 */
  static parseToolArgs(argsRaw) {
    return safeParseArgs(argsRaw);
  }

  /* --------------------------- 供 chat 使用 --------------------------- */

  /** 构造一轮的扩展上下文（chat.mjs 调用）。 */
  turnContext({ scopeKey, kind, chatId, selfId, sessionId, proactive = false, triggerEntries = [], messages = null, session = null, extra = {} } = {}) {
    const chatKey = extensionChatKey(scopeKey);
    const id = String(chatId ?? "") || chatKey.split(":")[1] || "";
    return {
      chatKey,
      chatId: id,
      kind: String(kind ?? (chatKey.startsWith("group:") ? "group" : "private")),
      selfId: String(selfId ?? ""),
      sessionId: String(sessionId ?? ""),
      proactive: Boolean(proactive),
      triggerEntries: Array.isArray(triggerEntries) ? triggerEntries : [],
      recent: this.messageStore().recent(chatKey, { limit: 20 }).map((item) => ({
        senderId: item.senderId,
        senderName: item.senderName,
        text: item.text,
        at: item.at,
        self: item.self,
      })),
      messages,
      session,
      store: this.messageStore(),
      stickers: this.stickers.api(),
      onebot: this.onebot(),
      sender: this.sender,
      visionEnabled: this.#visionEnabled(),
      tools: {
        get: (name) => {
          const found = this.tools.get(name);
          return found ? found.spec : null;
        },
        all: () => this.tools.all().map((item) => item.spec),
      },
      emit: () => {},
      ...extra,
    };
  }

  /** 记录一轮会话（group-cost-report 等按会话统计的插件读这个）。 */
  recordSession({ id, chatKey = "", scopeKey = "", kind, startedAt, usage, model, vendor, cost, trigger, proactive = false, toolEvents = [] } = {}) {
    try {
      const dir = path.join(this.dataDir, "sessions");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(id).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
      writeJsonAtomic(file, {
        id,
        chatKey: String(chatKey || (scopeKey ? extensionChatKey(scopeKey) : "")),
        kind: String(kind ?? ""),
        startedAt: Number(startedAt) || Date.now(),
        finishedAt: Date.now(),
        model: String(model ?? ""),
        vendor: String(vendor ?? ""),
        usage: {
          promptTokens: Number(usage?.tokensIn ?? usage?.promptTokens ?? 0) || 0,
          completionTokens: Number(usage?.tokensOut ?? usage?.completionTokens ?? 0) || 0,
          cachedTokens: Number(usage?.cachedTokens ?? 0) || 0,
          totalTokens: Number(usage?.totalTokens ?? (Number(usage?.tokensIn ?? 0) + Number(usage?.tokensOut ?? 0))) || 0,
          calls: Number(usage?.calls ?? 1) || 1,
        },
        cost: Number(cost ?? usage?.cost ?? 0) || 0,
        trigger: Array.isArray(trigger) ? trigger : [],
        proactive: Boolean(proactive),
        tools: Array.isArray(toolEvents) ? toolEvents.slice(0, 20).map((item) => ({ name: item.name, isError: Boolean(item.isError) })) : [],
      });
      this.#pruneSessions(dir);
      return { ok: true };
    } catch (error) {
      log.warn(`写会话记录失败：${String(error?.message ?? error)}`);
      return { ok: false };
    }
  }

  #pruneSessions(dir) {
    try {
      const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
      if (files.length <= 3000) return;
      const details = files
        .map((name) => ({ name, at: Number(fs.statSync(path.join(dir, name)).mtimeMs) || 0 }))
        .sort((a, b) => a.at - b.at);
      for (const item of details.slice(0, files.length - 3000)) fs.rmSync(path.join(dir, item.name), { force: true });
    } catch {
      /* ignore */
    }
  }

  /* --------------------------- 模型 / 价格（兼容层用） --------------------------- */

  async chatCompletion(options = {}) {
    if (!this.llm?.chat) throw new Error("模型网关还没就绪");
    const overrides = {};
    const fromOverrides = options.overrides && typeof options.overrides === "object" ? options.overrides : {};
    for (const key of ["model", "baseUrl", "apiKey", "maxTokens", "temperature"]) {
      if (fromOverrides[key] !== undefined) overrides[key] = fromOverrides[key];
    }
    const messages = Array.isArray(options.messages) ? options.messages : [];
    /*
     * 判定类调用（context-chime 这种）不想要思考：思考型模型会把 max_tokens 全花在
     * reasoning 上，正文为空、判定直接失效。不同服务商的「关思考」字段不一样，
     * llm.chat 里对未知字段有 400 自动去字段重试的兜底，这里一并带上常见写法。
     */
    const extraBody = options.reasoningOff
      ? { enable_thinking: false, thinking: { type: "disabled" }, chat_template_kwargs: { enable_thinking: false } }
      : null;
    const timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 15000));
    const pending = this.llm.chat(messages, {
      task: "intent",
      extraBody,
      overrides: {
        ...(options.model ? { model: options.model } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        maxTokens: Math.max(8, Math.min(4000, Number(options.maxTokens) || 64)),
        temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0,
        ...overrides,
      },
    });
    let timer = null;
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`判定请求超时（${timeoutMs}ms）`)), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const usage = result.usage ?? {};
    return {
      text: result.text,
      message: { role: "assistant", content: result.text },
      usage: {
        prompt_tokens: Number(usage.tokensIn ?? 0),
        completion_tokens: Number(usage.tokensOut ?? 0),
        total_tokens: Number(usage.tokensIn ?? 0) + Number(usage.tokensOut ?? 0),
      },
      finishReason: result.raw?.choices?.[0]?.finish_reason ?? "",
      model: result.model,
      requestId: result.requestId,
    };
  }

  resolveModelPrice(model, cfg = null) {
    const config = cfg ?? getConfig();
    const target = String(model ?? "").trim();
    for (const profile of Object.values(config?.llm?.profiles ?? {})) {
      if (String(profile?.model ?? "") === target && Number.isFinite(Number(profile?.priceIn))) {
        return { in: Number(profile.priceIn) || 0, out: Number(profile.priceOut) || 0, cached: Number(profile.priceIn) || 0, peak: false, source: "profile" };
      }
    }
    return { in: 0, out: 0, cached: 0, peak: false, source: "unknown" };
  }

  /* --------------------------- 核心工具 --------------------------- */

  #registerCoreTools() {
    this.tools.register("core", {
      id: "finish",
      name: "结束本轮",
      description: "本轮要做的事已经做完了，调用它结束这一轮（不发送任何内容）。",
      category: "system",
      parameters: { type: "object", properties: {} },
      execute: () => ({ content: "", finish: true }),
    });
    this.tools.register("core", {
      id: "collect_sticker",
      name: "收藏表情",
      description: "把当前会话某条消息里的图片收进自己的私密表情收藏夹。messageId 用消息里的编号；note 写一句为什么想收。",
      category: "sticker",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "要收藏的消息编号" },
          note: { type: "string", description: "为什么喜欢这张（会进收藏档案）" },
        },
        required: ["messageId"],
      },
      execute: async (ctx, args) => this.stickers.collectFromMessage({ messageId: args?.messageId, note: args?.note, chatKey: ctx?.chatKey }),
    });
    this.tools.register("core", {
      id: "list_stickers",
      name: "看我的收藏夹",
      description: "列出自己收藏的表情（编号、时间、备注）。",
      category: "sticker",
      parameters: { type: "object", properties: { limit: { type: "number", description: "最多列出几张，默认 30" } } },
      execute: async (_ctx, args) => this.stickers.listText(args?.limit),
    });
  }

  /* --------------------------- 关闭 --------------------------- */

  dispose() {
    for (const record of this.extensions.values()) {
      if (!record.ok) continue;
      this.#callLifecycle(record, "deactivate");
      this.#callLifecycle(record, "dispose");
    }
    this.extensions.clear();
    this.hooks.clear();
    this.providers.clear();
    this.staticSections = [];
    this.dynamicSectionFns = [];
  }
}

/* ------------------------------ 辅助 ------------------------------ */

/** 心语 scopeKey → 扩展 chatKey（group:<群号> / private:<QQ号>）。 */
export function extensionChatKey(scopeKey) {
  const text = String(scopeKey ?? "").trim();
  if (text.startsWith("private_")) return `private:${text.slice(8)}`;
  if (text.startsWith("group_")) {
    const parts = text.split("_");
    return `group:${String(parts[1] ?? "")}`;
  }
  return text;
}

function extensionMessageRow(row) {
  const media = [];
  try {
    const attachments = JSON.parse(row.attachments_json || "[]");
    for (const item of Array.isArray(attachments) ? attachments : []) {
      if (item?.type === "image" || item?.kind === "image") media.push({ kind: "image", url: String(item.url ?? ""), file: String(item.file ?? "") });
    }
  } catch {
    /* ignore */
  }
  const at = Number(row.at) || 0;
  const self = row.direction === "out";
  return {
    id: row.id,
    mid: String(row.platform_message_id || row.event_key || ""),
    messageId: String(row.platform_message_id || ""),
    chatKey: String(row.scope_key ?? "").replace(/^(private|group)_([^_]+).*$/, (_m, type, id) => `${type}:${id}`),
    senderId: String(row.sender_id ?? ""),
    senderName: String(row.sender_name ?? ""),
    text: String(row.body ?? ""),
    self,
    at,
    ts: at,
    read: true,
    atMe: Boolean(row.is_mention),
    atNames: [],
    isPoke: false,
    reply: null,
    media,
    segments: safeParse(row.segments_json, []),
  };
}

function safeParseArgs(argsRaw) {
  if (argsRaw && typeof argsRaw === "object") return argsRaw;
  try {
    return JSON.parse(String(argsRaw ?? "") || "{}");
  } catch {
    return {};
  }
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return fallback;
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function defaultExtensionRoot() {
  return path.join(paths.installed ? path.join(paths.installRoot, "app") : paths.app, "extensions");
}

function isBundled() {
  return process.env.HEARTECHO_BUNDLED === "1" || globalThis.__HEARTECHO_BUNDLED__ === true;
}

const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

export function validateExternalUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("地址为空");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || /\.(local|internal|lan|home)$/i.test(host)) throw new Error("不允许内网/本机地址");
  return url.toString();
}
