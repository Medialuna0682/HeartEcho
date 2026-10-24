// 表情品味（meme-taste）—— 让机器人自己长出一套表情口味
//
// ── 为什么是技能（skills/，LLM 型），不是插件 ────────────────────────────────
//   判据（README「扩展」一节）：规则能不能写死 —— 规则写死、满足条件必然执行 → 插件；
//   要理解人话、该不该做由模型判断 → 技能。
//   这里"这张图合不合她的口味"没有任何写死的规则可依据，只能她自己判断；而且
//   "什么时候该挑一张发出去"也要看语境（也就是得理解人话）。所以定成技能：
//   收藏这个动作由模型通过 registerTool 注册的工具自己决定要不要调。
//   本技能里那段确定性钩子（群里出现新图 → 把候选清单递到她眼前）只负责"让她看见"，
//   不替她做决定 —— 决定权在她，这也正是技能与插件的分界。
//
// 它做三件事：
//   1. 群里出现新图时，把"这几张我还没决定过"作为候选交给她，由她自己判断收不收（不替她决定）；
//   2. 给她的系统提示里加一份"她的表情品味档案"，让她知道自己喜欢什么、收藏过什么、额度还剩几张；
//   3. 记下她每次收藏时说的理由，反复出现的偏好会自动变成口味档案里的一条。
//
// 注意（照心语扩展契约 docs/扩展宿主契约.md 的规矩）：
//   - 工具必须在 setup() 执行期间注册，写在别的函数里等于静默失效；
//   - 钩子与 promptSections 必须模块顶层 export，api 上没有注册钩子的方法；
//   - 数据一律落在 DATA_DIR/meme-taste/ 下，绝不能用 process.cwd() 当锚点。
//
// 她收藏的东西落在两处：<DATA_DIR>/meme-taste/{taste,state}.json 是"我挑过什么、为什么挑"，
// 图本身由核心的 <DATA_DIR>/stickers.json + <DATA_DIR>/sticker-images/ 存 —— 后者才是真正能发出去的收藏夹。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { getSkillConfig } from '../../src/skills/config.js';

const SKILL_ID = 'meme-taste';
const PREFIX = `${SKILL_ID}__`;

/** 与 skill.json 的 settings 保持一致（这里留一份是为了加载顺序和容错）。 */
const DEFAULTS = {
  enabled: true,
  maxPerHour: 3,
  maxPerDay: 10,
  hint: true,
  showRecords: true
};

const DIR = path.join(DATA_DIR, SKILL_ID);
const TASTE_FILE = path.join(DIR, 'taste.json');
const STATE_FILE = path.join(DIR, 'state.json');

/** 她自己的口味档案（写进系统提示，是她"自我认知"的一部分，不是给别人看的规则）。 */
const PROFILE_TEXT = `【我的表情品味】
我收表情包很挑，不是谁发什么我都收。我的口味大概是这样的：
- 我喜欢：软乎乎圆滚滚的东西、呆脸、笨拙但真诚的幽默、丑得很可爱的、小动物、吃的、动画表情（那种自己会动的）、一图就说清一件事的；
- 我不喜欢：恐怖和血腥、擦边和性暗示、骂人侮辱人的、刻意卖惨、糊到看不清的、要配大段文字才能看懂的；
- 我最看重的其实是"这张有没有真的被谁用对过"——一张图在群里被用得很准，比它本身画得好更讨我喜欢。
关于我自己的收藏习惯，我心里有数：
- 我收到的每一张，都来自群里已经出现过的图，我自己不会出去找；
- 收藏有额度，超了就等，不会赖着；
- 用的时候我优先挑合我口味的那几张，宁可少发、不可乱发；很贵的（情绪很满的）那几张我会舍不得用。`;

/** 注入到她"这一轮要想的东西"末尾的收藏机会提示。 */
const HINT_HEAD = '【表情品味·收藏机会】';
const HINT_TAIL = '- 想好了就调 `meme-taste__collect_sticker`（就是上面这个完整名字；messageId 用候选里的编号，note 写一句你为什么想收它）。';
const HINT_TAIL_NO_TOOL = '- 这张图我现在看不见（这会儿没有可用的看图工具），那就先别收，等看清了再说。';

