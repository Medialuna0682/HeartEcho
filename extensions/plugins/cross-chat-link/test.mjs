/**
 * cross-chat-link 移植自测（node tools/extensions-test.mjs --only cross-chat-link）
 *
 * 覆盖：
 *   1. 默认设置合并（mergeSettings）+ available() 同步读实时设置
 *   2. 卡片拼装纯函数（formatPersonCard）：文案、当前会话排除、印象条数/会话数上限、隐私提示
 *   3. buildPersonCard：没有别的会话记忆就一个字都不加；素材读取失败当作不认识
 *   4. 钩子可离线行为：before-context 收集本轮发言人；关掉插件时 before-llm-messages 不改消息
 *
 * 注意：测试不碰心语真实 sqlite 记忆库 —— 素材读取通过 deps.loadChats 注入假数据，
 * 只验证与数据源无关的拼装逻辑（默认 loader 的 SQL 只在宿主运行时执行）。
 */
import * as link from './index.js';

const DAY = 86400000;
const now = Date.now();

function chatsFixture() {
  return [
    // 当前群：同群印象必须排除（两种 chatKey 写法都要能认出来）
    { chatKey: 'group:123456', name: '小明', impressions: ['当前群里的印象'], updatedAt: now - 1000 },
    { chatKey: 'group_123456_20002', name: '小明', impressions: ['原始 scope 形态的同群印象'], updatedAt: now - 2000 },
    // 别的群：4 条印象 → 默认只带最近 3 条
    {
      chatKey: 'group:888888',
      name: '小明',
      impressions: ['常聊某类游戏', '熟悉某个术语', '爱调侃昵称', '喜欢猫'],
      updatedAt: now - 2 * DAY,
      last: { text: '我先去吃饭', at: '12:30' }
    },
    // 私聊：跨会话素材，带出隐私提醒
    { chatKey: 'private:20002', name: '', impressions: ['私聊里说过最近在备考'], updatedAt: now - DAY },
    // 第 3 个别的会话：默认 maxOtherChats=2 时不应出现
    { chatKey: 'group:777777', name: '小明', impressions: ['话不多'], updatedAt: now - 5 * DAY }
  ];
}

