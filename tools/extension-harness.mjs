/**
 * 扩展包测试用的 mock 宿主。
 *
 * 目标：不连 QQ、不联网、不读真实数据目录，也能测扩展包里的确定性逻辑
 * （设置默认值、算法、钩子行为、工具返回结构、发送参数）。
 *
 * 用法（扩展包里的 test.mjs）：
 *   import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";
 *   export const cases = [
 *     { name: "设置默认值", run: async (t) => {
 *         const host = createMockHost({ id: "ledger", settings: { autoRecord: true } });
 *         installTestRuntime({ dataDir: t.tempDir(), settings: { "skills/ledger": { autoRecord: true } } });
 *         ...
 *     } },
 *   ];
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindExtensionServices } from "../lib/extensions-runtime.mjs";

export function createMockHost({ id = "test", settings = {}, dataDir = "", storeMessages = [] } = {}) {
  let current = { ...settings };
  const tools = new Map();
  const logs = [];
  const calls = { sent: [], images: [], onebot: [] };
  let messages = [...storeMessages];
  let onCall = null;
  const dataRoot = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), `he-ext-${safeName(id)}-`));

  const store = {
    recent(_chatKey, { limit = 50 } = {}) {
      return messages.slice(-Math.max(1, Math.min(500, limit))).map((m) => ({ ...m }));
    },
    findByMid(_chatKey, mid) {
      return messages.find((m) => String(m.mid ?? m.messageId ?? "") === String(mid)) ?? null;
    },
    set(list) {
      messages = [...(list ?? [])];
    },
  };

  const stickers = new Map();
  const stickerApi = {
    find(stickerId) {
      return stickers.get(String(stickerId)) ?? null;
    },
    list() {
      return [...stickers.values()];
    },
    collect(item = {}) {
      const sid = String(item.id ?? stickers.size + 1);
      const value = { id: sid, url: String(item.url ?? ""), file: String(item.file ?? ""), note: String(item.note ?? "") };
      stickers.set(sid, value);
      return value;
    },
  };

  const sender = {
    async sendText(text) {
      calls.sent.push({ kind: "text", text: String(text) });
      return { messageId: `mock-${calls.sent.length}` };
    },
    async sendTextBatch(list) {
      for (const text of list ?? []) calls.sent.push({ kind: "text", text: String(text) });
      return { sent: (list ?? []).length, messageIds: (list ?? []).map((_, i) => `mock-b-${i}`) };
    },
    async sendImage(image = {}, options = {}) {
      calls.images.push({ image, options });
      return { messageId: `mock-img-${calls.images.length}` };
    },
  };

  const onebot = {
    connected: true,
    selfInfo: { user_id: 10001, nickname: "小语" },
    async call(action, params = {}, timeoutMs = 0) {
      calls.onebot.push({ action, params, timeoutMs });
      if (onCall) return onCall(action, params, timeoutMs);
      return { ok: true, action };
    },
    async getGroupMemberInfo(groupId, userId) {
      return { group_id: Number(groupId), user_id: Number(userId), nickname: `群友${userId}`, card: "" };
    },
  };

  const api = {
    config() {
      return { ...current };
    },
    log(...args) {
      logs.push({ level: "info", args });
    },
    warn(...args) {
      logs.push({ level: "warn", args });
    },
    error(...args) {
      logs.push({ level: "error", args });
    },
    async fetch(url, init) {
      throw new Error(`mock 宿主不联网：${url} ${init ? "(init)" : ""}`);
    },
    registerTool(spec) {
      if (!spec || typeof spec !== "object") throw new Error("registerTool 需要对象");
      const key = String(spec.id ?? spec.name ?? tools.size);
      tools.set(key, spec);
    },
    isSkillActive() {
      return true;
    },
    tools: {
      get(name) {
        return tools.get(String(name)) ?? null;
      },
      byName(name) {
        return [...tools.values()].find((item) => item.name === name) ?? null;
      },
      all() {
        return [...tools.values()];
      },
    },
    visionEnabled: true,
    model: "mock-model",
    baseUrl: "https://example.test",
    store,
    stickers: stickerApi,
    onebot,
    sender,
    dataDir: dataRoot,
    emit() {},
  };

  function ctx(extra = {}) {
    return {
      chatKey: "group:123456",
      chatId: "123456",
      kind: "group",
      selfId: "10001",
      sessionId: "mock-session-1",
      proactive: false,
      triggerEntries: [{ senderId: "20002", senderName: "群友", text: "你好呀", atMe: true, isSelf: false }],
      recent: messages.slice(-10).map((m) => ({ senderId: m.senderId, senderName: m.senderName, text: m.text, at: m.at, self: m.self })),
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "【未读信息】\n群友：你好呀" },
      ],
      session: { id: "mock-session-1", startedAt: Date.now(), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, calls: 1 }, cost: 0.0001, model: "mock-model" },
      store,
      stickers: stickerApi,
      onebot,
      sender,
      visionEnabled: true,
      tools: api.tools,
      emit() {},
      ...extra,
    };
  }

  return {
    api,
    tools,
    logs,
    calls,
    dataDir: dataRoot,
    get settings() {
      return { ...current };
    },
    setSettings(patch) {
      current = { ...current, ...(patch ?? {}) };
    },
    setMessages(list) {
      store.set(list);
    },
    setOnCall(fn) {
      onCall = fn;
    },
    stickerStore: stickers,
    ctx,
    cleanup() {
      try {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

const harnessSettings = new Map();
let runtimeInstalled = false;

/**
 * 给用到 `../../src/*` 兼容层的扩展装一个最小运行时。
 * 同一个进程里多次调用会覆盖（测试之间用不同 dataDir 隔离）。
 */
export function installTestRuntime({ dataDir, settings = {}, getConfig = null } = {}) {
  runtimeInstalled = true;
  harnessSettings.clear();
  for (const [key, value] of Object.entries(settings ?? {})) harnessSettings.set(String(key), value);
  bindExtensionServices({
    dataDir,
    settingsFor(kind, id) {
      return { ...(harnessSettings.get(`${kind}/${id}`) ?? {}) };
    },
    logger() {
      return { info() {}, warn() {}, error() {}, debug() {} };
    },
    getConfig() {
      return typeof getConfig === "function" ? getConfig() : {};
    },
    updateConfig() {
      return {};
    },
    async chatCompletion() {
      throw new Error("mock 宿主不调用模型");
    },
    resolveModelPrice() {
      return { in: 0, out: 0, cached: 0 };
    },
    getToolAvailability() {
      return { ok: true };
    },
    stickerPathByUrl() {
      return null;
    },
    stickers: { find: () => null, list: () => [] },
  });
  return { installed: runtimeInstalled };
}

function safeName(value) {
  return String(value ?? "x").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "x";
}

export function tempDir(prefix = "he-ext-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
