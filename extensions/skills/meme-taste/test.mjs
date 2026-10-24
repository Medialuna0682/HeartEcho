/**
 * meme-taste（表情品味）扩展测试 —— 全离线。
 *
 * 覆盖：before-llm-messages 的候选图注入（self/纯文字过滤、reminded 去重、
 * 收藏记录过滤、visionEnabled/hint/开关）、额度计算（0 有效、小时/天双闸门）、
 * 口味档案 like/dislike/forget/show/promptSections、collect_sticker 的失败路径
 * （核心工具缺失/返回错误/抛错/额度用尽）与 note 透传。
 *
 * 注意：入口在模块求值时就绑定了 DATA_DIR（compat 行为），所以测试必须
 * **先 installTestRuntime 再动态 import**，不能静态 import index.js。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";

const MANIFEST_DEFAULTS = {
  enabled: true,
  maxPerHour: 3,
  maxPerDay: 10,
  hint: true,
  showRecords: true
};

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "he-ext-meme-taste-"));
let extPromise = null;
let DATA_DIR = path.join(DATA_ROOT, "extensions");
let DIR = path.join(DATA_DIR, "meme-taste");
let TASTE_FILE = path.join(DIR, "taste.json");
let STATE_FILE = path.join(DIR, "state.json");

function loadExt() {
  if (!extPromise) {
    installTestRuntime({ dataDir: DATA_ROOT, settings: { "skills/meme-taste": { ...MANIFEST_DEFAULTS } } });
    extPromise = (async () => {
      const mod = await import("./index.js");
      const { DATA_DIR: resolved } = await import("../../src/config.js");
      DATA_DIR = resolved;
      DIR = path.join(DATA_DIR, "meme-taste");
      TASTE_FILE = path.join(DIR, "taste.json");
      STATE_FILE = path.join(DIR, "state.json");
      return mod;
    })();
  }
  return extPromise;
}

/** 设置走 compat 的 getSkillConfig（不是 mock 宿主的 api.config），实时生效。 */
function applySettings(settings = {}) {
  installTestRuntime({
    dataDir: DATA_DIR,
    settings: { "skills/meme-taste": { ...MANIFEST_DEFAULTS, ...settings } }
  });
}

