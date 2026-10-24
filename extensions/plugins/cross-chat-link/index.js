// 跨会话认人（确定性型 / plugins/，纯 hooks）
//
// ── 解决的问题（用户实测反馈）────────────────────────────────────────────
// 群友在群里聊熟了，转头私聊她，再回群里问她"刚才私聊说的那个" —— 她认不出这是
// 同一个人，两边的态度、称呼、记忆全对不上。原平台把「按人印象」按会话存成
//   data/memory/<chatKey>/<uid>.json  →  { userId, name, impressions[] }
// 群里的印象只挂在 group:xxx 下，私聊时读不到，反之亦然。
//
// ── 心语这边怎么移植 ──────────────────────────────────────────────────────
// 心语没有 data/memory 那种文件：按人印象在 sqlite 的 memories 表里
// （scope_key / subject_id / content / category / pinned / at），聊天原文在 messages 表。
// 所以这里改成**只读**查询心语记忆库（lib/db.mjs），语义完全不变：
// 谁这轮说话，就把**他在别的会话里**的印象摘要一起带进提示词，并说明当前在哪个会话：
//   【这个人你也认识】某某(QQ:123456789) · 现在是私聊
//   · 你在「群 123456789」里对他的印象：常聊某类游戏，熟悉某个术语…｜爱调侃昵称…
//   · 他在群里的最后一句话（23:10）：…
//   · 私聊内容属于隐私：群里别复述他私聊说过的话
//
// 印象按 `subject_id = 说话人` 查，再按 scope_key 归并成「别的会话」；当前会话
// （group:<群号> / private:<QQ>）被排除。没有跨会话记忆的人一个字都不加。
//
// 不变量：没有跨会话记忆的人 → 一个字都不加；关掉插件 → 行为回到原生。
// 硬约束：只读数据库（每条查询都 try/catch 兜底），不发消息、不联网、不写任何文件、
//         不改 DATA_DIR 下的东西 —— 心语没有这种「按人印象文件」，不再编造文件路径。
//
// 为什么不用别的会话的**聊天记录**整段带进来：那是很大的数据，每轮解析太浪费；
// 这里只取 memories 表里本来就有的「印象」+（可选）一句话兜底，量很小。

import { getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';
import { all } from '../../../lib/db.mjs';

/**
 * 把人物卡注入到请求**末尾**（保住 system 的缓存前缀）。
 *
 * 兼容性回退：若兼容层没有 appendDynamicTail，就自己追加到最后一条 user 消息
 * （心语契约 §9 保证有；这里保留原实现的存在性回退，装到旧宿主上也不会整个插件失效）。
 */
const appendToSystem = typeof promptCore.appendDynamicTail === 'function'
  ? promptCore.appendDynamicTail
  : (messages, text) => {
    if (!Array.isArray(messages) || !text) return false;
    const block = `\n\n${String(text).trim()}`;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') { m.content += block; return true; }
      if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
    }
    messages.push({ role: 'user', content: block.trim() });
    return true;
  };

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
export const DEFAULTS = {
  enabled: true,
  maxImpressions: 3,
  maxOtherChats: 2,
  includeRecentLine: true,
  privacyNote: true
};

let api = null;
/** 本轮触发的人（before-context 收集，before-llm-messages 消费）。 */
const pendingPeople = new Map();

/** 默认值 + 面板设置合并（纯函数，测试可直接验证默认值语义）。 */
export function mergeSettings(raw = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  return mergeSettings(raw);
}

const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '?');
};

/* ───────────────────────── 作用域 ↔ 对外 chatKey ───────────────────────── */

/**
 * 心语数据库的 scope_key（`group_<群号>_<QQ>` / `private_<QQ>`）→ 对外 chatKey
 * （契约 §3：`group:<群号>` / `private:<QQ>`）。传进来的如果已经是 chatKey 就原样返回。
 */
export function scopeToChatKey(scopeKey) {
  const key = String(scopeKey ?? '').trim();
  if (!key) return '';
  let matched = /^private_(.+)$/.exec(key);
  if (matched) return `private:${matched[1]}`;
  matched = /^group_(\d+)(?:_\d+)?$/.exec(key);
  if (matched) return `group:${matched[1]}`;
  return key; // sandbox 等自定义作用域：原样保留（不会和张冠李戴的群/私聊混在一起）
}

