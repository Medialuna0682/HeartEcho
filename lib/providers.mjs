/**
 * 模型供应商预设：让用户「选一家 → 填 Key → 测试」就能用，不用自己查 Base URL 和模型名。
 *
 * 约定：所有预设都走 OpenAI 兼容的 /chat/completions，因此网关只有一种协议实现。
 * 价格只是「用于估算」的默认值，用户可以随时在面板里改。
 */

/**
 * 单次回复的输出上限天花板（token）。
 *
 * 思考型模型（DeepSeek 的 v4-pro、Kimi k3/k2.6 之类）会先把 max_tokens 花在
 * reasoning_content 上：上限给小了，思考到一半就被截断，正文一个字都没有，
 * 用户看到的是「输出额度全部用于思考，正文为空」。
 *
 * 面板的「单次回复上限」允许拉到这个值；请求又按 Profile 的实际设置取小，
 * 所以这只是上限，不会按上限扣钱（实际按返回的 token 数结算）。
 * 个别模型不支持这么大的 max_tokens，网关收到 400 会自动降级。
 */
export const MAX_OUTPUT_TOKENS = 65536;

export const PROVIDERS = [
  {
    id: "deepseek",
    name: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com/v1",
    site: "https://platform.deepseek.com",
    models: [
      { id: "deepseek-flash", name: "deepseek-flash（快、便宜、推荐）", contextTokens: 131072, priceIn: 1, priceOut: 2, vision: true },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro（更强，带思考）", contextTokens: 131072, priceIn: 4, priceOut: 16, vision: true },
    ],
    note: "国内直连、价格便宜，首次使用推荐。价格单位：元/百万 token，可在面板里改。",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    site: "https://platform.openai.com",
    models: [
      { id: "gpt-4o-mini", name: "gpt-4o-mini（便宜、支持看图）", contextTokens: 128000, priceIn: 1.1, priceOut: 4.4, vision: true },
      { id: "gpt-4o", name: "gpt-4o（效果最好、支持看图）", contextTokens: 128000, priceIn: 18, priceOut: 72, vision: true },
    ],
    note: "需要能访问 api.openai.com 的网络环境。",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    site: "https://platform.moonshot.cn",
    /**
     * 注意：moonshot-v1-8k / 32k 这些老模型现在很多 Key 已经不能用了
     * （调用会返回 404 resource_not_found_error）。以 /v1/models 实际返回为准，
     * 面板里点「拉取可用模型」就能看到你这个 Key 到底能用哪些。
     */
    models: [
      { id: "kimi-k2.6", name: "kimi-k2.6（推荐，支持看图）", contextTokens: 262144, priceIn: 12, priceOut: 12, vision: true },
      { id: "kimi-k3", name: "kimi-k3（最新，支持看图，偏慢）", contextTokens: 262144, priceIn: 12, priceOut: 12, vision: true },
      { id: "kimi-k2.7-code", name: "kimi-k2.7-code（代码向）", contextTokens: 262144, priceIn: 12, priceOut: 12, vision: true },
      { id: "kimi-k2.7-code-highspeed", name: "kimi-k2.7-code-highspeed（快）", contextTokens: 262144, priceIn: 12, priceOut: 12, vision: true },
    ],
    note: "中文语感好，长上下文。老模型 moonshot-v1-* 可能已不可用，用「拉取可用模型」确认一下。",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    site: "https://open.bigmodel.cn",
    models: [
      { id: "glm-4-flash", name: "glm-4-flash（免费额度多）", contextTokens: 131072, priceIn: 0, priceOut: 0, vision: false },
      { id: "glm-4-plus", name: "glm-4-plus", contextTokens: 131072, priceIn: 50, priceOut: 50, vision: false },
      { id: "glm-4v-flash", name: "glm-4v-flash（支持看图）", contextTokens: 8192, priceIn: 0, priceOut: 0, vision: true },
    ],
    note: "glm-4-flash 有免费额度，适合先试水。",
  },
  {
    id: "qwen",
    name: "阿里云百炼（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    site: "https://bailian.console.aliyun.com",
    models: [
      { id: "qwen-plus", name: "qwen-plus", contextTokens: 131072, priceIn: 0.8, priceOut: 2, vision: false },
      { id: "qwen-turbo", name: "qwen-turbo（更便宜）", contextTokens: 131072, priceIn: 0.3, priceOut: 0.6, vision: false },
      { id: "qwen-vl-plus", name: "qwen-vl-plus（支持看图）", contextTokens: 32768, priceIn: 1.5, priceOut: 4.5, vision: true },
    ],
    note: "国内直连，新用户有免费额度。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    site: "https://cloud.siliconflow.cn",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek-V3", contextTokens: 65536, priceIn: 2, priceOut: 8, vision: false },
      { id: "Qwen/Qwen2.5-7B-Instruct", name: "Qwen2.5-7B（很便宜）", contextTokens: 32768, priceIn: 0, priceOut: 0, vision: false },
      { id: "Qwen/Qwen2-VL-7B-Instruct", name: "Qwen2-VL-7B（支持看图）", contextTokens: 32768, priceIn: 0, priceOut: 0, vision: true },
    ],
    note: "聚合了很多开源模型，部分模型免费。",
  },
  {
    id: "ollama",
    name: "本地 Ollama（不联网、不花钱）",
    baseUrl: "http://127.0.0.1:11434/v1",
    site: "https://ollama.com",
    models: [
      { id: "qwen2.5:7b", name: "qwen2.5:7b", contextTokens: 32768, priceIn: 0, priceOut: 0, vision: false },
      { id: "llama3.1:8b", name: "llama3.1:8b", contextTokens: 32768, priceIn: 0, priceOut: 0, vision: false },
    ],
    note: "需要自己先装 Ollama 并 ollama pull 对应模型；API Key 随便填一个非空值即可。",
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    baseUrl: "",
    site: "",
    models: [],
    note: "任何兼容 chat/completions 的服务都可以填在这里，包括中转站。",
  },
];