function resetData() {
  fs.rmSync(DIR, { recursive: true, force: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

process.once("exit", () => {
  try {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function setupHost(t) {
  const mod = await loadExt();
  const host = createMockHost({ id: "meme-taste", dataDir: t.tempDir() });
  mod.setup(host.api);
  return { mod, host };
}

/** mock 宿主按裸 id 存工具，这里塞一个核心工具替身（覆盖同名扩展工具前先留引用）。 */
function installCore(host, id, impl) {
  const calls = [];
  host.tools.set(id, {
    id,
    name: `核心·${id}`,
    async execute(ctx, args) {
      calls.push({ ctx, args });
      return impl(ctx, args);
    }
  });
  return calls;
}

function imageMsg(id, { self = false, senderName = "群友", ts = Date.now(), url = "" } = {}) {
  return {
    id,
    mid: `m${id}`,
    messageId: `m${id}`,
    chatKey: "group:123456",
    senderId: self ? "10001" : "20002",
    senderName,
    text: "",
    self,
    ts,
    at: ts,
    media: [{ kind: "image", url: url || `https://example.test/${id}.png`, file: "" }]
  };
}

function textMsg(id, extra = {}) {
  return {
    id,
    mid: `m${id}`,
    messageId: `m${id}`,
    chatKey: "group:123456",
    senderId: "20002",
    senderName: "群友",
    text: "纯文字",
    self: false,
    ts: Date.now(),
    at: Date.now(),
    media: [],
    ...extra
  };
}

function freshMessages() {
  return [
    { role: "system", content: "系统提示" },
    { role: "user", content: "【未读信息】\n群友：你好呀" }
  ];
}

function seedState({ col = [], collected = [], reminded = {} } = {}) {
  writeJson(STATE_FILE, { day: todayKey(), col, used: [], collected, reminded });
}

export const cases = [
  {
    name: "候选图注入：只挑最近带图消息、跳过 self/纯文字、一次 3 条且不重复提醒",
    run: async (t) => {
      resetData();
      applySettings();
      const { mod, host } = await setupHost(t);

      host.setMessages([
        imageMsg(1),
        imageMsg(2, { self: true, senderName: "小语" }),
        textMsg(3),
        imageMsg(4),
        imageMsg(5),
        imageMsg(6),
        imageMsg(7)
      ]);

      const messages = freshMessages();
      const ctx = host.ctx({ messages, sessionId: "s1" });
      mod.hooks["before-llm-messages"](ctx);

      const userText = messages[1].content;
      t.contains(userText, "【表情品味·收藏机会】");
      t.contains(userText, "messageId=m7", "最新的带图消息应排第一");
      t.contains(userText, "messageId=m6");
      t.contains(userText, "messageId=m5");
      t.notContains(userText, "messageId=m4", "一次最多递 3 张候选");
      t.notContains(userText, "messageId=m2", "自己发的图不算候选");
      t.notContains(userText, "messageId=m3", "纯文字消息没有图");
      t.contains(userText, "今天还能收藏 10 张，这个小时还能收藏 3 张");
      t.contains(messages[0].content, "（今天还能收藏 10 张，这个小时还能收藏 3 张）", "系统提示里应补额度");

      t.deepEq(readJson(STATE_FILE).reminded.s1, ["m7", "m6", "m5"], "提醒过的编号应记下");

      // 同一 session 第二轮：提醒过的 3 张不再重复，只递剩下没决定过的；额度行仍然补
      const again = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: again, sessionId: "s1" }));
      t.notContains(again[1].content, "messageId=m7", "提醒过的图不应再递");
      t.contains(again[1].content, "messageId=m4", "还没提醒过的候选继续递");
      t.contains(again[0].content, "今天还能收藏");

      // 全部候选都提醒过之后，这一轮就不再插候选清单
      const exhausted = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: exhausted, sessionId: "s1" }));
      t.notContains(exhausted[1].content, "【表情品味·收藏机会】");

      // 已收藏的图默认不再当候选，并列出"属于我的表情"
      writeJson(TASTE_FILE, { likes: [], dislikes: [], collected: [{ mid: "m7", reason: "猫猫", ts: Date.now() }], notes: [] });
      seedState({ collected: [{ mid: "m7", ts: Date.now() }] });
      const filtered = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: filtered, sessionId: "s2" }));
      t.notContains(filtered[1].content, "候选 1】messageId=m7", "已收藏的图应被 showRecords 过滤");
      t.contains(filtered[1].content, "候选 1】messageId=m6");
      t.contains(filtered[1].content, "候选 3】messageId=m4");
      t.contains(filtered[1].content, "属于我的表情");
      t.contains(filtered[1].content, "猫猫");

      // showRecords=false：不按收藏历史过滤，也不列收藏记录
      applySettings({ showRecords: false });
      const allAgain = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: allAgain, sessionId: "s3" }));
      t.contains(allAgain[1].content, "messageId=m7", "关掉 showRecords 后不再按历史过滤");
      t.notContains(allAgain[1].content, "属于我的表情");

      // visionEnabled=false：看不见图就不递候选（额度提示仍在）
      applySettings();
      resetData();
      const blind = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: blind, sessionId: "s4", visionEnabled: false }));
      t.notContains(blind[1].content, "【表情品味·收藏机会】");
      t.contains(blind[0].content, "今天还能收藏");

      // hint=false：主动浏览关掉 → 不递候选
      applySettings({ hint: false });
      resetData();
      const noHint = freshMessages();
      mod.hooks["before-llm-messages"](host.ctx({ messages: noHint, sessionId: "s5" }));
      t.notContains(noHint[1].content, "【表情品味·收藏机会】");

      // enabled=false：整段钩子停用，promptSections 也返回空
      applySettings({ enabled: false });
      assertDisabled(t, mod, host);
    }
  },
  {
    name: "额度：小时/天双闸门、0 是有效值、成功收藏后扣减",
    run: async (t) => {
      resetData();
      applySettings({ maxPerHour: 3, maxPerDay: 4 });
      const { host } = await setupHost(t);
      const show = host.tools.get("sticker_taste");
      const ownCollect = host.tools.get("collect_sticker");

      const now = Date.now();
      seedState({
        col: [
          { ts: now - 1000, day: todayKey(), mid: "a" },
          { ts: now - 2 * 3600 * 1000, day: todayKey(), mid: "b" }
        ]
      });

      let out = await show.execute(host.ctx(), { action: "show" });
      t.contains(out.content, "今天还剩 2 张，这个小时还剩 2 张");

      const coreCalls = installCore(host, "collect_sticker", async () => ({ content: JSON.stringify({ status: "ok", id: 1 }) }));
      out = await ownCollect.execute(host.ctx(), { messageId: "m9", note: "软" });
      t.ok(!out.isError);
      t.eq(coreCalls.length, 1, "额度内应调用核心收藏工具");
      t.eq(coreCalls[0].args.messageId, "m9");
      t.eq(coreCalls[0].args.note, "软");
      out = await show.execute(host.ctx(), { action: "show" });
      t.contains(out.content, "今天还剩 1 张，这个小时还剩 1 张", "成功收藏后两项额度都扣 1");

      // 天额度用尽
      seedState({
        col: [
          { ts: now - 4000, day: todayKey(), mid: "a" },
          { ts: now - 3000, day: todayKey(), mid: "b" },
          { ts: now - 2000, day: todayKey(), mid: "c" },
          { ts: now - 1000, day: todayKey(), mid: "d" }
        ]
      });
      out = await ownCollect.execute(host.ctx(), { messageId: "m10" });
      t.ok(out.isError === true);
      t.contains(out.content, "今天已经收藏了 4 张");
      t.eq(coreCalls.length, 1, "额度用尽时不应调用核心工具");

      // 0 是有效值：maxPerDay=0
      applySettings({ maxPerHour: 3, maxPerDay: 0 });
      seedState({ col: [] });
      out = await ownCollect.execute(host.ctx(), { messageId: "m11" });
      t.ok(out.isError === true);
      t.contains(out.content, "今天已经收藏了 0 张", "0 应当作有效额度而不是回落默认值");

      // 0 是有效值：maxPerHour=0
      applySettings({ maxPerHour: 0, maxPerDay: 10 });
      out = await ownCollect.execute(host.ctx(), { messageId: "m12" });
      t.ok(out.isError === true);
      t.contains(out.content, "这个小时已经收藏了 0 张");
    }
  },
  {
    name: "口味档案：like/dislike 互斥搬家、forget 只清记录、promptSections 档案",
    run: async (t) => {
      resetData();
      applySettings();
      const { mod, host } = await setupHost(t);
      const tasteTool = host.tools.get("sticker_taste");

      let out = await tasteTool.execute(host.ctx(), { action: "show" });
      t.contains(out.content, "我的表情品味：");
      t.contains(out.content, "（还空着）");
      t.contains(out.content, "额度：今天还剩 10 张，这个小时还剩 3 张");

      out = await tasteTool.execute(host.ctx(), { action: "like", value: "丑萌" });
      t.contains(out.content, "记下了");
      t.contains(out.content, "偏爱 1 条");
      t.deepEq(readJson(TASTE_FILE).likes.map((x) => x.kw), ["丑萌"]);

      out = await tasteTool.execute(host.ctx(), { action: "dislike", value: "恐怖" });
      t.contains(out.content, "不喜欢 1 条");
      t.deepEq(readJson(TASTE_FILE).dislikes.map((x) => x.kw), ["恐怖"]);

      out = await tasteTool.execute(host.ctx(), { action: "dislike", value: "丑萌" });
      t.contains(out.content, "偏爱 0 条 / 不喜欢 2 条");
      let saved = readJson(TASTE_FILE);
      t.deepEq(saved.likes, [], "同一个词改成 dislike 后应从 likes 移除");
      t.deepEq(saved.dislikes.map((x) => x.kw).sort(), ["丑萌", "恐怖"].sort());

      out = await tasteTool.execute(host.ctx(), { action: "like", value: "   " });
      t.ok(out.isError === true);
      t.contains(out.content, "要告诉我一个");

      writeJson(TASTE_FILE, {
        likes: [{ kw: "圆滚滚", ts: Date.now() }],
        dislikes: [{ kw: "恐怖", ts: Date.now() }],
        collected: [{ mid: "m1", reason: "软软的猫", ts: Date.now() }],
        notes: [{ kind: "sent", ts: Date.now(), stickerId: "1" }]
      });
      seedState({ collected: [{ mid: "m1", ts: Date.now() }] });

      out = await tasteTool.execute(host.ctx(), { action: "forget" });
      t.contains(out.content, "清掉 1 条");
      saved = readJson(TASTE_FILE);
      t.deepEq(saved.collected, [], "forget 只清收藏记录");
      t.deepEq(saved.likes.map((x) => x.kw), ["圆滚滚"], "口味偏好要留着");
      t.deepEq(saved.dislikes.map((x) => x.kw), ["恐怖"]);
      t.deepEq(readJson(STATE_FILE).collected, [], "state 里的已收藏去重表也清掉");

      out = await tasteTool.execute(host.ctx(), { action: "show" });
      t.contains(out.content, "（还空着）");
      t.contains(out.content, "圆滚滚");

      const sections = mod.promptSections({});
      t.eq(sections.length, 1);
      t.eq(sections[0].id, "meme-taste-profile");
      t.eq(sections[0].priority, 62);
      t.contains(sections[0].content, "【我的表情品味】");
      t.contains(sections[0].content, "我最近偏上口的是：圆滚滚");
      t.contains(sections[0].content, "我的收藏夹还空着");
      t.contains(sections[0].content, "今天的额度还剩");
    }
  },
  {
    name: "collect 失败路径：核心缺失/核心报错/抛错/额度用尽，note 不透传 undefined",
    run: async (t) => {
      resetData();
      applySettings();
      const { host } = await setupHost(t);
      const ownCollect = host.tools.get("collect_sticker");
      const ownList = host.tools.get("sticker_my_stickers");
      t.ok(ownCollect && typeof ownCollect.execute === "function");
      t.eq(ownCollect.timeoutMs, 60000, "核心收藏要下载图片，需高于宿主默认 30s");
      t.ok(ownList && typeof ownList.execute === "function");

      // 核心工具缺失（mock 宿主按裸 id 存工具，先删掉同名扩展工具模拟核心没挂上）
      host.tools.delete("collect_sticker");
      let out = await ownCollect.execute(host.ctx(), { messageId: "m1" });
      t.ok(out.isError === true);
      t.contains(out.content, "核心的收藏表情没挂上");

      out = await ownCollect.execute(host.ctx(), {});
      t.ok(out.isError === true);
      t.contains(out.content, "得告诉我 messageId");

      applySettings({ enabled: false });
      out = await ownCollect.execute(host.ctx(), { messageId: "m1" });
      t.ok(out.isError === true);
      t.contains(out.content, "已经被关掉了");

      applySettings();
      let coreCalls = installCore(host, "collect_sticker", async () => ({
        content: "错误：这条消息里没有图片（只认图片消息）。",
        isError: true
      }));
      out = await ownCollect.execute(host.ctx(), { messageId: "m404" });
      t.ok(out.isError === true);
      t.contains(out.content, "没有图片");
      t.eq(readJson(STATE_FILE), null, "核心失败时不应记账（state.json 还没生成）");

      coreCalls = installCore(host, "collect_sticker", async () => {
        throw new Error("downloader boom");
      });
      out = await ownCollect.execute(host.ctx(), { messageId: "m405" });
      t.ok(out.isError === true);
      t.contains(out.content, "收藏没成功");
      t.contains(out.content, "downloader boom");

      // note 只在有内容时透传；undefined 不能变成字面量 "undefined"
      coreCalls = installCore(host, "collect_sticker", async () => ({ content: JSON.stringify({ status: "ok", id: 2 }) }));
      out = await ownCollect.execute(host.ctx(), { messageId: "m406" });
      t.ok(!out.isError);
      t.ok(!("note" in coreCalls[0].args), "没有理由时不应把 note 键透给核心");
      out = await ownCollect.execute(host.ctx(), { messageId: "m407", note: "  软软的猫  " });
      t.ok(!out.isError);
      t.eq(coreCalls[1].args.note, "软软的猫", "note 应 trim 后透传");
      t.eq(readJson(STATE_FILE).collected.length, 2, "成功收藏才写 state.collected");

      // 额度用尽时不碰核心
      seedState({
        col: Array.from({ length: 10 }, (_, i) => ({ ts: Date.now() - i * 1000, day: todayKey(), mid: `x${i}` }))
      });
      const before = coreCalls.length;
      out = await ownCollect.execute(host.ctx(), { messageId: "m408" });
      t.ok(out.isError === true);
      t.contains(out.content, "今天已经收藏了 10 张");
      t.eq(coreCalls.length, before, "额度校验应在调用核心之前");

      // list_stickers：核心缺失 → 提示；核心可用 → 原样返回
      host.tools.delete("list_stickers");
      out = await ownList.execute(host.ctx(), {});
      t.ok(out.isError === true);
      t.contains(out.content, "看不到收藏夹");
      installCore(host, "list_stickers", async () => ({ content: "收藏夹（最近 1 张）：\n#1｜10-01 10:00｜丑萌" }));
      out = await ownList.execute(host.ctx(), { query: "丑", limit: 999 });
      t.ok(!out.isError);
      t.contains(out.content, "收藏夹（最近 1 张）");
    }
  }
];

/** enabled=false 的最后一段：钩子不写文件，promptSections 为空。 */
function assertDisabled(t, mod, host) {
  resetData();
  const messages = freshMessages();
  mod.hooks["before-llm-messages"](host.ctx({ messages, sessionId: "s6" }));
  t.notContains(messages[1].content, "【表情品味·收藏机会】");
  t.notContains(messages[0].content, "今天还能收藏");
  t.deepEq(mod.promptSections({}), [], "关掉 enabled 后不再注入口味档案");
  t.eq(readJson(STATE_FILE), null, "关掉后钩子不应写 state.json");
}
