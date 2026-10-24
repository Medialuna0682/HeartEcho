/**
 * context-chime（上下文插话判定）扩展测试 —— 全离线。
 *
 * 覆盖：parseJudge 宽容解析、规则跳过（关闭/私聊/过短/纯媒体/白名单）、
 * 冷却与去重、每日上限、判定成功路径（mock 兼容层 chatCompletion 并核对入参映射）、
 * chimelog 工具、judgeProvider → 心语 llm.profiles 渠道解析。
 */
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";
import { bindExtensionServices } from "../../../lib/extensions-runtime.mjs";
import * as ext from "./index.js";

const BASE_ARGS = {
  kind: "group",
  text: "这句话够长了吧",
  entry: { senderId: "20002", senderName: "群友", isPoke: false },
  recent: [
    { senderId: "20002", senderName: "群友", text: "刚才那句话", at: 1, self: false },
    { senderId: "10001", senderName: "小语", text: "我在呢", at: 2, self: true }
  ],
  botName: "小语",
  selfNickname: "小语",
  personaBrief: "爱聊天的群友",
  api: { model: "mock-model", baseUrl: "https://example.test" }
};

function resetState() {
  const state = ext.__internals.state;
  state.lastJudgeAt.clear();
  state.lastText.clear();
  state.daily.clear();
  state.history.length = 0;
  state.totals.calls = 0;
  state.totals.promptTokens = 0;
  state.totals.completionTokens = 0;
  state.totals.skipped = 0;
}

function makeHost(t, settings = {}) {
  const host = createMockHost({ id: "context-chime", settings, dataDir: t.tempDir() });
  ext.setup(host.api);
  return host;
}

/** 直接绑兼容层服务，用于 mock chatCompletion 或 getConfig。 */
function bindMockChat({ chatCompletion, getConfig = () => ({}), dataDir = "" } = {}) {
  bindExtensionServices({
    dataDir,
    settingsFor: () => ({}),
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    getConfig,
    updateConfig: () => ({}),
    chatCompletion,
    resolveModelPrice: () => ({ in: 0, out: 0, cached: 0 }),
    getToolAvailability: () => ({ ok: true }),
    stickerPathByUrl: () => null,
    stickers: { find: () => null, list: () => [] }
  });
}

function judge(args) {
  return ext.providers["reply.interest-judge"](args);
}

