/**
 * LLM 工具调用（function calling）基础设施。
 *
 * 为什么需要：插件/技能生态里，技能通过 `api.registerTool(spec)` 给模型注册能力
 * （查好感度、记账、搜图、发空间……）。心语原先是「一次请求 → 一段文本」，
 * 这里补上 OpenAI 兼容的 tools 协议：模型返回 tool_calls → 执行 → 把结果作为
 * tool 消息回填 → 再请求，直到模型给出最终文本。
 *
 * 边界：
 *   - 只负责「工具注册表 + 参数/结果规范化」，具体的多轮循环在 llm.mjs 里，
 *     因为那里才持有预算、重试、scope 校验的上下文。
 *   - 工具执行永远串行（同一轮里的多个 tool_call 依次跑）：扩展的工具可能有副作用
 *     （发消息/写文件），并行会让去重和限频失效。
 *   - 单个工具结果截断到 MAX_TOOL_RESULT_CHARS，防止一次抓网页把上下文撑爆。
 */

export const MAX_TOOL_RESULT_CHARS = 8000;

/** OpenAI 函数名只允许 [a-zA-Z0-9_-]，最长 64。 */
export function sanitizeToolName(raw) {
  return String(raw ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64) || "tool";
}

/**
 * 工具注册表。
 *
 * 每个工具同时用两个名字索引：
 *   - 全名 `<扩展id>__<工具id>`（发给模型用，避免不同扩展撞名）
 *   - 裸名 `<工具id>`（扩展之间互相调用核心工具用，例如 meme-taste 调 collect_sticker）
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, {name:string, bareName:string, extensionId:string, spec:object}>} */
    this.byFull = new Map();
    this.byBare = new Map();
    this.conflicts = [];
  }

  register(extensionId, spec) {
    if (!spec || typeof spec !== "object") throw new Error("工具定义必须是对象");
    const rawId = String(spec.id ?? spec.name ?? "").trim();
    if (!rawId) throw new Error("工具缺少 id");
    const bareName = sanitizeToolName(rawId);
    const extension = String(extensionId ?? "core");
    const fullName = extension === "core" ? bareName : sanitizeToolName(`${extension}__${bareName}`);
    if (this.byFull.has(fullName)) {
      this.conflicts.push({ name: fullName, reason: "重复的工具全名" });
      throw new Error(`工具名重复：${fullName}`);
    }
    const entry = { name: fullName, bareName, extensionId: extension, spec, id: rawId };
    this.byFull.set(fullName, entry);
    if (!this.byBare.has(bareName)) this.byBare.set(bareName, entry);
    else this.conflicts.push({ name: bareName, reason: "裸名重复（后注册的不覆盖）" });
    return entry;
  }

  get(name) {
    const text = String(name ?? "");
    return this.byFull.get(text) ?? this.byBare.get(text) ?? null;
  }

  bare(name) {
    return this.byBare.get(String(name ?? "")) ?? null;
  }

  has(name) {
    return Boolean(this.get(name));
  }

  all() {
    return [...this.byFull.values()];
  }

  clearExtension(extensionId) {
    for (const [name, entry] of this.byFull) {
      if (entry.extensionId === String(extensionId)) {
        this.byFull.delete(name);
        if (this.byBare.get(entry.bareName) === entry) this.byBare.delete(entry.bareName);
      }
    }
  }

  /** 转成 OpenAI tools 数组；filter 可只保留部分全名。 */
  definitions({ allow = null } = {}) {
    const list = [];
    for (const entry of this.byFull.values()) {
      if (entry.spec.hidden) continue;
      if (Array.isArray(allow) && !allow.includes(entry.name)) continue;
      list.push(toOpenAITool(entry));
    }
    return list;
  }

  /**
   * 执行一个工具。argsRaw 可能是 JSON 字符串（模型给的）或对象。
   * 返回 {content, isError, meta}，永不抛错（错误会变成 isError 的结果，让模型自己决定下一步）。
   */
  async execute(name, ctx, argsRaw, { timeoutMs = 30000 } = {}) {
    const entry = this.get(name);
    if (!entry) return { content: `没有这个工具：${name}`, isError: true, meta: { missing: true } };
    let args;
    let rawText;
    if (typeof argsRaw === "string") {
      rawText = argsRaw;
      try {
        args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
      } catch {
        args = {};
        rawText = argsRaw;
      }
    } else {
      args = argsRaw ?? {};
      rawText = JSON.stringify(args);
    }
    const started = Date.now();
    let timer = null;
    try {
      const callCtx = { ...ctx, toolName: entry.name, args, argsRaw: rawText };
      const spec = entry.spec;
      const fn = typeof spec.execute === "function" ? spec.execute : typeof spec.run === "function" ? spec.run : null;
      if (!fn) throw new Error("工具没有 execute");
      const value = await Promise.race([
        Promise.resolve(fn(callCtx, args)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`工具执行超时（${timeoutMs}ms）`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const maxChars = Math.max(1000, Math.min(30000, Number(spec.maxResultChars) || MAX_TOOL_RESULT_CHARS));
      return normalizeToolResult(value, Date.now() - started, maxChars);
    } catch (error) {
      return { content: `工具执行失败：${String(error?.message ?? error)}`, isError: true, meta: { ms: Date.now() - started } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function toOpenAITool(entry) {
  const spec = entry.spec;
  const properties = spec.parameters?.properties ?? spec.parameters?.schema?.properties ?? {};
  const required = spec.parameters?.required ?? spec.required ?? [];
  const schema = {
    type: "object",
    properties: normalizeSchemaProperties(properties),
  };
  if (Array.isArray(required) && required.length) schema.required = required.map(String);
  return {
    type: "function",
    function: {
      name: entry.name,
      description: String(spec.description ?? spec.name ?? "").slice(0, 4000),
      parameters: schema,
    },
  };
}

/** 把扩展里的 JSON Schema 子集规整成 OpenAI 能接受的形状（丢掉无法表达的键）。 */
function normalizeSchemaProperties(properties) {
  const out = {};
  if (!properties || typeof properties !== "object") return out;
  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== "object") continue;
    const item = { ...value };
    if (Array.isArray(item.type)) item.type = item.type.map((t) => (t === "integer" ? "number" : t))[0];
    delete item.default;
    if (item.properties) item.properties = normalizeSchemaProperties(item.properties);
    if (item.items && item.items.properties) item.items = { ...item.items, properties: normalizeSchemaProperties(item.items.properties) };
    out[key] = item;
  }
  return out;
}

/** 统一工具返回值：支持 {content,isError} / 字符串 / 任意对象。 */
export function normalizeToolResult(value, ms = 0, maxChars = MAX_TOOL_RESULT_CHARS) {
  let content;
  let isError = false;
  if (value == null) content = "（工具没有返回内容）";
  else if (typeof value === "string") content = value;
  else if (typeof value === "object") {
    if (typeof value.content === "string") content = value.content;
    else if (typeof value.text === "string") content = value.text;
    else content = JSON.stringify(value);
    isError = value.isError === true || value.is_error === true;
  } else content = String(value);
  content = String(content ?? "").trim() || "（空结果）";
  let truncated = false;
  const limit = Math.max(200, Number(maxChars) || MAX_TOOL_RESULT_CHARS);
  if (content.length > limit) {
    content = `${content.slice(0, limit)}\n…（结果过长，已截断）`;
    truncated = true;
  }
  return { content, isError, meta: { ms, truncated } };
}

/** 从模型返回的 tool_calls 里解析出要执行的内容。 */
export function parseToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.map((call, index) => {
    const fn = call?.function ?? call ?? {};
    return {
      id: String(call?.id ?? `call-${index}`),
      name: String(fn.name ?? ""),
      argsRaw: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    };
  }).filter((item) => item.name);
}

/** 助手 tool_calls 消息（回填进 messages）。 */
export function assistantToolMessage(message, toolCalls) {
  const base = { role: "assistant", content: typeof message?.content === "string" ? message.content : "" };
  base.tool_calls = toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.argsRaw },
  }));
  return base;
}

export function toolResultMessage(toolCallId, result) {
  return { role: "tool", tool_call_id: String(toolCallId), content: String(result?.content ?? "") };
}
