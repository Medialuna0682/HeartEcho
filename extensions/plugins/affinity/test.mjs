/**
 * affinity 移植自测（node tools/extensions-test.mjs --only affinity）
 *
 * 覆盖：
 *   1. 默认设置合并 + 等级算法纯函数（levelOf / progressText / levelTable）
 *   2. applyDecay / findMember / ownerList 纯函数
 *   3. check 工具的可离线行为（设置 perMessage=2 生效、数据落到 DATA_DIR）
 *   4. before-context 钩子只做本地记账（不发消息、不发图、只写 DATA_DIR）
 *
 * 说明：扩展的 DATA_DIR 在模块求值时就固定了，所以先给兼容层绑一个临时数据目录，
 * 再动态 import 扩展（这样测试不会写真实数据目录，也不会污染扩展包目录）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockHost, installTestRuntime } from '../../../tools/extension-harness.mjs';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'he-ext-affinity-'));
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

// 用例失败时也把临时数据目录收拾掉（成功路径在最后一个 case 里已删）。
process.once('exit', () => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

let mod = null;

async function load() {
  if (!mod) {
    installTestRuntime({ dataDir: DATA_DIR, settings: {} });
    mod = await import('./index.js');
  }
  return mod;
}

function dataFile() {
  return path.join(DATA_DIR, 'affinity', 'affinity.json');
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
}

export const cases = [
  {
    name: '默认设置合并 + 等级算法（纯函数）',
    async run(t) {
      const m = await load();
      t.eq(m.available(), true, 'available() 必须同步返回 true');

      // 默认等级门槛 50 / 200 / 500 / 1000
      t.eq(m.levelTable({}).map((item) => item.level).join(','), '5,4,3,2,1');
      t.eq(m.levelOf(0, {}).level, 1);
      t.eq(m.levelOf(49, {}).title, '陌生');
      t.eq(m.levelOf(50, {}).title, '眼熟');
      t.eq(m.levelOf(199, {}).level, 2);
      t.eq(m.levelOf(200, {}).level, 3);
      t.eq(m.levelOf(499, {}).level, 3);
      t.eq(m.levelOf(500, {}).level, 4);
      t.eq(m.levelOf(1000, {}).title, '挚友');
      t.eq(m.progressText(0, {}), '再攒 50 分升到 Lv.2「眼熟」');
      t.eq(m.progressText(50, {}), '再攒 150 分升到 Lv.3「熟人」');
      t.eq(m.progressText(2000, {}), '已经是最高等级「挚友」了');

      // 自定义门槛生效；非递增的非法门槛回退默认值，不抛错
      t.eq(m.levelOf(10, { levelThresholds: '10,20,30,40' }).title, '眼熟');
      t.eq(m.levelOf(40, { levelThresholds: '10,20,30,40' }).title, '挚友');
      t.eq(m.levelOf(10, { levelThresholds: '10,30,20,40' }).title, '陌生');
      t.eq(m.levelTable({ levelThresholds: '1,2,3' }).map((item) => item.min).join(','), '1000,500,200,50,0');
    }
  },
  {
    name: 'applyDecay / findMember / ownerList（纯函数）',
    async run(t) {
      const m = await load();
      const DAY = 86400000;
      const now = Date.now();

      // 10 天没发言、7 天后开始每天 -1 分 → 扣 3 分
      const rec = { score: 100, lastSeen: now - 10 * DAY, level: 5, pinned: false };
      t.eq(m.applyDecay(rec, now, { decayAfterDays: 7, decayPerDay: 1 }), 3);
      t.eq(rec.score, 97);
      t.eq(rec.level, 2, '等级按当前分数校正');
      t.eq(m.applyDecay(rec, now, { decayAfterDays: 7, decayPerDay: 1 }), 0, '同一段时间不重复扣分');

      // 主人记录（pinned）永不衰减
      const pinned = { score: 9999, pinned: true, level: 5 };
      t.eq(m.applyDecay(pinned, now, { decayPerDay: 5 }), 0);
      t.eq(pinned.score, 9999);

      // 找人不区分 QQ 号 / 昵称；重名取分数最高并标记歧义
      const members = {
        20002: { name: '小明', score: 30 },
        20003: { name: '小明', score: 80 },
        20004: { name: '小红', score: 5 }
      };
      t.eq(m.findMember(members, '20003').userId, '20003');
      t.eq(m.findMember(members, '小红').userId, '20004');
      // 昵称完全匹配取第一个；模糊匹配到多人时取分数最高的并标记歧义
      t.eq(m.findMember(members, '小明').userId, '20002');
      const ambiguous = m.findMember(members, '明');
      t.eq(ambiguous.userId, '20003');
      t.eq(ambiguous.ambiguous, 2);
      t.eq(m.findMember(members, '查无此人'), null);

      // 主人 QQ 号支持逗号 / 中文逗号 / 空格分隔
      t.deepEq(m.ownerList({ ownerQq: '1942434405, 123456，abc 789' }), ['1942434405', '123456', '789']);
      t.deepEq(m.ownerList({ ownerQq: '' }), []);

      // store 条目 / triggerEntries 条目统一成内部结构（含 CQ 码 at）
      const entry = m.normalizeEntry({
        message: [{ type: 'text', data: { text: '你好 [CQ:at,qq=10001]' } }],
        sender: { user_id: '20002', nickname: '小明' },
        message_id: 'm1',
        timestamp: Math.floor(now / 1000)
      });
      t.eq(entry.userId, '20002');
      t.eq(entry.mid, 'm1');
      t.eq(entry.text, '你好');
      t.ok(entry.ats.includes('10001'), 'CQ:at 应解析成 at 列表');
      t.eq(entry.isSelf, false);
      t.eq(m.normalizeEntry(null), null);
      t.eq(m.normalizeEntry({ entry: { senderId: '30003', text: 'hi', at: now } }).userId, '30003');
    }
  },
  {
    name: 'check 工具：设置合并生效，数据写在 DATA_DIR',
    async run(t) {
      const m = await load();
      const host = createMockHost({ id: 'affinity', settings: { perMessage: 2, botQq: '10001' } });
      m.setup(host.api);

      // 四个工具都要在 setup 期间注册
      t.eq(host.tools.size, 4, '应注册 4 个工具');
      for (const id of ['check', 'rank', 'tune', 'reset']) t.ok(host.tools.has(id), `缺少工具 ${id}`);

      host.setMessages([
        { mid: 'm1', senderId: '20002', senderName: '小明', text: '你好', at: Date.now() - 60000, self: false },
        { mid: 'm2', senderId: '20002', senderName: '小明', text: '在吗', at: Date.now() - 30000, self: false }
      ]);
      const ctx = host.ctx({ triggerEntries: [] });
      const result = await host.tools.get('check').execute(ctx, {});
      // 面板设置 perMessage=2（不是内置默认 1）→ 两条消息得 4 分
      t.contains(result.content, '对象：小明（QQ 20002）');
      t.contains(result.content, '好感度：4 分');
      t.contains(result.content, '等级：Lv.1「陌生」');
      t.contains(result.content, '群内排名：第 1 名 / 共 1 人');

      const saved = readDb();
      t.ok(saved, '数据必须写到 DATA_DIR/affinity/affinity.json');
      t.eq(saved.chats['group:123456'].members['20002'].score, 4);
      t.eq(saved.chats['group:123456'].members['20002'].msgs, 2);
      t.eq(fs.existsSync(path.join(PKG_DIR, 'affinity.json')), false, '不能写扩展包目录');
      host.cleanup();
    }
  },
  {
    name: 'before-context 钩子只做本地记账（禁网禁发）',
    async run(t) {
      const m = await load();
      const host = createMockHost({ id: 'affinity', settings: { perMessage: 1, botQq: '10001' } });
      m.setup(host.api);
      host.setMessages([{ mid: 'h1', senderId: '30003', senderName: '小红', text: '早上好', at: Date.now() - 5000, self: false }]);

      const sentBefore = host.calls.sent.length;
      const imageBefore = host.calls.images.length;
      const returned = await m.hooks['before-context']({
        chatKey: 'group:999',
        chatId: '999',
        kind: 'group',
        store: host.api.store,
        triggerEntries: [],
        sender: host.api.sender
      });

      t.eq(returned, undefined, 'before-context 不得返回值');
      t.eq(host.calls.sent.length, sentBefore, '钩子里禁止发消息');
      t.eq(host.calls.images.length, imageBefore, '钩子里禁止发图片');
      const saved = readDb();
      t.ok(saved, '钩子应把记账结果落盘到 DATA_DIR');
      t.eq(saved.chats['group:999'].members['30003'].score, 1);
      t.eq(saved.chats['group:999'].members['30003'].msgs, 1);
      host.cleanup();
    }
  },
  {
    name: '定时播报：走 api.sender 主动发送，deactivate 清定时器',
    async run(t) {
      const m = await load();
      const host = createMockHost({
        id: 'affinity',
        // 一条消息 +60 分，直接跨过 Lv.2 门槛（默认 50）以便产生「升级播报」
        settings: { perMessage: 60, dailyCap: 500, botQq: '10001' }
      });
      const sent = [];
      // 宿主主动发送签名（契约补充）：sendTextBatch(chatKey, texts)
      host.api.sender = {
        async sendText() {},
        async sendImage() {},
        async sendTextBatch(chatKey, texts) {
          sent.push({ chatKey, texts });
          return { sent: texts.length };
        }
      };
      m.setup(host.api);
      host.setMessages([{ mid: 'lvl1', senderId: '20002', senderName: '小明', text: '升个级', at: Date.now() - 1000, self: false }]);
      // before-context 只记账；升级消息先进 pending，等定时器播报（钩子里禁止发消息）
      await m.hooks['before-context']({
        chatKey: 'group:555',
        chatId: '555',
        kind: 'group',
        store: host.api.store,
        triggerEntries: [],
        sender: host.api.sender
      });
      t.eq(host.calls.sent.length, 0, '记账阶段不应该发任何消息');

      // 截获 activate() 里建的定时器（真实计时器要等 2 分钟，这里手动触发一次）
      const timers = [];
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      let cleared = 0;
      globalThis.setInterval = (fn, ms) => {
        timers.push({ fn, ms });
        return { unref() {}, __fake: true };
      };
      globalThis.clearInterval = (timer) => {
        cleared += 1;
        return realClearInterval(timer);
      };
      try {
        await m.activate();
        t.eq(timers.length, 1, 'activate 应建一个定时器');
        t.eq(timers[0].ms, 120000);
        timers[0].fn();
        for (let i = 0; i < 30 && !sent.length; i += 1) await t.sleep(10);

        t.eq(sent.length, 1, '定时播报应通过 api.sender 主动发送');
        t.eq(sent[0].chatKey, 'group:555', '主动发送必须带上正确的 chatKey');
        t.contains(sent[0].texts[0], '好感度更新：');
        t.contains(sent[0].texts[0], '小明 的好感度升到了 Lv.2「眼熟」');

        // deactivate 必须清掉 activate 建的定时器
        await m.deactivate();
        t.eq(cleared, 1, 'deactivate 应清掉定时器');
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
      }

      host.cleanup();
      m.dispose();
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
  }
];