export const cases = [
  {
    name: '默认设置合并 + available() 同步',
    async run(t) {
      t.deepEq(link.mergeSettings({}), {
        enabled: true,
        maxImpressions: 3,
        maxOtherChats: 2,
        includeRecentLine: true,
        privacyNote: true
      });
      const merged = link.mergeSettings({ maxImpressions: 5, privacyNote: false, unknownKey: 1 });
      t.eq(merged.maxImpressions, 5);
      t.eq(merged.privacyNote, false);
      t.eq(merged.maxOtherChats, 2, '未覆盖的键保留默认值');
      t.eq(merged.unknownKey, 1, '未知键照原实现透传');

      // 宿主 setup(api) 注入 api.config 后，available() 每次同步读实时设置
      link.setup({ config: () => ({}) });
      t.ok(link.available() === true, 'available() 必须同步返回 true');
      link.setup({ config: () => ({ enabled: false }) });
      t.ok(link.available() === false, 'enabled=false 时同步返回 false');
      link.setup({ config: () => ({}) });

      // scope_key → chatKey 边界翻译
      t.eq(link.scopeToChatKey('group_123456_20002'), 'group:123456');
      t.eq(link.scopeToChatKey('private_20002'), 'private:20002');
      t.eq(link.scopeToChatKey('group:123456'), 'group:123456');
    }
  },
  {
    name: '卡片拼装纯函数：文案 / 排除当前会话 / 上限 / 隐私提示',
    async run(t) {
      const card = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'group:123456',
        chats: chatsFixture(),
        notes: {},
        s: link.DEFAULTS
      });
      t.ok(card, '有别的会话印象时应出卡');
      t.contains(card, '【这个人你也认识】小明(QQ:20002) · 你现在在群 123456里跟他说话');
      t.contains(card, '· 你在「群 888888」里对他的印象：');
      t.contains(card, '熟悉某个术语｜爱调侃昵称｜喜欢猫', '默认只带最近 3 条印象');
      t.contains(card, '· 他最近在群 888888说过（12:30）：「我先去吃饭」');
      t.contains(card, '· 私聊内容属于隐私：在群里**别复述**他私聊说过的话，只当自己知道这个人。');
      t.contains(card, '（同一个人的两边记忆要一致：称呼、态度、你已知的事都按上面来，别当成两个陌生人。）');
      t.notContains(card, '当前群里的印象', '当前会话的印象要被排除');
      t.notContains(card, '原始 scope 形态的同群印象', '数据库形态的当前会话也要排除');
      t.notContains(card, '群 777777', '默认最多列 2 个别的会话');

      // 关掉隐私提醒 / 只列 1 个别的会话 / 每人只带 1 条印象
      const quiet = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'group:123456',
        chats: chatsFixture(),
        notes: {},
        s: { ...link.DEFAULTS, privacyNote: false }
      });
      t.notContains(quiet, '私聊内容属于隐私');
      const oneChat = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'group:123456',
        chats: chatsFixture(),
        notes: {},
        s: { ...link.DEFAULTS, maxOtherChats: 1 }
      });
      t.notContains(oneChat, '私聊 20002');
      t.notContains(oneChat, '私聊内容属于隐私', '只列群会话时不该出现私聊隐私提醒');
      const oneImpression = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'group:123456',
        chats: chatsFixture(),
        notes: {},
        s: { ...link.DEFAULTS, maxImpressions: 1 }
      });
      t.contains(oneImpression, '喜欢猫');
      t.notContains(oneImpression, '爱调侃昵称');

      // 当前是私聊：文案不同，群会话反而算"别的会话"，且不追加群内隐私提醒
      const inPrivate = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'private:20002',
        chats: chatsFixture(),
        notes: {},
        s: link.DEFAULTS
      });
      t.contains(inPrivate, '【这个人你也认识】小明(QQ:20002) · 你们现在是私聊');
      t.notContains(inPrivate, '私聊内容属于隐私');

      // 备注里的称呼优先
      const named = link.formatPersonCard({
        uid: '20002',
        currentChatKey: 'group:123456',
        chats: chatsFixture(),
        notes: { 20002: '小明同学' },
        s: link.DEFAULTS
      });
      t.contains(named, '【这个人你也认识】小明同学(QQ:20002)');

      // 没有别的会话素材 → 不出卡
      t.eq(
        link.formatPersonCard({ uid: '20002', currentChatKey: 'group:123456', chats: [], notes: {}, s: link.DEFAULTS }),
        null
      );
    }
  },
  {
    name: 'buildPersonCard：没有跨会话记忆就一个字都不加',
    async run(t) {
      // 完全没有任何印象
      t.eq(link.buildPersonCard('20002', 'group:123456', link.DEFAULTS, { loadChats: () => [] }), null);
      // 只有当前会话的素材：不叫跨会话，返回 null（绝不凭空编）
      t.eq(
        link.buildPersonCard('20002', 'group:123456', link.DEFAULTS, {
          loadChats: () => [
            { chatKey: 'group:123456', name: '小明', impressions: ['同群印象'] },
            { chatKey: 'group_123456_20002', name: '小明', impressions: ['同群原始形态'] }
          ]
        }),
        null
      );
      // 素材读取抛错：当作不认识，不向上抛
      t.eq(
        link.buildPersonCard('20002', 'group:123456', link.DEFAULTS, {
          loadChats: () => {
            throw new Error('记忆库不可用');
          }
        }),
        null
      );

      let options = null;
      const card = link.buildPersonCard('20002', 'group:123456', link.DEFAULTS, {
        loadChats: (uid, opts) => {
          options = { uid, opts };
          return chatsFixture();
        },
        notes: { 20002: '小明同学' }
      });
      t.eq(options.uid, '20002');
      t.eq(options.opts.includeRecentLine, true, 'includeRecentLine 设置要传给素材读取');
      t.contains(card, '小明同学(QQ:20002)');
      t.contains(card, '群 888888');
      // 空 uid 直接不出卡
      t.eq(link.buildPersonCard('', 'group:123456', link.DEFAULTS, { loadChats: () => chatsFixture() }), null);
    }
  },
  {
    name: '钩子：before-context 收集；关闭时 before-llm-messages 一个字都不加',
    async run(t) {
      // 关掉插件：钩子直接返回，不改 messages（也不会去查记忆库）
      link.setup({ config: () => ({ enabled: false }) });
      const messages = [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '你好' }
      ];
      const ctx = {
        chatKey: 'group:123456',
        sessionId: 'turn-1',
        triggerEntries: [{ senderId: '20002' }, { senderId: '20002' }, { senderId: 'self' }, { senderId: '20003' }],
        messages
      };
      t.eq(await link.hooks['before-context'](ctx), undefined, 'before-context 不得返回值');
      await link.hooks['before-llm-messages'](ctx);
      t.eq(ctx.messages[1].content, '你好', 'enabled=false 时一个字都不加');
      t.eq(ctx.messages.length, 2, '不得新增消息');

      // 打开插件但本轮没被 before-context 记录过（sessionId 对不上）→ 同样不加
      link.setup({ config: () => ({}) });
      const unknownCtx = { chatKey: 'group:123456', sessionId: 'turn-unknown', messages: [{ role: 'user', content: '嗯' }] };
      await link.hooks['before-llm-messages'](unknownCtx);
      t.eq(unknownCtx.messages[0].content, '嗯');
      t.eq(unknownCtx.messages.length, 1);

      // 能力 provider：缺 uid 时返回稳定的错误结构（不查记忆库）
      const provider = link.providers['memory.person-card'];
      t.eq(typeof provider, 'function');
      t.deepEq(provider({}), { ok: false, error: '需要 uid' });
      t.eq(provider({}).ok, false);
    }
  }
];
