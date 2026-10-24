/**
 * self-surf 的离线自检：不联网、不连 QQ，只测纯函数与发送目标校验。
 *
 *   node tools/extensions-test.mjs --only self-surf
 */
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";

const EXT = "plugins/self-surf";
let loaded = null;

/** 延迟 import：先装好测试运行时（DATA_DIR 指到临时目录）再求值扩展模块。 */
async function load(t) {
  if (!loaded) {
    installTestRuntime({ dataDir: t.tempDir(), settings: { [EXT]: {} } });
    loaded = await import("./index.js");
  }
  return loaded;
}

/** 只给 settings()/日志用的最小 api 桩。 */
function apiStub(config = {}, extra = {}) {
  return { config: () => config, log() {}, warn() {}, error() {}, ...extra };
}

export const cases = [
  {
    name: "设置默认值（manifest 默认 + 内部默认合并）",
    run: async (t) => {
      const { internals } = await load(t);

      internals.__setApi(apiStub({}));
      const defaults = internals.settings();
      t.eq(defaults.enabled, true, "enabled");
      t.eq(defaults.targetChat, "", "targetChat");
      t.eq(defaults.minMinutes, 120, "minMinutes");
      t.eq(defaults.maxMinutes, 300, "maxMinutes");
      t.eq(defaults.quietHours, "0-7", "quietHours");
      t.eq(defaults.maxPages, 3, "maxPages");
      t.eq(defaults.maxChars, 6000, "maxChars");
      t.eq(defaults.maxTurns, 4, "内部默认 maxTurns（manifest 未暴露）");
      t.eq(defaults.includeSources, true, "includeSources");
      t.eq(defaults.domainBlock, "", "domainBlock");
      t.eq(defaults.dryRun, false, "dryRun");

      // 面板保存值覆盖默认值（api.config 是实时读的）
      internals.__setApi(apiStub({ minMinutes: 60, maxMinutes: 180, maxPages: 5 }));
      const merged = internals.settings();
      t.eq(merged.minMinutes, 60, "覆盖 minMinutes");
      t.eq(merged.maxMinutes, 180, "覆盖 maxMinutes");
      t.eq(merged.maxPages, 5, "覆盖 maxPages");
      t.eq(merged.quietHours, "0-7", "未覆盖的保持默认");
    },
  },
  {
    name: "静默时段 inQuietHours 与下次唤醒延迟 nextDelayMs",
    run: async (t) => {
      const { internals } = await load(t);
      const at = (hour) => new Date(2026, 0, 1, hour, 30, 0);

      t.eq(internals.inQuietHours("0-7", at(3)), true, "0-7 @3 点应在静默");
      t.eq(internals.inQuietHours("0-7", at(7)), false, "0-7 @7 点边界不算静默");
      t.eq(internals.inQuietHours("23-8", at(2)), true, "跨午夜的 23-8 @2 点应静默");
      t.eq(internals.inQuietHours("23-8", at(12)), false, "跨午夜 @12 点不静默");
      t.eq(internals.inQuietHours("", at(3)), false, "空设置 = 全天可醒");
      t.eq(internals.inQuietHours("8-8", at(3)), false, "起止相同视为不静默");

      // lo=hi 时随机数只影响“醒来时刻”，不影响基准延迟
      const noon = new Date(2026, 0, 1, 12, 0, 0);
      t.eq(
        internals.nextDelayMs({ minMinutes: 120, maxMinutes: 120, quietHours: "0-7" }, noon),
        120 * 60 * 1000,
        "非静默时段 = 固定间隔",
      );
      const dawn = new Date(2026, 0, 1, 3, 0, 0);
      const delay = internals.nextDelayMs({ minMinutes: 120, maxMinutes: 120, quietHours: "0-7" }, dawn);
      t.ok(delay >= 4 * 3600 * 1000, "落在静默时段应推到静默结束后（≥4h）");
      t.ok(delay <= 4 * 3600 * 1000 + 15 * 60 * 1000, "最多再加 15 分钟抖动");
    },
  },
  {
    name: "域名黑名单 blockedByDomain 与网页正文提取 htmlToText",
    run: async (t) => {
      const { internals } = await load(t);

      t.eq(internals.blockedByDomain("https://www.zhihu.com/question/1", "zhihu.com, weibo.com"), true, "子域名命中");
      t.eq(internals.blockedByDomain("https://weibo.com/a", "zhihu.com, weibo.com"), true, "主域名命中");
      t.eq(internals.blockedByDomain("https://notzhihu.com/a", "zhihu.com"), false, "相似域名不误伤");
      t.eq(internals.blockedByDomain("https://Example.COM/x", "example.com"), true, "大小写不敏感");
      t.eq(internals.blockedByDomain("https://example.com/x", ""), false, "空黑名单不拦");
      t.eq(internals.blockedByDomain("not a url", "example.com"), false, "非法 URL 不拦");

      const html = '<html><head><title>标题</title><style>.a{}</style></head><body>'
        + '<script>alert("x")</script><p>你好 &amp; 世界</p><ul><li>第一条</li><li>第二条</li></ul>'
        + '<div>结尾&nbsp;文字</div></body></html>';
      const text = internals.htmlToText(html);
      t.contains(text, "你好 & 世界", "解实体");
      t.contains(text, "· 第一条", "列表转成可读行");
      t.contains(text, "结尾 文字", "nbsp 归一化成空格");
      t.notContains(text, "alert", "script 内容被剥掉");
      t.notContains(text, "<", "标签被剥掉");
      t.eq(internals.htmlToText("<p>" + "a".repeat(100) + "</p>", 10), "aaaaaaaaaa…", "超长截断");
    },
  },
  {
    name: "话题 JSON 解析 parseTopicJson",
    run: async (t) => {
      const { internals } = await load(t);

      t.deepEq(
        internals.parseTopicJson('{"topic":"某个说法","query":"关键词","why":"好奇"}'),
        { topic: "某个说法", query: "关键词", why: "好奇" },
        "纯 JSON",
      );
      t.deepEq(
        internals.parseTopicJson('好的，就这样：\n```json\n{"topic":"甲","query":"乙","why":""}\n```'),
        { topic: "甲", query: "乙", why: "" },
        "带代码围栏和前后缀",
      );
      t.deepEq(
        internals.parseTopicJson('{"topic":"甲","query":"乙"}'),
        { topic: "甲", query: "乙", why: "" },
        "why 可缺省",
      );
      t.eq(internals.parseTopicJson('{"topic":"","query":"","why":""}'), null, "空话题 = 这轮不发");
      t.eq(internals.parseTopicJson('{"topic":"只有话题"}'), null, "缺 query = 不查");
      t.eq(internals.parseTopicJson("我听不懂"), null, "非 JSON = null");
      t.eq(internals.parseTopicJson(""), null, "空串 = null");
    },
  },
  {
    name: "发送目标归一化 / 严格校验（拒绝任意目标）",
    run: async (t) => {
      const { internals } = await load(t);

      t.eq(internals.normalizeTarget("group:123456"), "group:123456", "群聊");
      t.eq(internals.normalizeTarget("private：789012"), "private:789012", "全角冒号私聊");
      t.eq(internals.normalizeTarget(" 123456 "), "private:123456", "纯数字按私聊");
      t.eq(internals.normalizeTarget("group:12"), "", "群号太短不合法");
      t.eq(internals.normalizeTarget("https://evil.example/x"), "", "URL 不是目标");
      t.eq(internals.normalizeTarget(""), "", "空");

      internals.__setApi(apiStub({}));
      t.eq(internals.defaultTarget({ bot: { selfId: 10001, masterId: 10086 } }), "private:10086", "留空回退主人 QQ");
      t.eq(internals.defaultTarget({ bot: { selfId: 10001, masterId: 10001 } }), "", "主人=自己则不发");
      t.eq(internals.defaultTarget({ bot: {} }), "", "都没配就不发");

      internals.__setApi(apiStub({ targetChat: "group:123456" }));
      const calls = [];
      internals.__setApi(apiStub({ targetChat: "group:123456" }, {
        sender: { sendText: async (chatKey, text) => { calls.push({ via: "api.sender", chatKey, text }); return { messageId: "m1" }; } },
      }));
      const sent = await internals.sendTextTo("group:123456", "hello", {});
      t.eq(sent.via, "api.sender", "定时轮走宿主级 api.sender");
      t.deepEq(calls, [{ via: "api.sender", chatKey: "group:123456", text: "hello" }], "chatKey + 文本");

      // 网页/模型给的任意目标一律拒绝
      const mismatch = await t.throwsAsync(() => internals.sendTextTo("group:999999", "nope", {}));
      t.contains(String(mismatch.message), "发送目标不合法", "目标与设置不一致");
      const empty = await t.throwsAsync(() => internals.sendTextTo("", "nope", {}));
      t.contains(String(empty.message), "没有设置发送目标", "空目标");

      // 工具轮：目标恰好是当前会话时走 ctx.sender（签名不带 chatKey）
      const ctxCalls = [];
      const ctx = { chatKey: "group:123456", sender: { sendText: async (text) => { ctxCalls.push(text); } } };
      const viaCtx = await internals.sendTextTo("group:123456", "hi", { ctx });
      t.eq(viaCtx.via, "ctx.sender", "工具轮优先 ctx.sender");
      t.deepEq(ctxCalls, ["hi"], "ctx.sender 只收到文本");

      // api.sender 不可用时兜底走宿主中转的 OneBot 调用（不是 HTTP 直连）
      const botCalls = [];
      internals.__setApi(apiStub({ targetChat: "private:10086" }, {
        onebot: {
          call: async (action, params) => {
            botCalls.push({ action, params });
            return { status: "ok", retcode: 0 };
          },
        },
      }));
      const viaBot = await internals.sendTextTo("private:10086", "兜底", {});
      t.eq(viaBot.via, "api.onebot", "兜底通道");
      t.eq(botCalls[0].action, "send_private_msg", "私聊动作");
      t.eq(botCalls[0].params.user_id, 10086, "私聊对象");
    },
  },
  {
    name: "工具注册与 surf_status 行为、定时器在 deactivate 清理",
    run: async (t) => {
      const host = createMockHost({ id: "self-surf", settings: {} });
      installTestRuntime({ dataDir: host.dataDir, settings: { [EXT]: {} } });
      const mod = await load(t);
      mod.setup(host.api);
      try {
        const ids = [...host.tools.keys()].sort();
        t.deepEq(ids, ["surf_now", "surf_status"], "只注册两个工具");
        t.eq(host.tools.get("surf_now").name, "现在自己上网看点东西", "工具展示名不变");
        t.eq(host.tools.get("surf_status").name, "看自己上网的排班", "工具展示名不变");
        t.eq(mod.internals.__state().hasTimer, true, "setup 后定时器已排班");

        const result = await host.tools.get("surf_status").execute(host.ctx(), {});
        t.contains(result.content, "状态：开着", "状态行");
        t.contains(result.content, "间隔：120~300 分钟随机", "间隔行");
        t.contains(result.content, "静默时段：0-7", "静默行");
        t.eq(mod.available().ok, true, "available() 同步且可用");

        mod.deactivate();
        t.eq(mod.internals.__state().hasTimer, false, "deactivate 清掉定时器");

        // 宿主关闭扩展会清空工具表，重新启用只调 activate()：应把工具补回来
        host.tools.clear();
        mod.activate();
        t.deepEq([...host.tools.keys()].sort(), ["surf_now", "surf_status"], "重新启用后工具已补注册");
        mod.deactivate();

        // 宿主禁用→启用的正常语义：teardown 清工具，启用时重新走 setup —— 工具与定时器都要回来
        host.tools.clear();
        mod.setup(host.api);
        t.deepEq([...host.tools.keys()].sort(), ["surf_now", "surf_status"], "重新 setup 后工具仍在");
        t.eq(mod.internals.__state().hasTimer, true, "重新 setup 后定时器重新排班");
        mod.deactivate();

        // manifest 的提示词片段是宿主收集的，重装后仍在（源文件不变）
        const manifest = JSON.parse(t.fs.readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
        t.eq(manifest.prompt.sections[0].id, "self-surf-note", "提示词片段定义还在 manifest");
        t.deepEq(manifest.permissions, ["web_fetch"], "联网权限声明还在");
      } finally {
        try { mod.deactivate(); } catch { /* ignore */ }
        host.cleanup();
      }
    },
  },
  {
    name: "runCycle 前置保护：没有合法目标 / 没聊天记录时不发也不联网",
    run: async (t) => {
      const { internals } = await load(t);
      const sent = [];

      internals.__setApi(apiStub({ targetChat: "" }, {
        sender: { sendText: async (...args) => { sent.push(args); } },
      }));
      const noTarget = await internals.runCycle({});
      t.eq(noTarget.ok, false, "没有目标时不跑");
      t.contains(String(noTarget.error), "发送目标", "提示目标问题");

      internals.__setApi(apiStub({ targetChat: "group:123456" }, {
        sender: { sendText: async (...args) => { sent.push(args); } },
        store: { recent: () => [] },
      }));
      const noLines = await internals.runCycle({});
      t.eq(noLines.ok, false, "没有聊天记录时不跑");
      t.contains(String(noLines.error), "读不到内容", "提示聊天记录问题");
      t.deepEq(sent, [], "前置失败时一条都没发");
      t.eq(internals.__state().running, false, "running 闸已释放");
    },
  },
];
