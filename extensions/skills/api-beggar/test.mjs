/**
 * api-beggar 扩展测试（不联网）。
 *
 * mock 宿主 + 固定 JSON，覆盖：
 *   · before-llm-messages 触发语义（关键词只在【未读信息】段 / 心语最后一条 user 消息里匹配、
 *     追加在最后一条 user 消息末尾、返回值忽略、幂等、主动机会）
 *   · 余额接口自动探测顺序 / 显式字段路径 / 单位换算 / apiKey 请求头
 *   · 状态机 ok / low(演练) / low(真求) / cooling / not-configured / error
 *   · 冷却状态落盘位置 = DATA_DIR/api-beggar/state.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";

// 契约：状态文件写 DATA_DIR/api-beggar/。DATA_DIR 在扩展模块求值时就固定，
// 所以必须在 import 扩展之前装好测试运行时（这里只建目录，不联网）。
// 注意：同一进程里如果别的测试先 import 过兼容层，DATA_DIR 可能已被它定死；
// 断言统一用实际解析出来的 DATA_DIR（compatDataDir），而不是假设是本文件的目录。
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "he-ext-api-beggar-"));

/** skill.json 的 settings 默认值。 */
const MANIFEST_DEFAULTS = {
  baseOrigin: "",
  balanceUrl: "",
  balancePath: "",
  unitScale: 1,
  apiKey: "",
  threshold: 5,
  cooldownMin: 120,
  cacheSec: 300,
  dryRun: true,
  triggerKeywords: "查余额,余额,还剩多少,够不够,钱够吗,没钱了,要充值,快没钱,余额不足",
  triggerMode: "keyword+proactive"
};

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

let modPromise = null;
let compatDataDir = "";
function loadExt() {
  // 首次调用时才绑定测试运行时并 import：保证 DATA_DIR 用测试目录，
  // 也给同进程里其它扩展包的测试模块留出各自安装运行时的机会。
  if (!modPromise) {
    installTestRuntime({ dataDir: DATA_ROOT });
    modPromise = (async () => {
      const mod = await import("./index.js");
      // 扩展入口 import 之后兼容层的 DATA_DIR 已经求值（可能是别的测试先定死的），
      // 拿它的实际值做落盘位置断言。
      compatDataDir = (await import("../../src/config.js")).DATA_DIR || DATA_ROOT;
      return mod;
    })();
  }
  return modPromise;
}
/** 状态文件实际应落到的目录（契约：<DATA_DIR>/api-beggar/）。 */
function stateDir() {
  return path.join(compatDataDir || DATA_ROOT, "api-beggar");
}

/** 标准 Response 替身：fetchJson 只用到 ok / status / text()。 */
function jsonResponse(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(json);
    }
  };
}

async function makeTool(settings, fetchImpl) {
  const { setup } = await loadExt();
  const host = createMockHost({
    id: "api-beggar",
    settings: { ...MANIFEST_DEFAULTS, ...(settings ?? {}) }
  });
  if (fetchImpl) host.api.fetch = fetchImpl;
  setup(host.api);
  return { host, tool: host.tools.get("check_balance") };
}

/** 构造带【已读信息】/【未读信息】的 user prompt（用核心的分段标记）。 */
function userPrompt(unread) {
  return [
    { role: "system", content: "你是心语。" },
    { role: "user", content: `【已读信息】\n群友：之前聊过余额还剩多少的事\n【未读信息】\n${unread}` }
  ];
}