function parseChatKey(chatKey) {
  const text = String(chatKey ?? '').trim();
  const direct = /^(group|private):(.+)$/.exec(text);
  if (direct) return { kind: direct[1], id: direct[2] };
  const converted = /^(group|private):(.+)$/.exec(scopeToChatKey(text));
  if (converted) return { kind: converted[1], id: converted[2] };
  return { kind: '', id: '' };
}

/** 两个 chatKey 是否指同一个会话（兼容 `group:1` 与 `group_1_123` 两种写法）。 */
function sameChat(a, b) {
  const left = parseChatKey(a);
  const right = parseChatKey(b);
  return Boolean(left.kind) && left.kind === right.kind && left.id === right.id;
}

/* ───────────────────────── 心语记忆库（只读） ───────────────────────── */

/** 只读查询；记忆库不可用（表还没建/被占用/测试环境）时当作空，绝不打断对话。 */
function safeAll(sql, params = []) {
  try {
    return all(sql, params) ?? [];
  } catch {
    return [];
  }
}

/**
 * 某人在所有会话里的「按人印象」。心语里 memories.subject_id 记的就是对话对方的 QQ：
 *  - 私聊 scope `private_<QQ>`：subject_id = QQ
 *  - 群聊 scope `group_<群号>_<QQ>`：subject_id = 发言的 QQ
 * 所以直接按 subject_id 就能跨会话拿到"你在别处认识他"的素材。
 */
function memoryRows(uid) {
  const id = String(uid);
  const rows = safeAll(
    `select scope_key, content, at, pinned from memories
     where subject_id = ? and status = 'active' and category <> 'diary'
     order by at asc limit 500`,
    [id]
  );
  // 早期私聊记忆的 subject_id 可能为空：private_<QQ> 这个作用域只可能是和这个人聊的，补一份
  rows.push(
    ...safeAll(
      `select scope_key, content, at, pinned from memories
       where scope_key = ? and subject_id = '' and status = 'active' and category <> 'diary'
       order by at asc limit 100`,
      [`private_${id}`]
    )
  );
  return rows;
}

/** 会话里怎么称呼他：优先最近一条消息的群名片/昵称，再退回群成员表 / 联系人表。 */
function nameFromDb(scopeKey, uid) {
  const messageRows = safeAll(
    `select sender_name from messages
     where scope_key = ? and sender_id = ? and sender_name <> ''
     order by at desc limit 1`,
    [scopeKey, String(uid)]
  );
  const fromMessage = String(messageRows[0]?.sender_name ?? '').trim();
  if (fromMessage) return fromMessage;

  const chat = parseChatKey(scopeToChatKey(scopeKey));
  if (chat.kind === 'group') {
    const rows = safeAll(`select card, nickname from group_members where group_id = ? and peer_id = ?`, [
      chat.id,
      String(uid)
    ]);
    return String(rows[0]?.card || rows[0]?.nickname || '').trim();
  }
  if (chat.kind === 'private') {
    const rows = safeAll(`select display_name from contacts where peer_id = ? order by last_seen_at desc limit 1`, [
      String(uid)
    ]);
    return String(rows[0]?.display_name ?? '').trim();
  }
  return '';
}

