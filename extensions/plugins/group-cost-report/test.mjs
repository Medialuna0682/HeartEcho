// group-cost-report 离线自检（不联网、不启动心语、不读真实数据目录）。
// 运行：node tools/extensions-test.mjs --only group-cost-report
//
// 覆盖：
//   1. 设置默认值 + 区间解析/日期边界（parseRange）
//   2. 计价与报告汇总（costOfSession / buildReport，用构造的会话文件）
//   3. 触发识别（detect：@/免@/主动轮/私聊/工具关闭）
//   4. 钩子链路（before-context → before-llm-messages → before-tool → 工具发送 → after-response）
//      + 能力 llm.request-params
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockHost } from '../../../tools/extension-harness.mjs';
import { bindExtensionServices } from '../../../lib/extensions-runtime.mjs';

const DAY = 86400000;
// 固定"现在"：2026-10-24（周六）15:30，避免测试跟着真实日期漂
const FIXED_NOW = new Date(2026, 9, 24, 15, 30, 0).getTime();

// DATA_DIR 是扩展模块顶层求值时就固定下来的，所以必须在 import('./index.js') 之前就绪
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'he-ext-group-cost-report-'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function startOf(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
const TODAY = startOf(FIXED_NOW);

/** 装一个最小 compat 运行时（bindExtensionServices），让 ../../src/* 能用。 */
function installRuntime({ config = {}, availability = { ok: true }, price = { in: 0, out: 0, cached: 0 } } = {}) {
  bindExtensionServices({
    dataDir: DATA_DIR,
    settingsFor: () => ({}),
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    getConfig: () => config,
    updateConfig: () => ({}),
    async chatCompletion() { throw new Error('测试不调用模型'); },
    resolveModelPrice: () => price,
    getToolAvailability: () => availability,
    stickerPathByUrl: () => null,
    stickers: { find: () => null, list: () => [] }
  });
}

let modPromise = null;
async function loadExtension(options = {}) {
  installRuntime(options);
  if (!modPromise) modPromise = import('./index.js');
  return modPromise;
}

let seq = 0;
/** 按宿主契约 §6 的形状写一个会话记录文件。 */
function writeSession(rec) {
  const startedAt = Number(rec.startedAt) || FIXED_NOW;
  const id = rec.id || `${startedAt.toString(36)}-${String(++seq).padStart(4, '0')}abcd`;
  const payload = { ...rec, id, startedAt };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(payload), 'utf8');
  return id;
}