export const cases = [
  {
    name: "触发钩子：关键词只在【未读信息】段匹配，追加在最后一条 user 消息末尾且返回值忽略",
    run: async (t) => {
      const { setup, hooks } = await loadExt();
      const host = createMockHost({ id: "api-beggar", settings: { ...MANIFEST_DEFAULTS } });
      setup(host.api);
      const hook = hooks["before-llm-messages"];
      const ctxBase = { chatKey: "group:123", proactive: false };

      try {
        // 已读段有「余额」，未读段没有 → 不注入（历史误触发是烧钱根源）
        const m1 = userPrompt("群友：今天中午吃啥");
        const before1 = m1[1].content;
        t.eq(await hook({ ...ctxBase, messages: m1 }), undefined, "返回值应被忽略（undefined）");
        t.eq(m1[1].content, before1, "未读段没命中时不应改消息");

        // 未读段命中 → 追加【触发】指令，且只动最后一条 user 消息
        const m2 = userPrompt("群友：帮我查余额");
        const original = m2[1].content;
        t.eq(await hook({ ...ctxBase, messages: m2 }), undefined);
        t.ok(m2[1].content.startsWith(original), "只应做末尾追加，不改写原文");
        t.contains(m2[1].content.slice(original.length), "【触发】");
        t.contains(m2[1].content, "api-beggar__check_balance");
        t.contains(m2[1].content, "查余额");
        t.eq(m2[0].content, "你是心语。", "系统提示不能动");

        // 幂等：同一条消息不重复注入
        const once = m2[1].content;
        await hook({ ...ctxBase, messages: m2 });
        t.eq(m2[1].content, once, "同一条消息不应重复注入");

        // 没有【未读信息】标记 / 最后一条不是 user → 安全跳过，不抛错
        const m3 = [{ role: "system", content: "系统" }, { role: "user", content: "普通问题" }];
        await hook({ ...ctxBase, messages: m3 });
        t.eq(m3[1].content, "普通问题", "没有未读段标记时宁可不触发");
        const m4 = [
          { role: "system", content: "系统" },
          { role: "user", content: "【未读信息】\n余额" },
          { role: "assistant", content: "机器人" }
        ];
        await hook({ ...ctxBase, messages: m4 });
        t.eq(m4[2].content, "机器人", "最后一条不是 user 时不动");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "触发钩子（心语格式）：无【未读信息】标记时只匹配最后一条 user 消息，多模态数组也能追加",
    run: async (t) => {
      const { setup, hooks } = await loadExt();
      const host = createMockHost({ id: "api-beggar", settings: { ...MANIFEST_DEFAULTS } });
      setup(host.api);
      const hook = hooks["before-llm-messages"];

      try {
        // 心语 messages = 系统提示 + 历史 + 最后一条本轮新消息；历史里提过余额不应触发
        const history = [
          { role: "system", content: "你是心语。" },
          { role: "user", content: "群友：余额还剩多少？" },
          { role: "assistant", content: "刚查过啦。" }
        ];
        const m1 = [...history, { role: "user", content: "群友：今天中午吃啥" }];
        await hook({ messages: m1, proactive: false, chatKey: "group:1" });
        t.notContains(m1[3].content, "【触发】", "历史消息里的关键词不应触发");

        const m2 = [...history, { role: "user", content: "群友：帮我查余额" }];
        await hook({ messages: m2, proactive: false });
        t.contains(m2[3].content, "【触发】", "最后一条 user 消息命中应注入");
        t.contains(m2[3].content, "api-beggar__check_balance");

        // 带图时最后一条 user 内容是数组：文本段命中 → 末尾追加 text 段且幂等
        const m3 = [
          { role: "system", content: "你是心语。" },
          {
            role: "user",
            content: [
              { type: "text", text: "这个月余额还剩多少" },
              { type: "image_url", image_url: { url: "https://example.test/a.png" } }
            ]
          }
        ];
        await hook({ messages: m3, proactive: false });
        t.eq(m3[1].content.length, 3, "多模态消息应追加一个 text 段");
        t.eq(m3[1].content[2].type, "text");
        t.contains(m3[1].content[2].text, "【触发】");
        const len = m3[1].content.length;
        await hook({ messages: m3, proactive: false });
        t.eq(m3[1].content.length, len, "数组内容也要幂等");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "触发钩子：主动机会注入 + triggerMode=keyword 不巡查",
    run: async (t) => {
      const { setup, hooks } = await loadExt();
      const host = createMockHost({ id: "api-beggar", settings: { ...MANIFEST_DEFAULTS } });
      setup(host.api);
      const hook = hooks["before-llm-messages"];

      try {
        // 默认 keyword+proactive：主动机会轮即使没有关键词也注入一行指令
        const m1 = [{ role: "user", content: "【未读信息】\n群友：晚上好" }];
        await hook({ messages: m1, proactive: true });
        t.contains(m1[0].content, "【触发】");
        t.contains(m1[0].content, "（主动机会）");

        // triggerMode=keyword：主动机会不注入（最省）
        host.setSettings({ triggerMode: "keyword" });
        const m2 = [{ role: "user", content: "【未读信息】\n群友：晚上好" }];
        const before = m2[0].content;
        await hook({ messages: m2, proactive: true });
        t.eq(m2[0].content, before, "keyword 模式下主动机会不应注入");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "余额接口自动探测顺序 + 显式字段路径 + 单位换算 + apiKey 请求头（mock fetch）",
    run: async (t) => {
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, headers: init.headers ?? {} });
        if (pathname === "/user/balance" || pathname === "/v1/dashboard/balance") {
          return jsonResponse({}, { ok: false, status: 404 });
        }
        if (pathname === "/api/user/self") return jsonResponse({ code: 200, data: { quota: 500000 } });
        return jsonResponse({}, { ok: false, status: 404 });
      };

      const { host, tool } = await makeTool(
        {
          baseOrigin: "https://api.example.test",
          balanceUrl: "",
          unitScale: 500000,
          apiKey: "test-key",
          threshold: 5,
          cacheSec: 0,
          dryRun: true
        },
        fetchImpl
      );

      try {
        const res = await tool.execute(host.ctx(), { reason: "测试" });
        t.eq(res.isError, undefined);
        t.contains(res.content, "status: low");
        t.contains(res.content, "【演练模式】", "dryRun 默认开启时只报告、不发言");
        t.contains(res.content, "余额 1 < 阈值 5", "500000 / unitScale 500000 应换算成 1 元");
        t.deepEq(
          calls.map((c) => c.pathname),
          ["/user/balance", "/v1/dashboard/balance", "/api/user/self"],
          "应按候选顺序探测、命中即停"
        );
        t.eq(calls[0].headers.authorization, "Bearer test-key", "应带上 apiKey 的 Bearer 头");

        // 显式 balancePath（DeepSeek 风格数组下标）+ 字符串金额
        const second = await makeTool(
          {
            baseOrigin: "https://api.example.test",
            balanceUrl: "/user/balance",
            balancePath: "balance_infos.0.total_balance",
            threshold: 5,
            cacheSec: 0,
            dryRun: true
          },
          async () => jsonResponse({ balance_infos: [{ total_balance: "3.50" }] })
        );
        try {
          const res2 = await second.tool.execute(second.host.ctx(), {});
          t.contains(res2.content, "status: low");
          t.contains(res2.content, "余额 3.50 < 阈值 5");
        } finally {
          second.host.cleanup();
        }

        // 状态：冷却/上次命中的接口落盘在 DATA_DIR/api-beggar/state.json，不写扩展包目录
        const statePath = path.join(stateDir(), "state.json");
        t.ok(fs.existsSync(statePath), "状态文件应写到 DATA_DIR/api-beggar/state.json");
        const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
        t.eq(saved.goodUrl, "https://api.example.test/user/balance", "上次命中的接口应落盘");
        t.ok(
          !fs.existsSync(path.join(compatDataDir || DATA_ROOT, "skill-api-beggar-state.json")),
          "不应再写旧的 DATA_DIR 根路径"
        );
        t.ok(!fs.existsSync(path.join(PKG_DIR, "skill-api-beggar-state.json")), "不应把状态写进扩展包目录");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "状态机：ok → low(演练) → low(真求) → cooling，且冷却先落盘",
    run: async (t) => {
      let balance = 100;
      const { host, tool } = await makeTool(
        {
          baseOrigin: "https://api.example.test",
          balanceUrl: "/v1/dashboard/balance",
          threshold: 5,
          cacheSec: 0,
          cooldownMin: 120,
          dryRun: true
        },
        async () => jsonResponse({ data: { balance } })
      );

      try {
        const ctx = host.ctx();
        const okRes = await tool.execute(ctx, {});
        t.contains(okRes.content, "status: ok");
        t.contains(okRes.content, "钱够花", "ok 时应绝口不提钱");

        balance = 1;
        const dryRes = await tool.execute(ctx, {});
        t.contains(dryRes.content, "status: low");
        t.contains(dryRes.content, "【演练模式】");

        host.setSettings({ dryRun: false });
        const lowRes = await tool.execute(ctx, {});
        t.eq(lowRes.isError, undefined);
        t.contains(lowRes.content, "status: low");
        t.contains(lowRes.content, "求充值", "关掉演练才真的让模型求充值");
        t.contains(lowRes.content, "finish", "收尾应引用心语核心工具 finish");

        // 冷却内再查一次（cacheSec: 0 强制实时查）→ cooling，不重复喊
        const coolRes = await tool.execute(ctx, {});
        t.contains(coolRes.content, "status: cooling");
        t.contains(coolRes.content, "分钟内已经求过一次");

        const saved = JSON.parse(fs.readFileSync(path.join(stateDir(), "state.json"), "utf8"));
        t.ok(Number(saved.lastBegAt) > 0, "冷却时间应在返回 low 之前先落盘");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "配置/错误路径：not-configured 不联网；取不到字段与连不上返回 error",
    run: async (t) => {
      // 没填 Base URL / 余额接口 → not-configured，且绝不发请求
      let bareCalls = 0;
      const bare = await makeTool({ baseOrigin: "", balanceUrl: "" }, async () => {
        bareCalls += 1;
        return jsonResponse({ data: { balance: 1 } });
      });
      try {
        const res = await bare.tool.execute(bare.host.ctx(), {});
        t.contains(res.content, "status: not-configured");
        t.contains(res.content, "还没配置余额接口");
        t.ok(!res.isError, "not-configured 不是请求失败，不应 isError");
        t.eq(bareCalls, 0, "未配置时不应联网");
      } finally {
        bare.host.cleanup();
      }

      // 显式接口返回了数据但取不到余额字段 → error（提示检查字段路径/单位）
      const badField = await makeTool(
        { balanceUrl: "https://api.example.test/v1/dashboard/balance", cacheSec: 0 },
        async () => jsonResponse({ data: { balance: "not-a-number-here" } })
      );
      try {
        const res = await badField.tool.execute(badField.host.ctx(), {});
        t.ok(res.isError === true);
        t.contains(res.content, "余额查询失败");
        t.contains(res.content, "取不到余额字段");
      } finally {
        badField.host.cleanup();
      }

      // fetch 抛网络错误 → error，文案人话化，不把底层错误原样丢给模型
      const netErr = await makeTool(
        { baseOrigin: "https://api.example.test", balanceUrl: "/user/balance", cacheSec: 0 },
        async () => {
          throw new Error("fetch failed");
        }
      );
      try {
        const res = await netErr.tool.execute(netErr.host.ctx(), {});
        t.ok(res.isError === true);
        t.contains(res.content, "余额查询失败");
        t.contains(res.content, "连不上余额接口");
      } finally {
        netErr.host.cleanup();
      }
    }
  }
];