export const cases = [
  {
    name: "parseJudge：宽容解析模型输出",
    run: async (t) => {
      t.deepEq(ext.parseJudge('{"reply":1,"confidence":80,"why":"在问它"}'), {
        respond: true,
        confidence: 80,
        why: "在问它"
      });
      t.deepEq(ext.parseJudge('```json\n{"reply":0,"confidence":120,"why":"私事"}\n```'), {
        respond: false,
        confidence: 100,
        why: "私事"
      }, "代码块包裹 + confidence 上钳");
      t.deepEq(ext.parseJudge('好的：{"respond":"yes","reason":"接龙呢","confidence":-5}'), {
        respond: true,
        confidence: 0,
        why: "接龙呢"
      }, "respond/字符串真值/reason 别名 + confidence 下钳");
      t.deepEq(ext.parseJudge('{"reply":true,"confidence":50}'), { respond: true, confidence: 50, why: "" });
      t.ok(ext.parseJudge("我不会") === null, "非 JSON 返回 null");
      t.ok(ext.parseJudge("") === null, "空串返回 null");
      t.ok(ext.parseJudge('{"confidence":50}') === null, "缺 reply 返回 null");
      t.ok(ext.parseJudge("{坏掉的 json}") === null, "坏 JSON 返回 null");
    }
  },
  {
    name: "规则跳过：关闭/私聊/过短/纯媒体/拍一拍/白黑名单",
    run: async (t) => {
      installTestRuntime({ dataDir: t.tempDir() });
      resetState();

      makeHost(t, { enabled: false });
      let out = await judge({ ...BASE_ARGS, chatKey: "group:91001", chatId: "91001" });
      t.eq(out.respond, false);
      t.eq(out.skipped, "已关闭", "enabled=false 应直接不判");

      makeHost(t);
      out = await judge({ ...BASE_ARGS, chatKey: "group:91002", chatId: "91002", kind: "private", text: "私聊消息" });
      t.eq(out.skipped, "私聊不判", "默认不判私聊");

      out = await judge({ ...BASE_ARGS, chatKey: "group:91003", chatId: "91003", text: "嗯嗯" });
      t.eq(out.skipped, "消息过短", "默认 minChars=4");

      out = await judge({ ...BASE_ARGS, chatKey: "group:91004", chatId: "91004", text: "[图片]" });
      t.eq(out.skipped, "纯媒体", "纯媒体消息不判");

      out = await judge({ ...BASE_ARGS, chatKey: "group:91005", chatId: "91005", text: "[拍一拍] 小语" });
      t.eq(out.skipped, "拍一拍", "拍一拍不判");

      out = await judge({ ...BASE_ARGS, chatKey: "group:91006", chatId: "91006", text: "" });
      t.eq(out.skipped, "无内容");

      makeHost(t, { denyGroups: "91007,91008" });
      out = await judge({ ...BASE_ARGS, chatKey: "group:91007", chatId: "91007" });
      t.eq(out.skipped, "在黑名单群");

      makeHost(t, { onlyGroups: "91009" });
      out = await judge({ ...BASE_ARGS, chatKey: "group:91010", chatId: "91010" });
      t.eq(out.skipped, "不在白名单群");
      out = await judge({ ...BASE_ARGS, chatKey: "group:91009", chatId: "91009" });
      t.eq(out.skipped, "判定失败", "白名单内的群应继续走到模型调用（mock 宿主拒绝调用）");

      // 设置每次现读（cfg() 不快照）
      makeHost(t, { minChars: 100 });
      out = await judge({ ...BASE_ARGS, chatKey: "group:91011", chatId: "91011" });
      t.eq(out.skipped, "消息过短", "改设置应立即生效");
    }
  },
  {
    name: "冷却/重复内容/每日上限",
    run: async (t) => {
      installTestRuntime({ dataDir: t.tempDir() });
      resetState();
      makeHost(t);

      const key = "group:92001";
      const first = await judge({ ...BASE_ARGS, chatKey: key, chatId: "92001" });
      t.eq(first.respond, false);
      t.eq(first.skipped, "判定失败", "mock 宿主不联网，应按保守侧返回不接");
      t.ok((ext.__internals.state.lastJudgeAt.get(key) || 0) > 0, "请求发出前就应占住冷却位（连发不重复判）");

      let out = await judge({ ...BASE_ARGS, chatKey: key, chatId: "92001", text: "换一句新的话" });
      t.eq(out.skipped, "冷却中", "同群冷却期内不再判定");

      ext.__internals.state.lastJudgeAt.delete(key);
      out = await judge({ ...BASE_ARGS, chatKey: key, chatId: "92001" });
      t.eq(out.skipped, "重复内容", "同一句话不重复判定");

      // 另一个群不受影响
      out = await judge({ ...BASE_ARGS, chatKey: "group:92002", chatId: "92002" });
      t.eq(out.skipped, "判定失败");

      // 每日上限：cooldownSec=0 时第一次判定成功占掉名额，第二次应被上限挡住
      installTestRuntime({ dataDir: t.tempDir() });
      resetState();
      makeHost(t, { cooldownSec: 0, dailyCallLimit: 1 });
      const limKey = "group:92003";
      const limFirst = await judge({ ...BASE_ARGS, chatKey: limKey, chatId: "92003" });
      t.eq(limFirst.skipped, "判定失败");
      const limSecond = await judge({ ...BASE_ARGS, chatKey: limKey, chatId: "92003", text: "又是新的一句话" });
      t.eq(limSecond.skipped, "已达当日上限");

      // 冷却设置可调：cooldownSec=0 时同文本不同内容不被冷却挡（但会被重复内容挡）
      t.eq(ext.__internals.settings().cooldownSec, 0, "设置现读，不缓存 setup 时的值");
    }
  },
  {
    name: "判定成功路径：兼容层入参映射、usage 累计、chimelog",
    run: async (t) => {
      resetState();
      const host = makeHost(t);
      let captured = null;
      bindMockChat({
        dataDir: t.tempDir(),
        chatCompletion: async (options) => {
          captured = options;
          return {
            message: { content: '```json\n{"reply":1,"confidence":82,"why":"在问它"}\n```' },
            usage: { prompt_tokens: 123, completion_tokens: 9 },
            finishReason: "stop"
          };
        }
      });

      const out = await judge({ ...BASE_ARGS, chatKey: "group:93001", chatId: "93001", text: "小语你觉得这个咋样" });
      t.eq(out.respond, true);
      t.eq(out.confidence, 82);
      t.eq(out.why, "在问它");

      t.ok(captured, "应通过兼容层 chatCompletion 发判定请求");
      t.eq(captured.model, "mock-model", "主模型透传");
      t.eq(captured.baseUrl, "https://example.test", "主渠道透传");
      t.eq(captured.temperature, 0, "判定请求 temperature=0");
      t.eq(captured.maxTokens, 64, "默认 maxTokens=64");
      t.eq(captured.timeoutMs, 6000, "超时走兼容层 timeoutMs");
      t.eq(captured.reasoningOff, true, "判定请求显式关闭思考");
      t.eq(captured.messages.length, 2);
      t.contains(captured.messages[0].content, "该不该主动接话");
      t.contains(captured.messages[1].content, "【最新一条，要判定的是这条】群友：小语你觉得这个咋样");

      t.eq(ext.__internals.state.totals.calls, 1);
      t.eq(ext.__internals.state.totals.promptTokens, 123);
      t.eq(ext.__internals.state.totals.completionTokens, 9);

      // chimelog 工具能查到这条真实判定
      const tool = host.tools.get("chimelog");
      t.ok(tool, "setup 应注册 chimelog 工具");
      t.eq(tool.name, "查看插话判定记录");
      const logOut = await tool.execute(host.ctx({ chatKey: "group:93001" }), { count: 5 });
      t.contains(logOut.content, "插话判定统计");
      t.contains(logOut.content, "✅ 接了");
      t.contains(logOut.content, "在问它");
      t.contains(logOut.content, "123+9", "token 统计应展示");

      // confidenceThreshold：模型说接但自信度不够 → 不接（行为沿用源码）
      const host2 = makeHost(t, { confidenceThreshold: 90 });
      const low = await judge({ ...BASE_ARGS, chatKey: "group:93002", chatId: "93002" });
      t.eq(low.respond, false, "confidence 82 < 门槛 90 应判不接");
      t.eq(low.confidence, 82);
      const logOut2 = await host2.tools.get("chimelog").execute(host2.ctx(), { count: 5 });
      t.contains(logOut2.content, "⏭️ 跳过（自信度不足）");
    }
  },
  {
    name: "判定超时：本地兜底，不等宿主默认 90s",
    run: async (t) => {
      resetState();
      makeHost(t, { timeoutMs: 1000 });
      bindMockChat({
        dataDir: t.tempDir(),
        // 模拟宿主既不透传 signal 也不理 timeoutMs：请求一直挂着
        chatCompletion: () => new Promise(() => {})
      });
      // 扩展里的超时定时器是 unref 的（不拖住进程），测试里自己留一个 ref 句柄
      const keepAlive = setInterval(() => {}, 100);
      try {
        const started = Date.now();
        const out = await judge({ ...BASE_ARGS, chatKey: "group:94001", chatId: "94001" });
        const cost = Date.now() - started;
        t.eq(out.respond, false);
        t.eq(out.skipped, "判定失败", "超时按保守侧「不接」处理");
        t.ok(cost >= 900 && cost < 5000, `应在约 1s（设置值）超时返回，实际 ${cost}ms`);
        const last = ext.__internals.state.history.at(-1);
        t.contains(String(last?.skipped ?? ""), "判定超时", "历史记录应写清超时原因");
      } finally {
        clearInterval(keepAlive);
      }
    }
  },
  {
    name: "judgeProvider：兼容心语 llm.profiles 渠道配置",
    run: async (t) => {
      const config = {
        llm: {
          activeProfile: "default",
          profiles: {
            default: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-main", model: "deepseek-flash" },
            judge: { provider: "moonshot", baseUrl: "https://api.moonshot.cn/v1", apiKey: "sk-judge", model: "kimi-k2.6" }
          }
        }
      };
      bindMockChat({ dataDir: t.tempDir(), getConfig: () => config, chatCompletion: async () => ({}) });

      const base = { model: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1" };
      let api = ext.resolveJudgeApi({ judgeModel: "kimi-k2.6", judgeProvider: "judge" }, base);
      t.eq(api.model, "kimi-k2.6");
      t.eq(api.baseUrl, "https://api.moonshot.cn/v1", "按 profile id 找到判定渠道");
      t.eq(api.apiKey, "sk-judge");
      t.eq(api.provider, "moonshot");

      api = ext.resolveJudgeApi({ judgeModel: "kimi-k2.6", judgeProvider: "moonshot" }, base);
      t.eq(api.baseUrl, "https://api.moonshot.cn/v1", "也支持用 provider id 找渠道");
      t.eq(api.apiKey, "sk-judge");

      api = ext.resolveJudgeApi({ judgeModel: "some-model", judgeProvider: "不存在的渠道" }, base);
      t.eq(api.baseUrl, "https://api.deepseek.com/v1", "找不到渠道时回退主渠道");
      t.eq(api.model, "some-model");

      api = ext.resolveJudgeApi({ judgeModel: "" }, base);
      t.deepEq(api, base, "没配 judgeModel 时原样用主渠道");

      // 宿主能力入参不带 api 时（chat.mjs 当前接线），从 getConfig().llm.activeProfile 取主模型
      api = ext.resolveJudgeApi({ judgeModel: "" }, undefined);
      t.eq(api.model, "deepseek-flash", "缺少 api 入参时回退主配置的聊天主模型");
      t.eq(api.baseUrl, "https://api.deepseek.com/v1");
      t.eq(api.apiKey, "sk-main");

      // 没有任何主模型配置时仍应安全返回 null（判定退回不接）
      bindMockChat({ dataDir: t.tempDir(), getConfig: () => ({ llm: { profiles: {} } }), chatCompletion: async () => ({}) });
      t.eq(ext.resolveJudgeApi({ judgeModel: "" }, undefined), null);

      // 完整链路：能力入参无 api → 主配置模型 → 兼容层 chatCompletion
      resetState();
      makeHost(t);
      const config2 = JSON.parse(JSON.stringify(config));
      let captured = null;
      bindMockChat({
        dataDir: t.tempDir(),
        getConfig: () => config2,
        chatCompletion: async (options) => {
          captured = options;
          return {
            message: { content: '{"reply":1,"confidence":66,"why":"该接"}' },
            usage: { prompt_tokens: 5, completion_tokens: 3 },
            finishReason: "stop"
          };
        }
      });
      const { api: _unusedApi, ...argsNoApi } = BASE_ARGS;
      const verdict = await judge({ ...argsNoApi, chatKey: "group:95001", chatId: "95001" });
      t.eq(verdict.respond, true, "宿主不传 api 时也应能判定（用主配置模型）");
      t.eq(verdict.confidence, 66);
      t.eq(captured.model, "deepseek-flash", "查到的模型名应透传给兼容层");
      t.eq(captured.baseUrl, "https://api.deepseek.com/v1");
      t.eq(captured.apiKey, "sk-main");
    }
  }
];


