import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "./paths.mjs";
import { getConfig } from "./config.mjs";
import { memoryConsentValid, memoryDisclosure } from "./extended-memory.mjs";
import { digest, serviceJson } from "./service-http.mjs";

export const HINDSIGHT_IMAGE = "ghcr.io/vectorize-io/hindsight:1.1.0";
export const runtimeStatus = {
  state: "idle",
  message: "需要已安装并运行的 Docker Desktop；首次启动会下载服务镜像和本地模型。",
};
let starting = false;

function docker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true, ...options });
    let text = "";
    child.stdout.on("data", (data) => {
      text = (text + data).slice(-6000);
    });
    child.stderr.on("data", (data) => {
      text = (text + data).slice(-6000);
    });
    child.on("error", () => reject(new Error("找不到 Docker，请先安装并启动 Docker Desktop")));
    child.on("close", (code) =>
      code === 0 ? resolve(text.trim()) : reject(new Error("Docker 操作失败，请检查 Docker Desktop 与容器日志")),
    );
  });
}

export function hindsightEnvironment(cfg) {
  const address = (value) => {
    if (!value) return "";
    const url = new URL(value);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
    return url.toString().replace(/\/$/, "");
  };
  const env = {
    HINDSIGHT_API_WORKER_ID: "heartecho",
    HINDSIGHT_API_LLM_PROVIDER: "openai",
    HINDSIGHT_API_TENANT_EXTENSION: "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
    HINDSIGHT_API_TENANT_API_KEY: cfg.apiKey,
    HINDSIGHT_API_LLM_BASE_URL: address(cfg.llm.baseUrl),
    HINDSIGHT_API_LLM_API_KEY: cfg.llm.apiKey,
    HINDSIGHT_API_LLM_MODEL: cfg.llm.model,
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: cfg.embedding.provider === "local" ? "local" : "openai",
    HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: cfg.embedding.model,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: address(cfg.embedding.baseUrl),
    HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: cfg.embedding.apiKey,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: cfg.embedding.model,
    HINDSIGHT_API_RERANKER_PROVIDER: cfg.reranker.provider === "local" ? "local" : "cohere",
    HINDSIGHT_API_RERANKER_LOCAL_MODEL: cfg.reranker.model,
    HINDSIGHT_API_RERANKER_COHERE_BASE_URL: address(cfg.reranker.baseUrl),
    HINDSIGHT_API_RERANKER_COHERE_API_KEY: cfg.reranker.apiKey,
    HINDSIGHT_API_RERANKER_COHERE_MODEL: cfg.reranker.model,
  };
  for (const value of Object.values(env))
    if (/[\r\n\0]/.test(String(value))) throw new Error("服务设置不能包含换行或空字符");
  return Object.entries(env)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function startManagedHindsight() {
  if (starting) return { ok: true, pending: true };
  const cfg = getConfig().nextMemory;
  if (!cfg.enabled || !memoryConsentValid()) throw new Error("请先保存服务设置并同意当前数据传输说明");
  if (cfg.baseUrl.replace(/\/$/, "") !== "http://127.0.0.1:8888")
    throw new Error("托管启动只适用于 http://127.0.0.1:8888；其他服务地址由用户自行管理");
  if (!cfg.llm.baseUrl || !cfg.llm.model) throw new Error("Hindsight 需要单独配置支持结构化输出的归档模型");
  if (!cfg.apiKey) throw new Error("请先设置本机 Hindsight API Key，再确认授权；托管服务必须启用鉴权");
  starting = true;
  const fingerprint = memoryDisclosure().fingerprint;
  const name = `heartecho-memory-${digest(paths.data).slice(0, 12)}`;
  runtimeStatus.state = "starting";
  runtimeStatus.message = "正在检查 Docker 并启动记忆服务，首次下载可能需要较长时间。";
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    const exists = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
    if (exists === name) {
      const label = await docker(["inspect", "--format", '{{index .Config.Labels "heartecho.consent"}}', name]);
      if (label !== fingerprint) throw new Error("容器仍使用旧服务配置。请停止并移除旧容器后重试；不要删除它的数据卷");
      await docker(["start", name]);
    } else {
      const dir = path.join(paths.data, "hindsight-runtime");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "service.env");
      fs.writeFileSync(file, hindsightEnvironment(cfg), { mode: 0o600 });
      try {
        await docker([
          "run",
          "-d",
          "--name",
          name,
          "--restart",
          "unless-stopped",
          "--shm-size=1g",
          "--label",
          `heartecho.consent=${fingerprint}`,
          "--env-file",
          file,
          "-p",
          "127.0.0.1:8888:8888",
          "-v",
          `${name}:/home/hindsight/.pg0`,
          HINDSIGHT_IMAGE,
        ]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    if (!memoryConsentValid() || memoryDisclosure().fingerprint !== fingerprint)
      throw new Error("启动期间配置或授权已变化");
    for (let i = 0; i < 30; i++) {
      try {
        await serviceJson("http://127.0.0.1:8888/health", { timeoutMs: 2000 });
        runtimeStatus.state = "ready";
        runtimeStatus.message = "记忆服务已就绪";
        return { ok: true };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    runtimeStatus.state = "starting";
    runtimeStatus.message = "容器已启动，服务或本地模型仍在初始化；稍后查看状态。";
    return { ok: true, pending: true };
  } catch (error) {
    runtimeStatus.state = "unavailable";
    runtimeStatus.message = error.message;
    throw error;
  } finally {
    starting = false;
  }
}