export function findProvider(id) {
  return PROVIDERS.find((item) => item.id === id) ?? null;
}

export function providerModels(id) {
  return findProvider(id)?.models ?? [];
}

/** 根据已有 Base URL 反推供应商 id（用户手改过 URL 时用得上）。 */
export function guessProviderId(baseUrl) {
  const url = String(baseUrl ?? "").toLowerCase();
  if (!url) return "custom";
  for (const provider of PROVIDERS) {
    if (provider.baseUrl && url.startsWith(provider.baseUrl.toLowerCase())) return provider.id;
  }
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("moonshot")) return "moonshot";
  if (url.includes("bigmodel")) return "zhipu";
  if (url.includes("dashscope")) return "qwen";
  if (url.includes("siliconflow")) return "siliconflow";
  if (url.includes("11434")) return "ollama";
  return "custom";
}

/** 估算价格：没有配置价格时按 0 计，并明确标记为 estimated。 */
export function estimateCost({ priceIn = 0, priceOut = 0, tokensIn = 0, tokensOut = 0 }) {
  const cost = (Number(tokensIn) / 1e6) * Number(priceIn || 0) + (Number(tokensOut) / 1e6) * Number(priceOut || 0);
  return Math.max(0, Number.isFinite(cost) ? cost : 0);
}

/** 内置任务类型（对应规划书 FR-702：不同任务可分别指定模型）。 */
export const TASK_TYPES = [
  { id: "chat", name: "日常聊天", hint: "最常用，建议用便宜且聪明的模型" },
  { id: "moderation", name: "审核与警告话术", hint: "只用一句话，可以用最便宜的模型" },
  { id: "summary", name: "对话归档摘要", hint: "需要较强的归纳能力" },
  { id: "reflection", name: "反思与日记", hint: "决定她「像不像活人」，别用太差的模型" },
  { id: "intent", name: "主动意图与文案", hint: "主动找你说话时的措辞" },
  { id: "qzone", name: "空间动态文案", hint: "说说、评论的文案生成" },
];

/**
 * 可选的「内置试用 Key」。
 *
 * 注意：这里**故意不写死任何真实 Key**——仓库是公开的话，硬编码的 Key 就等于公开泄露。
 * 想给自己或团队预置一个，就设环境变量 `HEARTECHO_TRIAL_KEY`（或 `DEEPSEEK_API_KEY`），
 * 其他情况留空，让用户自己在面板里粘自己的 Key。
 */
export const DEFAULT_TRIAL_KEY = String(process.env.HEARTECHO_TRIAL_KEY || "").trim();
