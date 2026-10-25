export const NEXT_MEMORY = {
  enabled: false,
  baseUrl: "http://127.0.0.1:8888",
  apiKey: "",
  recallWords: ["回忆一下", "回想一下", "还记得", "帮我回忆"],
  characterLinks: [],
  groupLinks: [],
  consentDigest: "",
  llm: { baseUrl: "", apiKey: "", model: "" },
  embedding: { provider: "local", baseUrl: "", apiKey: "", model: "BAAI/bge-small-zh-v1.5" },
  reranker: { provider: "local", baseUrl: "", apiKey: "", model: "BAAI/bge-reranker-base" },
};

export const NEXT_INTERACTION = {
  poke: { privateEnabled: true, groupEnabled: false, mode: "fixed", text: "我在。", cooldownSec: 15 },
  adminReset: false,
  adminExempt: false,
  exemptCooldownSec: 3,
};

export const TB_OPTIONS = {
  enabled: false,
  search: { enabled: true, mode: "wiki", baseUrl: "", apiKey: "", consentDigest: "" },
  groups: {},
};