/** 他在这个会话里的最后一句（心语消息表里按 scope 查，不再需要防大文件）。 */
function lastLineFromDb(scopeKey, uid) {
  const rows = safeAll(
    `select body, at from messages
     where scope_key = ? and direction = 'in' and sender_id = ? and body <> ''
     order by at desc limit 1`,
    [scopeKey, String(uid)]
  );
  const row = rows[0];
  if (!row) return null;
  const text = String(row.body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const date = new Date(Number(row.at) || 0);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { text: text.slice(0, 60), at: hhmm };
}

/**
 * 默认素材来源：读心语记忆库，按会话归并成
 * `{ chatKey, name, impressions[], updatedAt, last }`。
 * 只读；任何一条查询失败都退化成空，保证「认不出就不加字」。
 */
function defaultLoadChats(uid, { includeRecentLine = true } = {}) {
  const chats = new Map();
  for (const row of memoryRows(uid)) {
    const chatKey = scopeToChatKey(row.scope_key);
    if (!chatKey) continue;
    let chat = chats.get(chatKey);
    if (!chat) {
      chat = { chatKey, scopeKeys: [], name: '', impressions: [], updatedAt: 0, last: null };
      chats.set(chatKey, chat);
    }
    const content = String(row.content ?? '').trim();
    if (content) chat.impressions.push(content);
    chat.updatedAt = Math.max(chat.updatedAt, Number(row.at) || 0);
    if (!chat.scopeKeys.includes(row.scope_key)) chat.scopeKeys.push(row.scope_key);
  }
  for (const chat of chats.values()) {
    for (const scopeKey of chat.scopeKeys) {
      if (!chat.name) chat.name = nameFromDb(scopeKey, uid);
      if (!chat.last && includeRecentLine) chat.last = lastLineFromDb(scopeKey, uid);
    }
  }
  return [...chats.values()].map(({ scopeKeys, ...rest }) => rest);
}

/* ───────────────────────────── 人物卡 ───────────────────────────── */

/**
 * 纯函数：把「他在别的会话里的素材」拼成人物卡。
 * 没有任何别的会话素材 → 返回 null（本插件最重要的不变量：认不出就不加字，绝不凭空编）。
 */
export function formatPersonCard({ uid, currentChatKey = '', chats = [], notes = {}, s = DEFAULTS } = {}) {
  const id = String(uid ?? '').trim();
  if (!id) return null;

  // 当前会话统一成 chatKey 形态（宿主给 group:1，数据库给 group_1_123，两种都兼容）
  const current = /^(group|private):/.test(String(currentChatKey ?? ''))
    ? String(currentChatKey ?? '')
    : scopeToChatKey(currentChatKey);
  const currentKind = parseChatKey(current).kind;

  const others = [];
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || !chat.chatKey) continue;
    // 素材里的会话也统一成 chatKey 形态（默认 loader 已归一，这里兼容注入的原始 scope_key）
    const rawKey = String(chat.chatKey);
    const chatKey = /^(group|private):/.test(rawKey) ? rawKey : scopeToChatKey(rawKey);
    if (!chatKey) continue;
    if (sameChat(chatKey, current)) continue; // 当前会话的印象不叫「跨会话」
    const impressions = (Array.isArray(chat.impressions) ? chat.impressions : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
    const name = String(chat.name ?? '').trim();
    const last = chat.last && chat.last.text
      ? { text: String(chat.last.text), at: String(chat.last.at ?? '') }
      : null;
    // 印象或最近发言/昵称，有一样就算"你在别处认识他"
    if (!impressions.length && !name && !last) continue;
    others.push({
      chatKey,
      name,
      impressions,
      updatedAt: Number(chat.updatedAt) || 0,
      last
    });
  }
  if (!others.length) return null;

  // 有印象的、且印象新的排前面；只有最近发言的排后面
  others.sort((a, b) => (b.impressions.length - a.impressions.length) || ((b.updatedAt || 0) - (a.updatedAt || 0)));

  const pick = others.slice(0, Math.max(1, Number(s.maxOtherChats) || 2));
  const lines = [];
  const who = notes[id] || pick.find((m) => m.name)?.name || `QQ:${id}`;
  // 当前会话怎么称呼：私聊里对面就是他本人，群里则要点明是哪个群
  const where = currentKind === 'private'
    ? '你们现在是私聊'
    : `你现在在${chatLabel(current)}里跟他说话`;
  lines.push(`【这个人你也认识】${who}(QQ:${id}) · ${where}`);

  for (const mem of pick) {
    const imps = mem.impressions.slice(-Math.max(1, Number(s.maxImpressions) || 3));
    if (imps.length) {
      lines.push(`· 你在「${chatLabel(mem.chatKey)}」里对他的印象：${imps.map((x) => x.slice(0, 60)).join('｜')}`);
    } else if (mem.name) {
      lines.push(`· 你在「${chatLabel(mem.chatKey)}」里见过他（${mem.name}）`);
    }
    if (mem.last) lines.push(`· 他最近在${chatLabel(mem.chatKey)}说过（${mem.last.at}）：「${mem.last.text}」`);
  }

  // 私聊内容不进群：这是隐私，不是记忆同步
  const otherIsPrivate = pick.some((m) => parseChatKey(m.chatKey).kind === 'private');
  if (s.privacyNote !== false && otherIsPrivate && currentKind === 'group') {
    lines.push('· 私聊内容属于隐私：在群里**别复述**他私聊说过的话，只当自己知道这个人。');
  }
  lines.push('（同一个人的两边记忆要一致：称呼、态度、你已知的事都按上面来，别当成两个陌生人。）');
  return lines.join('\n');
}

