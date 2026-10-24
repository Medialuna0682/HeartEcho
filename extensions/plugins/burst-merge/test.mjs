/**
 * burst-merge（连发合并）扩展测试 —— 全离线。
 *
 * 覆盖：能力名/设置默认值、只对同一个人续期（别人插话不延）、
 * 封顶/窗口/显式 0 的边界、无状态（重复调用结果一致且不改入参）。
 */
import { createMockHost } from "../../../tools/extension-harness.mjs";
import * as ext from "./index.js";

const DEFAULTS = { enabled: true, capMs: "8000" }; // = plugin.json settings

function makeHost(t, settings = DEFAULTS) {
  const host = createMockHost({ id: "burst-merge", settings: { ...settings }, dataDir: t.tempDir() });
  ext.setup(host.api);
  return host;
}

function meta(extra = {}) {
  return { senderId: "20002", startedAt: 100000, windowMs: 2000, elapsedMs: 1000, ...extra };
}

export const cases = [
  {
    name: "能力导出与默认设置：同一个人连发应续期",
    run: async (t) => {
      makeHost(t);
      t.deepEq(Object.keys(ext).sort(), ["decide", "providers", "setup"], "扩展只导出生命周期 + 能力，不落状态");
      t.eq(typeof ext.providers["wake.burst-policy"], "function", "能力名必须原样保留");
      t.eq(ext.providers["wake.burst-policy"], ext.decide, "能力直接指向 decide");

      const out = ext.decide({ entry: { senderId: "20002", text: "还有一句" }, meta: meta() });
      t.deepEq(out, { extendMs: 2000 }, "窗口 2s 且没到封顶 → 续一个窗口");

      const out2 = ext.decide({ entry: { senderId: "20002", text: "还有一句" }, meta: meta() });
      t.deepEq(out2, out, "重复调用结果一致（不保存任何状态）");
    }
  },
  {
    name: "别人插话不延 + 缺字段安全返回 null",
    run: async (t) => {
      makeHost(t);
      t.eq(ext.decide({ entry: { senderId: "20003" }, meta: meta() }), null, "别人插话不算「他没说完」");
      t.eq(ext.decide({ entry: { senderName: "没号的人" }, meta: meta() }), null, "本条消息没有 senderId 时不延");
      t.eq(ext.decide({ entry: { senderId: "20002" } }), null, "没有 meta 窗口信息时不延");
      t.eq(ext.decide({}), null, "空入参安全返回 null");
      t.eq(ext.decide(), null);
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: { ...meta(), senderId: "" } }), null, "窗口发起人未知时不延");

      // 显式传设置（第二参数）时按传入值算
      t.deepEq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 1000 }) }, { enabled: true, capMs: 4000 }), {
        extendMs: 2000
      });
      t.deepEq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 3500 }) }, { enabled: true, capMs: 4000 }), {
        extendMs: 500
      }, "剩余封顶不足一个窗口时只延剩余的");
    }
  },
  {
    name: "封顶边界：到点不再延、窗口不得越过 capMs",
    run: async (t) => {
      makeHost(t);
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 8000 }) }), null, "刚好到封顶 → 按时走");
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 9000 }) }), null, "超过封顶 → 不延");
      t.deepEq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 7500 }) }), { extendMs: 500 });
      t.deepEq(ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 7999 }) }), { extendMs: 1 });
      t.deepEq(
        ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 0, windowMs: 60000 }) }),
        { extendMs: 8000 },
        "窗口比封顶大时按封顶算"
      );
      t.deepEq(
        ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 0, windowMs: 0 }) }),
        { extendMs: 2000 },
        "windowMs=0 视为没给，兜底 2000（源码行为保持一致）"
      );
      t.deepEq(
        ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: -500, windowMs: -100 }) }),
        { extendMs: 0 },
        "负数 elapsed/window 被夹到 0，不抛错"
      );
    }
  },
  {
    name: "capMs=0（显式关闭）/ enabled=false / 非法值兜底",
    run: async (t) => {
      makeHost(t, { enabled: true, capMs: "0" });
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: meta() }), null, "capMs=\"0\"（面板关闭合并）→ 不干预");

      makeHost(t, { enabled: true, capMs: 0 });
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: meta() }), null, "capMs=0 数字也按关闭处理");

      makeHost(t, { enabled: false, capMs: "8000" });
      t.eq(ext.decide({ entry: { senderId: "20002" }, meta: meta() }), null, "总开关关掉 → 不干预");

      makeHost(t, { enabled: true, capMs: "不是数字" });
      t.deepEq(
        ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 1000 }) }),
        { extendMs: 2000 },
        "capMs 解析不出来时兜底 8000，而不是当成 0"
      );

      makeHost(t, { enabled: true, capMs: "12000" });
      t.deepEq(
        ext.decide({ entry: { senderId: "20002" }, meta: meta({ elapsedMs: 11000, windowMs: 3000 }) }),
        { extendMs: 1000 },
        "面板字符串档位生效"
      );
    }
  }
];