export const cases = [
  {
    name: '设置默认值与区间解析（日期边界）',
    async run(t) {
      const mod = await loadExtension({ config: {} });
      const I = mod.internals;
      t.eq(I.SESSIONS_DIR, SESSIONS_DIR, '会话记录必须读 DATA_DIR/sessions');
      t.eq(I.asChatKey('group_900001_111'), 'group:900001', 'scopeKey 形状要能翻译回 group:<群号>');
      t.eq(I.asChatKey('group:5'), 'group:5');

      // 设置默认值 / 越界收敛
      const s = I.normalizeSettings({});
      t.deepEq(s.triggerWords, ['金额统计', '花费统计', '花费查询', 'token统计', '用量统计', '消费统计']);
      t.eq(s.allowWithoutAt, false);
      t.eq(s.defaultRange, 'today');
      t.eq(s.topN, 8);
      t.eq(s.maxSessions, 400);
      t.eq(s.footer, true);
      const s2 = I.normalizeSettings({ triggerWords: '统计, 花费 、查token', topN: 999, maxSessions: 5, footer: false });
      t.deepEq(s2.triggerWords, ['统计', '花费', '查token']);
      t.eq(s2.topN, 50, 'topN 上限 50');
      t.eq(s2.maxSessions, 20, 'maxSessions 下限 20');
      t.eq(s2.footer, false);

      // 今天：00:00:00.000 ~ 23:59:59.999
      const today = I.parseRange('金额统计', 'today', FIXED_NOW);
      t.eq(today.key, 'today');
      t.eq(today.from, TODAY);
      t.eq(today.to, TODAY + DAY - 1);
      t.contains(today.label, '10-24');
      t.contains(today.label, '当天');

      // 昨天：区间两端都落在昨天
      const yesterday = I.parseRange('金额统计 昨天', 'today', FIXED_NOW);
      t.eq(yesterday.key, 'yesterday');
      t.eq(yesterday.from, TODAY - DAY);
      t.eq(yesterday.to, TODAY - 1);
      t.eq(yesterday.to - yesterday.from, DAY - 1);
      t.contains(yesterday.label, '10-23');

      // 本周：周一开始，到"今天"结束（2026-10-24 是周六）
      const thisweek = I.parseRange('金额统计 本周', 'today', FIXED_NOW);
      t.eq(thisweek.key, 'thisweek');
      t.eq(thisweek.from, TODAY - 5 * DAY);
      t.eq(new Date(thisweek.from).getDay(), 1, '本周左边界必须是周一');
      t.eq(thisweek.to, TODAY + DAY - 1);
      t.eq(thisweek.label, '10-19 ~ 10-24');

      // 最近 N 天：含今天在内共 N 天
      const last7 = I.parseRange('最近7天', 'today', FIXED_NOW);
      t.eq(last7.key, '7d');
      t.eq(last7.from, TODAY - 6 * DAY);
      t.eq(last7.to, TODAY + DAY - 1);

      // 显式日期：中文月日、ISO、单日
      const custom = I.parseRange('9月1日到9月30日', 'today', FIXED_NOW);
      t.eq(custom.key, 'custom');
      t.eq(new Date(custom.from).getMonth(), 8);
      t.eq(new Date(custom.from).getDate(), 1);
      t.eq(new Date(custom.from).getHours(), 0);
      t.eq(new Date(custom.to).getDate(), 30);
      t.eq(new Date(custom.to).getHours(), 23);
      t.eq(custom.label, '09-01 ~ 09-30');
      const iso = I.parseRange('2026-10-01 到 2026-10-03', 'today', FIXED_NOW);
      t.eq(iso.key, 'custom');
      t.eq(new Date(iso.from).getDate(), 1);
      t.eq(new Date(iso.to).getDate(), 3);
      const oneDay = I.parseRange('10月5日', 'today', FIXED_NOW);
      t.eq(oneDay.key, 'custom');
      t.eq(oneDay.from, new Date(2026, 9, 5).getTime());
      t.eq(oneDay.to, oneDay.from + DAY - 1);
      t.contains(oneDay.label, '当天');

      // 没写区间 → 用设置里的默认值
      const fromDefault = I.parseRange('金额统计', 'lastweek', FIXED_NOW);
      t.eq(fromDefault.key, 'lastweek');
      t.eq(fromDefault.from, TODAY - 12 * DAY);
      t.eq(fromDefault.to, TODAY - 6 * DAY + DAY - 1, '上周区间右端是上周日 23:59:59.999');

      // "全部历史"左边界必须是 0（不能退化成今天）
      const all = I.parseRange('金额统计 全部', 'today', FIXED_NOW);
      t.eq(all.key, 'all');
      t.eq(all.from, 0);
      t.eq(all.label, '全部历史');

      // 会话 id 时间解码（宿主 id 若是 uuid 形态则返回 0，走文件头读 startedAt）
      t.eq(I.decodeIdTime(`${TODAY.toString(36)}-abcd`), TODAY);
      t.eq(I.decodeIdTime('turn-uuid-0001'), 0);
    }
  },

  {
    name: '花费计算与报告汇总（构造会话文件）',
    async run(t) {
      const prices = { in: 2, out: 8, cached: 1 };   // 元 / 百万 token
      const mod = await loadExtension({ price: prices, config: {} });
      const I = mod.internals;

      // 1) 计价：fresh*in + cached*cached + completion*out
      const cost = I.costOfSession({
        model: 'test-model',
        vendor: '',
        startedAt: FIXED_NOW,
        usage: { promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 200_000 }
      });
      t.ok(Math.abs(cost - 5.8) < 1e-9, `花费应为 5.8 元，实际 ${cost}`);

      // 缓存命中数不能超过 prompt（脏数据不能把花费算翻）
      const capped = I.costOfSession({
        model: 'test-model',
        startedAt: FIXED_NOW,
        usage: { promptTokens: 1000, completionTokens: 0, cachedTokens: 5000 }
      });
      t.ok(Math.abs(capped - 0.001) < 1e-12, `缓存应按 prompt 封顶，实际 ${capped}`);

      // 价格表解析不到 → 回落到宿主会话记录里的 cost
      installRuntime({ price: { in: 0, out: 0, cached: 0 }, config: {} });
      const fallback = I.costOfSession({ model: '未知模型', startedAt: FIXED_NOW, cost: 0.42, usage: { promptTokens: 100000 } });
      t.eq(fallback, 0.42, '价格未知时应使用宿主记录的 cost');
      installRuntime({ price: prices, config: {} });

      // 2) 构造会话文件：同群 4 条有效 + 1 条零消耗 + 别的群 + 昨天
      const chatKey = 'group:900001';
      writeSession({
        chatKey, startedAt: FIXED_NOW - 3_600_000, model: 'test-model', vendor: '',
        usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 100, totalTokens: 1200, calls: 1 },
        cost: 0.99,
        trigger: [{ senderId: '111', senderName: '阿甲', text: '@小语 金额统计', atMe: true }]
      });
      writeSession({
        chatKey, startedAt: FIXED_NOW - 7_200_000, model: 'test-model', vendor: '',
        usage: { promptTokens: 2000, completionTokens: 400, cachedTokens: 0, totalTokens: 2400, calls: 2 },
        trigger: [
          { senderId: '222', senderName: '阿乙', text: '先聊两句', atMe: false },
          { senderId: '111', senderName: '阿甲', text: '金额统计', atMe: true }
        ]
      });
      writeSession({   // 零消耗会话（没真正调模型）不计
        chatKey, startedAt: FIXED_NOW - 1_800_000, model: 'test-model',
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 },
        trigger: []
      });
      writeSession({   // 没 @ 的记录：归给触发批最早一条（阿丙）
        chatKey, startedAt: FIXED_NOW - 10_800_000, model: 'test-model',
        usage: { promptTokens: 500, completionTokens: 0, cachedTokens: 0, totalTokens: 500, calls: 1 },
        trigger: [{ senderId: '333', senderName: '阿丙', text: '统计下吧', atMe: false }]
      });
      writeSession({
        chatKey, startedAt: FIXED_NOW - 9_000_000, model: 'test-model',
        usage: { promptTokens: 300, completionTokens: 0, cachedTokens: 0, totalTokens: 300, calls: 1 },
        trigger: [{ senderId: '444', senderName: '阿丁', text: '统计下吧', atMe: false }]
      });
      writeSession({   // 别的群：不能算进来
        chatKey: 'group:900002', startedAt: FIXED_NOW - 60_000, model: 'test-model',
        usage: { promptTokens: 9999, completionTokens: 0, totalTokens: 9999, calls: 1 },
        trigger: [{ senderId: '555', senderName: '别的群', text: '金额统计', atMe: true }]
      });
      writeSession({   // 昨天：不能算进今天
        chatKey, startedAt: FIXED_NOW - DAY, model: 'test-model',
        usage: { promptTokens: 777, completionTokens: 0, totalTokens: 777, calls: 1 },
        trigger: [{ senderId: '666', senderName: '昨天的', text: '金额统计', atMe: true }]
      });

      const settings = I.normalizeSettings({ topN: 2, footer: true });
      const report = await I.buildReport({
        chatKey,
        range: I.parseRange('今天', 'today', FIXED_NOW),
        cfg: { settings, raw: {} }
      });
      t.eq(report.sessionCount, 4, '零消耗/别的群/昨天都不计入');
      t.eq(report.memberCount, 3, '归属到 3 个群友');
      t.eq(report.totals.totalTokens, 4400);
      t.eq(report.totals.promptTokens, 3800);
      t.eq(report.totals.completionTokens, 600);
      t.eq(report.totals.cachedTokens, 100);
      t.ok(Math.abs(report.totals.cost - 0.0123) < 1e-9, `合计花费应为 0.0123，实际 ${report.totals.cost}`);
      t.contains(report.text, '💰 本群花费统计（10-24（当天））');
      t.contains(report.text, '合计：4,400 token');
      t.contains(report.text, '4 次运行');
      t.contains(report.text, '进/出 token：3,800 / 600（其中缓存命中 100）');
      t.contains(report.text, '阿甲(QQ:111)');
      t.contains(report.text, '3,600 token');
      t.contains(report.text, '其余 1 人：300 token');
      t.contains(report.text, '（口径：每次运行的花费归给触发它的人；金额与「用量」页同源）');

      // 私聊不统计
      const privateReport = await I.buildReport({
        chatKey: 'private:900001',
        range: I.parseRange('今天', 'today', FIXED_NOW),
        cfg: { settings, raw: {} }
      });
      t.contains(privateReport.text, '只在群聊里有意义');

      // 空区间：给可读结果而不是报错
      const empty = await I.buildReport({
        chatKey: 'group:900003',
        range: I.parseRange('今天', 'today', FIXED_NOW),
        cfg: { settings, raw: {} }
      });
      t.eq(empty.sessionCount, 0);
      t.contains(empty.text, '还没有任何 token 消耗记录');
    }
  },

  {
    name: '触发识别 detect（@ / 免@ / 主动轮 / 私聊 / 工具关闭）',
    async run(t) {
      const config = { persona: { selfNickname: '小语', botName: '心语' } };
      const host = createMockHost({
        id: 'group-cost-report',
        settings: { triggerWords: '金额统计,花费统计', allowWithoutAt: false, defaultRange: 'yesterday', topN: 8 }
      });
      const mod = await loadExtension({ config, availability: { ok: true } });
      await mod.setup(host.api);
      const I = mod.internals;

      const makeCtx = (entries, extra = {}) => host.ctx({ triggerEntries: entries, ...extra });
      const atCtx = makeCtx([{ senderId: '20001', senderName: '阿甲', text: '@小语 帮我金额统计 昨天', atMe: true, isSelf: false }]);
      const hit = I.detect(atCtx);
      t.ok(hit, '应识别出统计请求');
      t.eq(hit.chatKey, 'group:123456');
      t.eq(hit.chatId, '123456');
      t.eq(hit.requester.name, '阿甲');
      t.eq(hit.range.key, 'yesterday', '消息里写明的区间优先于默认区间');
      t.eq(hit.sessionId, 'mock-session-1');
      t.eq(hit.sent, false);

      // 没 @（allowWithoutAt=false）→ 不接管
      t.eq(I.detect(makeCtx([{ senderId: '20001', senderName: '阿甲', text: '金额统计 今天', atMe: false }])), null);
      // 老存档没有 atMe，但文本里 @ 了机器人名 → 仍识别
      const legacy = I.detect(makeCtx([{ senderId: '20002', senderName: '阿乙', text: '@心语 花费统计 本周', isSelf: false }]));
      t.ok(legacy, '没有 atMe 时回落到 @昵称 匹配');
      t.eq(legacy.range.key, 'thisweek');
      // 多条触发消息：取命中触发词的那条作请求人
      const two = I.detect(makeCtx([
        { senderId: '20003', senderName: '阿丙', text: '随便聊聊', atMe: false },
        { senderId: '20004', senderName: '阿丁', text: '金额统计', atMe: true }
      ]));
      t.eq(two && two.requester.id, '20004');
      // 主动轮 / 私聊 / 缺 sessionId / 机器人自己 → 不接管
      t.eq(I.detect(makeCtx([{ senderId: '1', senderName: 'a', text: '金额统计', atMe: true }], { proactive: true })), null);
      t.eq(I.detect(host.ctx({
        kind: 'private',
        chatKey: 'private:1',
        chatId: '1',
        triggerEntries: [{ senderId: '1', senderName: 'a', text: '金额统计', atMe: true }]
      })), null);
      t.eq(I.detect(makeCtx([{ senderId: '1', senderName: 'a', text: '金额统计', atMe: true }], { sessionId: '' })), null);
      t.eq(I.detect(makeCtx([{ senderId: '1', senderName: 'a', text: '今天天气不错', atMe: true }])), null);
      t.eq(I.detect(makeCtx([{ senderId: '10001', senderName: '小语', text: '金额统计', atMe: true, isSelf: true }])), null);

      // 设置 allowWithoutAt=true 后免 @ 也触发
      host.setSettings({ allowWithoutAt: true });
      t.ok(I.detect(makeCtx([{ senderId: '20001', senderName: '阿甲', text: '金额统计', atMe: false }])), '打开免@后应触发');
      host.setSettings({ allowWithoutAt: false });

      // 宿主明确说工具不可用（{ok:false}）→ 放弃接管，按普通聊天处理
      installRuntime({ config, availability: { ok: false, reason: '工具被关掉了' } });
      t.eq(I.detect(atCtx), null, '工具不可用时不接管');
      installRuntime({ config, availability: { ok: true } });
      t.ok(I.detect(atCtx), '工具恢复可用后能再次识别');
    }
  },

  {
    name: '钩子链路与 llm.request-params（识别→改写→拦截→发送→清正文）',
    async run(t) {
      const config = { persona: { selfNickname: '小语' }, tools: {} };
      const prices = { in: 0, out: 0, cached: 0 };
      // 给 chat:123456（mock 默认会话）造一条今天的真实会话记录
      writeSession({
        chatKey: 'group:123456', startedAt: Date.now(), model: 'test-model', vendor: '',
        usage: { promptTokens: 800, completionTokens: 100, cachedTokens: 0, totalTokens: 900, calls: 1 },
        trigger: [{ senderId: '20001', senderName: '阿甲', text: '@小语 金额统计 今天', atMe: true }]
      });
      installRuntime({ config, price: prices, availability: { ok: true } });
      const host = createMockHost({
        id: 'group-cost-report',
        settings: { triggerWords: '金额统计', allowWithoutAt: false, defaultRange: 'today', topN: 8, footer: false }
      });
      const mod = await loadExtension({ config, price: prices, availability: { ok: true } });
      await mod.setup(host.api);
      const I = mod.internals;

      const ctx = host.ctx({
        triggerEntries: [{ senderId: '20001', senderName: '阿甲', text: '@小语 金额统计 今天', atMe: true, isSelf: false }]
      });

      // ① before-context 只记任务，不发消息
      mod.hooks['before-context'](ctx);
      t.eq(host.calls.sent.length, 0, '识别阶段绝不能发消息');

      // ② before-llm-messages：保留 system，压成一句任务指令
      mod.hooks['before-llm-messages'](ctx);
      t.eq(ctx.messages.length, 2, 'system + 任务指令');
      t.eq(ctx.messages[0].role, 'system');
      t.contains(ctx.messages[1].content, '【本群花费统计任务】');
      t.contains(ctx.messages[1].content, 'group-cost-report__group_cost_report', '指令里应使用加载器给的工具全名');

      // ④ before-tool：别的工具先拦，本插件的工具放行
      const blocked = mod.hooks['before-tool']({ ...ctx, toolName: 'send_message' });
      t.ok(blocked && blocked.block === true, '未发报告前其它工具应被拦');
      t.eq(mod.hooks['before-tool']({ ...ctx, toolName: 'group-cost-report__group_cost_report' }), undefined);

      // ③ llm.request-params 只留本插件工具
      const body = {
        model: 'x',
        tools: [
          { type: 'function', function: { name: 'send_message' } },
          { type: 'function', function: { name: 'group-cost-report__group_cost_report' } },
          { type: 'function', function: { name: 'finish' } }
        ],
        tool_choice: 'auto',
        parallel_tool_calls: true
      };
      const providerOut = mod.providers['llm.request-params']({ body, context: { sessionId: ctx.sessionId } });
      t.eq(providerOut.body.tools.length, 1);
      t.eq(providerOut.body.tools[0].function.name, 'group-cost-report__group_cost_report');
      t.eq(providerOut.body.parallel_tool_calls, undefined, '思考端点不认 parallel_tool_calls，应删掉');

      // ⑤ 工具 execute：统计 + 走 ctx.sender 发送
      const tool = host.tools.get('group_cost_report');
      t.ok(tool, '工具应已在 setup 里注册');
      const result = await tool.execute(ctx, {});
      t.eq(result.isError, undefined);
      t.contains(result.content, '已经直接发送到本群');
      t.eq(host.calls.sent.length, 1, '只发一条报告');
      t.contains(host.calls.sent[0].text, '本群花费统计（');
      t.contains(host.calls.sent[0].text, '阿甲(QQ:20001)');

      // ⑥ after-tool / after-response：已发送则清空模型正文
      mod.hooks['after-tool']({ ...ctx, toolName: 'group-cost-report__group_cost_report', result });
      const response = { message: { content: '好的，这是统计结果……' } };
      mod.hooks['after-response']({ ...ctx, response });
      t.eq(response.message.content, '', '报告已直发，正文必须清空');

      // 发完之后 before-tool 只放行 finish；能力只留 finish
      t.eq(mod.hooks['before-tool']({ ...ctx, toolName: 'send_message' })?.block, true);
      t.eq(mod.hooks['before-tool']({ ...ctx, toolName: 'finish' }), undefined);
      const finishOut = mod.providers['llm.request-params']({ body, context: { sessionId: ctx.sessionId } });
      t.eq(finishOut.body.tools.length, 1);
      t.eq(finishOut.body.tools[0].function.name, 'finish');

      // 同一轮重复调用不会重复发送
      const again = await tool.execute(ctx, {});
      t.contains(again.content, '已经统计并发送过了');
      t.eq(host.calls.sent.length, 1, '不能重复发送');

      // 收尾：清任务表，验证 dispose 幂等
      mod.dispose();
      mod.dispose();
      t.eq(host.calls.sent.length, 1);
    }
  }
];