/**
 * 组装一个人的跨会话卡片。没有"别的会话里的记忆"就返回 null。
 * deps.loadChats / deps.notes 仅用于测试注入；运行时走心语记忆库 + 兼容层配置。
 */
export function buildPersonCard(uid, currentChatKey, s = DEFAULTS, deps = {}) {
  const id = String(uid ?? '').trim();
  if (!id) return null;
  const loadChats = typeof deps.loadChats === 'function' ? deps.loadChats : defaultLoadChats;
  let chats = [];
  try {
    chats = loadChats(id, { includeRecentLine: s?.includeRecentLine !== false }) || [];
  } catch {
    chats = []; // 记忆库不可用时当作"不认识"，绝不阻断对话
  }
  let notes = deps.notes;
  if (!notes || typeof notes !== 'object') {
    try {
      notes = getConfig()?.memberNotes || {};
    } catch {
      notes = {};
    }
  }
  return formatPersonCard({ uid: id, currentChatKey, chats, notes, s });
}

/** 记忆里出现过的会话（启用日志 / 排查能力用，只读）。 */
function listKnownChats() {
  const rows = safeAll(`select distinct scope_key from memories where status = 'active' limit 200`, []);
  const keys = new Set();
  for (const row of rows) {
    const chatKey = scopeToChatKey(row.scope_key);
    if (chatKey) keys.add(chatKey);
  }
  return [...keys].map((chatKey) => ({ chatKey }));
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

export function activate() {
  const chats = listKnownChats();
  api?.log?.(`跨会话认人已启用：记忆里 ${chats.length} 个会话（${chats.map((c) => chatLabel(c.chatKey)).join('、') || '暂无'}）`);
}

export function available() {
  return settings().enabled !== false;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下本轮说话的人（只留 uid，别的都不需要）。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const uids = [];
      for (const e of entries) {
        const uid = String(e?.senderId ?? '').trim();
        if (uid && uid !== 'self' && !uids.includes(uid)) uids.push(uid);
      }
      pendingPeople.set(String(ctx.sessionId || ctx.chatKey || ''), {
        chatKey: String(ctx.chatKey || ''),
        uids
      });
      if (pendingPeople.size > 50) {
        const first = pendingPeople.keys().next().value;
        pendingPeople.delete(first);
      }
    } catch { /* 收集失败只是少一张人物卡 */ }
  },

  /** 命中才加行：这个人你在别的会话里认识。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingPeople.get(key) || null;
    pendingPeople.delete(key);
    if (!info || !info.uids.length) return;
    const chatKey = info.chatKey || String(ctx.chatKey || '');

    const cards = [];
    for (const uid of info.uids.slice(0, 3)) {
      const card = buildPersonCard(uid, chatKey, s);
      if (card) cards.push(card);
    }
    if (!cards.length) return;
    appendToSystem(ctx.messages, cards.join('\n\n'));
  }
};

// ── 能力：排查用 ─────────────────────────────────────────────────────────

export const providers = {
  /** 看某人现在能凑出什么样的跨会话卡片（args: { uid, chatKey }）。 */
  'memory.person-card': (args = {}) => {
    const uid = String(args?.uid || '').trim();
    const chatKey = String(args?.chatKey || '');
    if (!uid) return { ok: false, error: '需要 uid' };
    const card = buildPersonCard(uid, chatKey, settings());
    return {
      ok: true,
      uid,
      chatKey,
      known: Boolean(card),
      card,
      chats: listKnownChats().map((c) => c.chatKey)
    };
  }
};
