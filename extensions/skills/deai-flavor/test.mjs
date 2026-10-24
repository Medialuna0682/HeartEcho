/**
 * deai-flavor 扩展测试（纯规则工具，不联网）。
 *
 * 覆盖：默认设置下的硬伤词扫描（长词优先、不重复计数）、密度分级与严格度、
 * 引号豁免 + 额外禁用词、showChecklist 开关、超长截断、空输入报错。
 */
import { createMockHost } from "../../../tools/extension-harness.mjs";
import { setup } from "./index.js";

/** skill.json 的 settings 默认值（真实宿主会把用户面板值和这些默认值合并）。 */
const MANIFEST_DEFAULTS = {
  strictness: "normal",
  extraBanned: "",
  showChecklist: true,
  maxChars: 4000
};

/** 用 mock 宿主建一个已注册工具，返回 execute 需要的 tool + ctx。 */
function makeTool(settings) {
  const host = createMockHost({ id: "deai-flavor", settings: { ...MANIFEST_DEFAULTS, ...(settings ?? {}) } });
  setup(host.api);
  const tool = host.tools.get("deai_check");
  return { host, tool };
}

async function check(text, settings) {
  const { host, tool } = makeTool(settings);
  try {
    return await tool.execute(host.ctx(), { text });
  } finally {
    host.cleanup();
  }
}

const FILLER = "今天天气不错，我们去公园里走了走。";

export const cases = [
  {
    name: "默认设置：硬伤词命中 + 长词优先（稳稳地 不会被稳稳 重复计数）",
    run: async (t) => {
      const { host, tool } = makeTool({});
      try {
        t.eq(tool?.id, "deai_check", "工具 id 应保持 deai_check");
        const res = await tool.execute(host.ctx(), { text: "他稳稳地走过来，瞬间就懂了。" });
        t.ok(res && !res.isError, "正常文本不应返回 isError");
        t.contains(res.content, "程度：中", "两处硬伤应判中度");
        t.contains(res.content, "硬伤 2 处");
        t.contains(res.content, "「稳稳地」×1", "长词「稳稳地」应命中一次");
        t.notContains(res.content, "「稳稳」×", "「稳稳」不应被算成另一条命中");
        t.contains(res.content, "「瞬间」×1");
        // 默认 showChecklist: true → L2/L4 自检提示在
        t.contains(res.content, "L2 风格一致性");
        t.contains(res.content, "L4 活人感终审");
        t.contains(res.content, "三步改写");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "密度分级：轻/中/重 + loose/strict 严格度",
    run: async (t) => {
      // 无硬伤无软信号 → 轻
      t.contains((await check("今天中午吃了碗面，挺好吃的。")).content, "程度：轻");
      // 3 处硬伤 → 重
      t.contains((await check("综上所述，赋能闭环，值得注意。")).content, "程度：重");
      t.contains((await check("综上所述，赋能闭环，值得注意。")).content, "硬伤 3 处");
      // 短文本密度闸门不生效：同样的软信号在短句中仍判轻
      t.contains((await check("此外，因此。")).content, "程度：轻");
      // strict：轻 + 2 个软信号 → 中
      t.contains((await check("此外，因此，今天天气不错。", { strictness: "strict" })).content, "程度：中");
      // 长文本密度（2 硬伤 + 2 软信号 / 111 字 → density>=6）判重；loose 降回中
      const dense = `赋能闭环。此外因此${FILLER.repeat(6)}`;
      t.contains((await check(dense)).content, "程度：重", "密度 >= 6 应判重");
      t.contains((await check(dense, { strictness: "loose" })).content, "程度：中", "loose 下应降一级");
      t.contains((await check(dense, { strictness: "strict" })).content, "程度：重");
    }
  },
  {
    name: "引号豁免 + 额外禁用词 + 关闭自检清单 + 超长截断",
    run: async (t) => {
      const res = await check("「赋能」这个词别用，家人们。", { extraBanned: "家人们", showChecklist: false });
      t.ok(!res.isError);
      t.contains(res.content, "「家人们」×1", "额外禁用词应命中");
      t.notContains(res.content, "「赋能」×", "引号里是在讨论这个词，不算硬伤");
      t.contains(res.content, "另有 1 处在引号里");
      t.contains(res.content, "程度：中", "额外禁用词按硬伤处理");
      t.notContains(res.content, "L2 风格一致性", "showChecklist:false 不应附带 L2");
      t.notContains(res.content, "L4 活人感终审");
      // maxChars 是最小 200 的下限保护；300 生效，只检查前 300 字
      const long = await check("好".repeat(400), { maxChars: 300 });
      t.contains(long.content, "共 300 字");
      t.contains(long.content, "备注：原文超长，只检查了前一段。");
    }
  },
  {
    name: "空输入返回明确错误（isError）",
    run: async (t) => {
      for (const text of ["", "   ", undefined]) {
        const res = await check(text);
        t.ok(res.isError === true, `空输入 ${String(text)} 应返回 isError`);
        t.contains(res.content, "没有拿到文本");
      }
    }
  }
];