const host = { api: null };
let log = () => {};
let warn = () => {};

// ─────────────────────────────────────────────── 小工具
function nowTs() {
  return Date.now();
}

function dayKey(ts = nowTs()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clean(s, max = 200) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function shortText(s, max = 40) {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function asText(m) {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

function trimArr(arr, keep, tsKey) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  list.sort((a, b) => num(b?.[tsKey], 0) - num(a?.[tsKey], 0));
  return list.slice(0, keep);
}

function recentN(list, n) {
  return (Array.isArray(list) ? list.slice() : []).slice(-n);
}

// ─────────────────────────────────────────────── 配置
function cfg() {
  try {
    // 心语宿主：manifest.settings 默认值 + 面板保存值，实时读（契约 §9）。
    return { ...DEFAULTS, ...(getSkillConfig(SKILL_ID) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function isOn() {
  if (cfg().enabled === false) return false;
  try {
    return host.api?.isSkillActive ? host.api.isSkillActive(SKILL_ID) !== false : true;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────── 数据读写（照 reminder / meme-story 的写法）
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`${path.basename(file)} 写盘失败：${e && e.message ? e.message : e}`);
    return false;
  }
}

/** ① 口味档案：我喜欢什么、不喜欢什么、挑过哪几张（含理由）。 */
function taste() {
  const t = readJson(TASTE_FILE, null);
  if (!t || typeof t !== 'object') return { likes: [], dislikes: [], collected: [], notes: [] };
  return {
    likes: Array.isArray(t.likes) ? t.likes : [],
    dislikes: Array.isArray(t.dislikes) ? t.dislikes : [],
    collected: Array.isArray(t.collected) ? t.collected : [],
    notes: Array.isArray(t.notes) ? t.notes : []
  };
}

function writeTaste(t) {
  return writeJson(TASTE_FILE, t);
}

/** ② 运行状态：算额度、去重、记住已经收藏过的图。 */
function state() {
  const s = readJson(STATE_FILE, null);
  const day = dayKey();
  if (!s || typeof s !== 'object') return { day, col: [], used: [], collected: [], reminded: {} };
  return {
    day: typeof s.day === 'string' ? s.day : day,
    col: Array.isArray(s.col) ? s.col : [],
    used: Array.isArray(s.used) ? s.used : [],
    collected: Array.isArray(s.collected) ? s.collected : [],
    reminded: s.reminded && typeof s.reminded === 'object' ? s.reminded : {}
  };
}

function writeState(s) {
  return writeJson(STATE_FILE, s);
}

// ─────────────────────────────────────────────── 额度
// 0 是有效值：设成 0 就等于"一张也不许收"。
function dayCount(s) {
  const today = dayKey();
  return s.col.filter((x) => x && x.day === today).length;
}

function hourCount(s) {
  const since = nowTs() - 3600 * 1000;
  return s.col.filter((x) => x && num(x.ts, 0) >= since).length;
}

function quota(conf, s) {
  const perHour = num(conf.maxPerHour, DEFAULTS.maxPerHour);
  const perDay = num(conf.maxPerDay, DEFAULTS.maxPerDay);
  const leftHour = Math.max(0, perHour - hourCount(s));
  const leftDay = Math.max(0, perDay - dayCount(s));
  return { perHour, perDay, leftHour, leftDay, left: Math.min(leftHour, leftDay) };
}

// ─────────────────────────────────────────────── 候选图
function imageOf(entry) {
  const list = Array.isArray(entry?.media) ? entry.media : [];
  return list.find((m) => m && m.kind === 'image' && (m.url || m.file)) || null;
}

/** 最近出现的、带图的消息（新的在前）。face 段不算图，所以自动被跳过。 */
function recentCandidates(store, chatKey, limit = 24) {
  const out = [];
  try {
    const recent = store.recent(chatKey, { limit }) || [];
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const e = recent[i];
      if (!e || e.self) continue;
      if (!imageOf(e)) continue;
      out.push({ entry: e, mid: String(e.mid ?? `#${e.id}`) });
      if (out.length >= 12) break;
    }
  } catch {
    // store 抽风：这一轮就当没有候选
  }
  return out;
}

// ─────────────────────────────────────────────── 消息注入
function markerKey(ctx) {
  return String(ctx?.sessionId || ctx?.chatKey || 'global');
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') return m;
  }
  return null;
}

function appendBlock(m, block) {
  if (!m) return false;
  if (typeof m.content === 'string') {
    m.content = m.content ? `${m.content}\n\n${block}` : block;
    return true;
  }
  if (Array.isArray(m.content)) {
    m.content.push({ type: 'text', text: `\n\n${block}` });
    return true;
  }
  m.content = block;
  return true;
}

function listText(items, empty) {
  return items.length ? items.map((x) => `  - ${x}`).join('\n') : `  - ${empty}`;
}

/** 工具表可能有三种形状：工具定义数组 / 定义对象 / 名字数组。 */
function toolAvailable(ctx, id) {
  const tools = ctx?.tools ?? ctx?.defs;
  if (!tools) return undefined; // 拿不到工具表就不断言，别把功能整个吞掉
  if (Array.isArray(tools)) {
    return tools.some((t) => t === id || t?.id === id || t?.name === id || t?.function?.name === id);
  }
  if (typeof tools === 'object') return Boolean(tools[id]);
  return undefined;
}

// ─────────────────────────────────────────────── 从理由里自己攒口味
const POSITIVE = {
  软: '软乎乎的东西',
  圆: '圆滚滚的造型',
  呆: '呆脸',
  傻: '傻乎乎',
  可爱: '可爱',
  丑: '丑萌',
  蠢: '蠢萌',
  怪: '怪得有意思',
  沙雕: '沙雕',
  尴尬: '尴尬感',
  真诚: '真诚',
  好笑: '好笑',
  开心: '开心的',
  委屈: '委屈巴巴',
  猫: '猫',
  狗: '狗',
  兔: '兔子',
  吃: '吃的',
  饭: '吃的',
  冷笑话: '冷笑话',
  动图: '会动的'
};

const DISLIKE_WORDS = ['恐怖', '血腥', '恶心', '擦边', '恶俗', '模糊', '要配字'];

function accumulate(t, ...texts) {
  const source = texts.map((x) => String(x ?? '')).join(' ');
  for (const kw of Object.keys(POSITIVE)) {
    if (source.includes(kw) && !t.likes.some((x) => (x.kw || x) === kw)) {
      t.likes = trimArr([...t.likes, { kw, ts: nowTs() }], 40, 'ts');
    }
  }
  for (const kw of DISLIKE_WORDS) {
    if (source.includes(kw) && !t.dislikes.some((x) => (x.kw || x) === kw)) {
      t.dislikes = trimArr([...t.dislikes, { kw, ts: nowTs() }], 40, 'ts');
    }
  }
}

function noteEvent(event) {
  const t = taste();
  if (event.kind === 'collected') {
    t.collected = trimArr([...t.collected, event], 80, 'ts');
    accumulate(t, event.reason);
  } else {
    t.notes = trimArr([...t.notes, event], 60, 'ts');
  }
  writeTaste(t);
}

// ─────────────────────────────────────────────── 钩子
const hooks = {
  'before-llm-messages': (ctx) => {
    try {
      const conf = cfg();
      if (conf.enabled === false || !isOn()) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      const st = state();
      const q = quota(conf, st);
      const key = markerKey(ctx);

      // ① 收藏机会：只在"真开着提示 + 她看得见图 + 还有额度 + 真有她没决定过的图"时插一次
      if (conf.hint !== false && ctx.visionEnabled !== false && q.left > 0) {
        const seen = Array.isArray(st.reminded[key]) ? st.reminded[key] : [];
        const seenSet = new Set(seen.map((x) => String(x)));
        const collectedSet = new Set(st.collected.map((x) => String(x.mid)));

        let cands = recentCandidates(ctx.store, ctx.chatKey);
        if (conf.showRecords !== false) {
          cands = cands.filter((c) => !collectedSet.has(String(c.mid)));
        }
        const fresh = cands.filter((c) => !seenSet.has(String(c.mid))).slice(0, 3);

        if (fresh.length) {
          const lines = [
            HINT_HEAD,
            `群里最近出现了几张我还没决定过的图（今天还能收藏 ${q.leftDay} 张，这个小时还能收藏 ${q.leftHour} 张）：`
          ];
          fresh.forEach((c, i) => {
            const ago = Math.max(0, Math.round((nowTs() - num(c.entry?.ts, nowTs())) / 1000));
            lines.push(`  候选 ${i + 1}】messageId=${c.mid}（${c.entry?.senderName || '有人'}发的，约 ${ago} 秒前）`);
          });

          if (conf.showRecords !== false) {
            const mine = recentN(taste().collected, 5);
            if (mine.length) {
              lines.push(
                '',
                '属于我的表情（已经收过的，不用再收）：',
                ...mine.map((c) => `  - ${shortText(c.reason || '（没写理由）', 30)}（messageId=${c.mid}）`)
              );
            }
          }

          // 用"核心收藏工具在不在宿主上"判断该告诉她哪句。心语宿主的权威来源是
          // api.tools.get（返回工具 spec，spec.execute 才是可执行入口）。
          const canCollect = Boolean(coreTool('collect_sticker')?.execute);
          lines.push(
            '',
            '- 这几张只有我看得见的时候才算数：先看一眼图，再决定。',
            '- 合我口味就收，不合就跳过；也可以全跳过——今天一张都不收也完全正常。',
            canCollect ? HINT_TAIL : HINT_TAIL_NO_TOOL
          );

          const target = lastUser(messages);
          if (target && appendBlock(target, lines.join('\n'))) {
            st.reminded[key] = [...seen, ...fresh.map((c) => String(c.mid))].slice(-80);
            writeState(st);
          }
        }
      }

      // ② 系统提示里补一句额度，让她对"今天还能收几张"有感觉
      const sys = messages.find((m) => m && m.role === 'system');
      if (sys && typeof sys.content === 'string') {
        const line =
          q.left > 0
            ? `（今天还能收藏 ${q.leftDay} 张，这个小时还能收藏 ${q.leftHour} 张）`
            : '（今天的收藏额度已经用完了，看到喜欢的也只能先记着，等明天再收）';
        if (!sys.content.includes(line)) sys.content = `${sys.content}\n${line}`;
      }
    } catch (e) {
      warn(`注入失败：${e && e.message ? e.message : e}`);
    }
  },

  'after-tool': (ctx) => {
    try {
      const name = String(ctx?.toolName || '');
      if (!name.startsWith(PREFIX)) return;

      const result = ctx.result || {};
      const text = typeof result.content === 'string' ? result.content : asText(result);
      const failed = Boolean(result.isError) || /^\s*错误/.test(text) || /"collected"\s*:\s*false/.test(text);
      const short = name.slice(PREFIX.length);
      // orchestrator 的 after-tool 载荷是 { ...skillContext, toolName, argsRaw, result, session }
      // —— 没有 args 对象，参数只有 JSON 字符串形式，必须自己解析（解析失败就当没有）。
      let args = ctx.args || {};
      if (typeof ctx.argsRaw === 'string' && ctx.argsRaw.trim()) {
        const parsed = safeJson(ctx.argsRaw, null);
        if (parsed && typeof parsed === 'object') args = parsed;
      } else if (typeof ctx.argsRaw === 'object' && ctx.argsRaw) {
        args = ctx.argsRaw;
      }

      if (short === 'collect_sticker') {
        if (failed) {
          log(`这次没收藏成功：${shortText(text, 80)}`);
          return;
        }
        const mid = String(args.messageId ?? '');
        const s = state();
        // 这个工具自己成功时会记账；钩子只在"这个 mid 还没记过"时才补记，
        // 否则同一次收藏会被记两次、额度被凭空扣掉一半。
        const already = !mid || s.collected.some((x) => String(x.mid) === mid);
        if (!already) {
          s.col.push({ ts: nowTs(), day: dayKey(), mid });
          s.col = trimArr(s.col, 200, 'ts');
          s.collected = trimArr([...s.collected, { mid, ts: nowTs() }], 200, 'ts');
          writeState(s);
        }

        const detail = parseObj(text);
        noteEvent({
          kind: 'collected',
          ts: nowTs(),
          mid,
          reason: clean(args.note ?? detail?.note ?? '', 120),
          emojiId: clean(detail?.emojiId ?? '', 40)
        });
        log(`收藏了一张${args.note ? `（${shortText(args.note, 30)}）` : ''}`);
        return;
      }

      if (short === 'send_sticker' && !failed) {
        const used = clean(args.stickerId ?? args.emojiId ?? '', 60);
        const s = state();
        s.used.push({ ts: nowTs(), stickerId: used });
        s.used = trimArr(s.used, 200, 'ts');
        writeState(s);
        noteEvent({ kind: 'sent', ts: nowTs(), stickerId: used });
        return;
      }

      if (failed) log(`她调了 ${short}，但没成功：${shortText(text, 80)}`);
    } catch (e) {
      warn(`记账失败：${e && e.message ? e.message : e}`);
    }
  }
};

function parseObj(text) {
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** 安全 JSON.parse：失败返回 fallback。 */
function safeJson(text, fallback = null) {
  try {
    const v = JSON.parse(String(text));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────── 她的自我认知（进系统提示）
export function promptSections(context) {
  try {
    if (!isOn()) return [];
    const conf = cfg();
    const q = quota(conf, state());
    const t = taste();
    const lines = [PROFILE_TEXT];

    if (t.likes.length) lines.push(`我最近偏上口的是：${recentN(t.likes.map((x) => x.kw || x), 6).join('、')}。`);
    if (t.dislikes.length) lines.push(`我明确不喜欢：${recentN(t.dislikes.map((x) => x.kw || x), 6).join('、')}。`);

    if (conf.showRecords !== false && t.collected.length) {
      lines.push(
        '我藏起来的这几张（都是我挑过的）：',
        ...recentN(t.collected, 6).map((c) => `  - ${shortText(c.reason || '（没写理由）', 40)}（messageId=${c.mid}）`)
      );
    } else {
      lines.push('我的收藏夹还空着 —— 目前还没有哪张图让我觉得"非它不可"。');
    }

    lines.push(
      q.left > 0
        ? `今天的额度还剩 ${q.leftDay} 张（这个小时还能 ${q.leftHour} 张），遇到真喜欢的就收，不用省。`
        : '今天的收藏额度已经满了，看见喜欢的也只能先记在心里，明天再说。'
    );

    return [
      {
        id: `${SKILL_ID}-profile`,
        title: '我的表情品味',
        priority: 62,
        content: lines.join('\n')
      }
    ];
  } catch (e) {
    warn(`生成口味档案失败：${e && e.message ? e.message : e}`);
    return [];
  }
}

/**
 * 取宿主核心工具的 spec（心语契约：api.tools.get(id) / ctx.tools.get(id) → {execute}）。
 * 优先用本轮 ctx 的工具表，退回 setup 时的 api.tools；两边都没有就返回 null。
 */
function coreTool(name, ctx) {
  for (const table of [ctx?.tools, host.api?.tools]) {
    try {
      const found = table?.get?.(name);
      if (found && typeof found.execute === 'function') return found;
    } catch {
      // 工具表取不到就当没有，走调用方的兜底提示
    }
  }
  return null;
}

/** 把核心工具包一层：按 id 去查"这个核心工具现在到底有没有、能不能用"。 */
function shimCore(name) {
  return async (ctx, args) => {
    const spec = coreTool(name, ctx);
    return spec ? spec.execute(ctx, args) : null;
  };
}

// ─────────────────────────────────────────────── 给自己看的档案
function showTaste() {
  const t = taste();
  const q = quota(cfg(), state());
  const lines = ['我的表情品味：', '▸ 收藏记录'];

  if (t.collected.length) {
    for (const c of recentN(t.collected, 10)) {
      const at = new Date(num(c.ts, nowTs()));
      const p = (n) => String(n).padStart(2, '0');
      lines.push(
        `  - messageId=${c.mid}｜${c.reason || '（没写理由）'}｜${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
      );
    }
  } else {
    lines.push('  - （还空着）');
  }

  lines.push('▸ 我自己琢磨出来的口味', listText(t.likes.map((x) => x.kw || x), '还没有'));
  lines.push('▸ 我不喜欢的', listText(t.dislikes.map((x) => x.kw || x), '还没有'));
  lines.push(`▸ 额度：今天还剩 ${q.leftDay} 张，这个小时还剩 ${q.leftHour} 张`);
  return lines.join('\n');
}

function recordTaste(kind, value) {
  const v = clean(value, 40);
  if (!v) return { content: `要告诉我一个「${kind === 'like' ? '偏爱的' : '不喜欢的'}」关键词呀。`, isError: true };

  const t = taste();
  const arr = kind === 'like' ? 'likes' : 'dislikes';
  const other = kind === 'like' ? 'dislikes' : 'likes';
  if (t[arr].some((x) => (x.kw || x) === v)) return { content: `记着呢 —— ${v} 已经在我口味档案里了。` };

  t[other] = t[other].filter((x) => (x.kw || x) !== v);
  t[arr] = trimArr([...t[arr], { kw: v, ts: nowTs() }], 40, 'ts');
  writeTaste(t);
  log(`口味档案更新：${kind === 'like' ? '偏爱' : '不喜欢'}「${v}」`);
  return {
    content: `记下了，我${kind === 'like' ? '偏上' : '不爱'}「${v}」。\n（口味档案：偏爱 ${t.likes.length} 条 / 不喜欢 ${t.dislikes.length} 条）`
  };
}

function forgetRecords() {
  const t = taste();
  const n = t.collected.length;
  t.collected = [];
  writeTaste(t);
  const s = state();
  s.collected = [];
  writeState(s);
  return { content: `收藏记录清空了（清掉 ${n} 条），口味偏好我留着。` };
}

// ─────────────────────────────────────────────── 入口
export function setup(api) {
  log = api?.log || (() => {});
  warn = api?.warn || (() => {});
  host.api = api;

  const conf = cfg();
  log(
    `表情品味已加载：收藏额度 ${num(conf.maxPerHour, DEFAULTS.maxPerHour)} 张/小时、${num(
      conf.maxPerDay,
      DEFAULTS.maxPerDay
    )} 张/天；她的收藏档案放在 DATA_DIR/${SKILL_ID}/`
  );

  api.registerTool({
    id: 'collect_sticker',
    name: '收藏表情',
    description:
      '按你自己的口味，决定要不要把群里某条消息里的图收进你的私人表情收藏夹。想收、且能说清为什么喜欢，才用这个工具；不想收就别调用。messageId 用消息里的编号（只认图片，纯文字消息收不了）。',
    category: 'sticker',
    icon: '⭐',
    // 核心收藏要下载图片（协议端/HTTP 都可能慢），给宿主工具超时留出余量。
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: ['integer', 'string'],
          description: '要收藏的那条消息的编号（提示里 messageId= 后面那个数）'
        },
        note: {
          type: 'string',
          description: '一句你为什么想收它（会进你的收藏档案，以后你自己看得到）'
        }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      if (cfg().enabled === false) return { content: '错误：表情品味已经被关掉了，不收表情。', isError: true };
      const mid = args?.messageId;
      if (mid === undefined || mid === null || String(mid).trim() === '') {
        return { content: '错误：得告诉我 messageId 是哪一条消息。', isError: true };
      }

      const q = quota(cfg(), state());
      if (q.left <= 0) {
        const why =
          q.leftDay <= 0
            ? `今天已经收藏了 ${q.perDay} 张`
            : `这个小时已经收藏了 ${q.perHour} 张`;
        return { content: `错误：${why}，先不收了 —— 等一会儿再挑。`, isError: true };
      }

      try {
        // 别把 `note: undefined` 透给核心 —— 核心收到的是 String(args.note ?? '')，
        // undefined 会被写成字面量 "undefined" 塞进 QQ 的表情描述里。没理由就不带这个键。
        const fwd = { messageId: mid };
        const noteText = typeof args?.note === 'string' ? args.note.trim() : '';
        if (noteText) fwd.note = noteText;
        const r = await shimCore('collect_sticker')(ctx, fwd);
        if (!r) {
          return {
            content: '错误：项目的收藏表情功能现在不可用（核心的收藏表情没挂上，通常是设置页里的「表情收藏」开关关着）。这一张先算了。',
            isError: true
          };
        }
        if (r.isError) return { content: String(r.content ?? '错误：收藏失败'), isError: true };

        const midStr = String(mid);
        const s = state();
        s.col.push({ ts: nowTs(), day: dayKey(), mid: midStr });
        s.col = trimArr(s.col, 200, 'ts');
        if (!s.collected.some((x) => String(x.mid) === midStr)) {
          s.collected = trimArr([...s.collected, { mid: midStr, ts: nowTs() }], 200, 'ts');
        }
        writeState(s);
        return r;
      } catch (e) {
        return { content: `错误：收藏没成功（${e && e.message ? e.message : e}）。`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'sticker_taste',
    name: '我的表情口味',
    description:
      '查看或调整你自己的表情口味档案：action=show 看你现在偏爱什么、不喜欢什么、收藏过什么、额度还剩几张；action=like 记下一条你偏爱的东西；action=dislike 记下一条你不喜欢的；action=forget 清空收藏记录（口味偏好保留）。',
    category: 'sticker',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'like', 'dislike', 'forget'],
          description: 'show=看一眼；like=记下偏爱；dislike=记下不喜欢；forget=清空收藏记录'
        },
        value: {
          type: 'string',
          description: 'action=like / dislike 时必填，一个短词，比如「丑萌」「恐怖」'
        }
      },
      required: ['action']
    },
    async execute(_ctx, args) {
      const action = String(args?.action || 'show');
      switch (action) {
        case 'like':
        case 'dislike':
          return recordTaste(action, args?.value);
        case 'forget':
          return forgetRecords();
        case 'show':
        default:
          return { content: showTaste() };
      }
    }
  });

  api.registerTool({
    id: 'sticker_my_stickers',
    name: '我的表情收藏',
    description:
      '查看你自己收藏夹里现在有哪些表情（可以按关键词找）。想看某一张的样子，就拿返回里的编号去调核心的看图工具。',
    category: 'sticker',
    icon: '🧺',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选关键词，按备注名筛一筛' },
        limit: { type: 'integer', description: '最多列几条，默认 20' }
      }
    },
    async execute(ctx, args) {
      const payload = {};
      const q = clean(args?.query ?? '', 30);
      if (q) payload.query = q;
      if (args?.limit !== undefined && args?.limit !== null) payload.limit = clamp(args.limit, 1, 50, 20);

      try {
        const r = await shimCore('list_stickers')(ctx, payload);
        if (!r) {
          return {
            content:
              '错误：看不到收藏夹（核心的"列出表情"现在没挂上）。你可以先用 meme-taste__sticker_taste 看我自己记的收藏档案。',
            isError: true
          };
        }
        const text = typeof r.content === 'string' ? r.content : asText(r);
        return { content: text || '收藏夹里现在是空的。', ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        return { content: `错误：列不出来（${e && e.message ? e.message : e}）。`, isError: true };
      }
    }
  });
}

/** 插件被卸载时清掉缓存（加载器支持 dispose）。 */
export function dispose() {
  host.api = null;
}

export { hooks };
