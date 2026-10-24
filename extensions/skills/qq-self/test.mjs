/**
 * qq-self 的离线自检：不连 QQ、不联网。
 *
 * 用 createService 的注入依赖（settings/globalConfig/now/validateUrl/onebot 都是桩），
 * 覆盖：默认设置、可见范围映射、冷却/去重/每日上限、参数校验、演练模式、
 * 改资料回读、以及 setup 注册的四个工具。
 *
 *   node tools/extensions-test.mjs --only qq-self
 */
import path from "node:path";
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";
import { createService } from "./index.js";

const STATE = (t) => path.join(t.tempDir(), "qq-self", "state.json");

function makeCtx({ onCall = null, selfId = 10001, onebot = null, overrides = {} } = {}) {
  const calls = [];
  const bot = onebot || {
    selfId,
    connected: true,
    selfInfo: { user_id: selfId, nickname: "小语" },
    async call(action, params = {}, timeout = 0) {
      calls.push({ action, params, timeout });
      return onCall ? onCall(action, params) : { ok: true };
    },
  };
  const ctx = {
    chatKey: "group:123456",
    selfId: String(selfId),
    onebot: bot,
    stickers: { find: () => null },
    store: { findByMid: () => null },
    ...overrides,
  };
  return { ctx, calls };
}

function makeService(t, settings = {}, { now = () => Date.now(), validateUrl = (u) => u, stateFile = null } = {}) {
  return createService({
    settings: () => ({ ...settings }),
    globalConfig: () => ({}),
    stateFile: stateFile || STATE(t),
    validateUrl,
    stickerPath: () => null,
    now,
    queue: new Map(),
  });
}

const json = (res) => JSON.parse(res.content);

export const cases = [
  {
    name: "默认设置与 get_self_state 基线",
    run: async (t) => {
      const clock = 1_700_000_000_000;
      const service = makeService(t, {}, { now: () => clock });
      const { ctx, calls } = makeCtx({
        onCall: (action) => {
          if (action === "get_stranger_info") return { nickname: "小语", long_nick: "签名", sex: "female" };
          if (action === "get_qzone_msg_list") return { total: 2, msglist: [] };
          return {};
        },
      });
      const data = json(await service.get_self_state(ctx));
      t.eq(data.ok, true, "ok");
      t.eq(data.selfId, "10001", "selfId");
      t.deepEq(data.settings, {
        autonomous: true,
        allowPublish: true,
        allowProfile: true,
        allowAvatar: true,
        defaultVisibility: "friends",
        postCooldownMinutes: 30,
        postDailyLimit: 6,
        profileCooldownMinutes: 60,
        maxChars: 600,
        dryRun: false,
      }, "设置默认值");
      t.eq(data.profile.nickname, "小语", "读到资料");
      t.eq(data.space.total, 2, "读到空间");
      t.eq(data.postsToday, 0, "今天还没发");
      t.deepEq(calls.map((c) => c.action), ["get_stranger_info", "get_qzone_msg_list"], "只读接口");
    },
  },
  {
    name: "可见范围映射（friends=4 / public=1 / self=64）",
    run: async (t) => {
      const service = makeService(t, { postCooldownMinutes: 0, postDailyLimit: 0 });
      const { ctx, calls } = makeCtx({ onCall: (action) => (action === "send_qzone_msg" ? { tid: "t-1" } : {}) });

      const pub = json(await service.publish_dynamic(ctx, { content: "第一条动态", visibility: "public" }));
      t.eq(pub.ok, true, "发布成功");
      t.eq(pub.visibility, "public", "回显可见范围");
      t.eq(pub.tid, "t-1", "带 tid");
      t.eq(calls[0].action, "send_qzone_msg", "调用空间发布接口");
      t.eq(calls[0].params.ugc_right, 1, "public = 1");

      const dft = json(await service.publish_dynamic(ctx, { content: "第二条动态" }));
      t.eq(dft.visibility, "friends", "默认可见范围 friends");
      t.eq(calls[1].params.ugc_right, 4, "friends = 4");

      const selfOnly = json(await service.publish_dynamic(ctx, { content: "只给自己看", visibility: "self" }));
      t.eq(selfOnly.visibility, "self", "self 可见");
      t.eq(calls[2].params.ugc_right, 64, "self = 64");
      t.eq(calls[2].params.content, "只给自己看", "正文原样");
    },
  },
  {
    name: "冷却、重复内容去重与每日上限",
    run: async (t) => {
      let clock = 1_700_000_000_000;
      const service = makeService(t, { postCooldownMinutes: 30, postDailyLimit: 6 }, { now: () => clock });
      const { ctx, calls } = makeCtx({ onCall: (action) => (action === "send_qzone_msg" ? { tid: "t-1" } : {}) });

      t.eq(json(await service.publish_dynamic(ctx, { content: "重复内容" })).ok, true, "第一次发布成功");
      const dup = json(await service.publish_dynamic(ctx, { content: "重复内容" }));
      t.eq(dup.duplicate, true, "相同内容识别为重复");
      t.eq(dup.ok, true, "重复不重发但返回已执行");
      t.eq(calls.filter((c) => c.action === "send_qzone_msg").length, 1, "重复内容没有第二次调用接口");

      const cold = json(await service.publish_dynamic(ctx, { content: "另一条" }));
      t.eq(cold.ok, false, "冷却期内失败");
      t.contains(String(cold.error), "操作太密", "冷却提示");
      t.eq(calls.filter((c) => c.action === "send_qzone_msg").length, 1, "冷却期内不调用接口");

      clock += 31 * 60 * 1000;
      t.eq(json(await service.publish_dynamic(ctx, { content: "另一条" })).ok, true, "冷却结束可再发");

      // 每日上限（新服务 + 单条上限）
      const limited = makeService(t, { postCooldownMinutes: 0, postDailyLimit: 1 }, { now: () => clock });
      const ctx2 = makeCtx({ onCall: (action) => (action === "send_qzone_msg" ? { tid: "t-2" } : {}) });
      t.eq(json(await limited.publish_dynamic(ctx2.ctx, { content: "今日第一条" })).ok, true, "第一条可发");
      const over = json(await limited.publish_dynamic(ctx2.ctx, { content: "今日第二条" }));
      t.eq(over.ok, false, "超过每日上限失败");
      t.contains(String(over.error), "今天已达到1条动态的设置上限", "上限提示");
    },
  },
  {
    name: "参数校验与图片来源限制",
    run: async (t) => {
      const service = makeService(t, {}, {
        validateUrl: (u) => {
          const host = new URL(u).hostname;
          if (/^(127\.|10\.|192\.168\.)/.test(host) || host === "localhost") throw new Error("不允许内网/本机图片地址");
          return u;
        },
      });
      const { ctx } = makeCtx();

      const empty = json(await service.publish_dynamic(ctx, { content: "   " }));
      t.eq(empty.ok, false, "空正文失败");
      t.contains(String(empty.error), "动态正文不能为空", "空正文提示");

      const long = json(await service.publish_dynamic(ctx, { content: "长".repeat(601) }));
      t.eq(long.ok, false, "超长正文失败");
      t.contains(String(long.error), "过长", "超长提示");

      const badVis = json(await service.publish_dynamic(ctx, { content: "正文", visibility: "everyone" }));
      t.eq(badVis.ok, false, "非法可见范围失败");
      t.contains(String(badVis.error), "可见范围只能是friends/public/self", "可见范围提示");

      const badNick = json(await service.update_profile(ctx, {}));
      t.eq(badNick.ok, false, "没给要改的字段失败");
      t.contains(String(badNick.error), "请提供要修改的资料", "资料提示");

      const ssrf = json(await service.publish_dynamic(ctx, { content: "带图", imageUrls: ["http://127.0.0.1/x.jpg"] }));
      t.eq(ssrf.ok, false, "内网图片被拒");
      t.contains(String(ssrf.error), "不允许内网/本机图片地址", "内网提示");

      const avatarMany = json(await service.set_avatar(ctx, { imageUrls: ["https://a.example/1.jpg", "https://a.example/2.jpg"] }));
      t.eq(avatarMany.ok, false, "头像必须恰好一张");
      t.contains(String(avatarMany.error), "头像需要明确指定一张图片", "头像数量提示");

      const tooMany = json(await service.set_avatar(ctx, {
        imageUrls: Array.from({ length: 10 }, (_, i) => `https://a.example/${i}.jpg`),
      }));
      t.eq(tooMany.ok, false, "超过 9 张被拒");
      t.contains(String(tooMany.error), "图片链接最多9张", "数量提示");
    },
  },
  {
    name: "演练模式只预览、不调用任何写入接口",
    run: async (t) => {
      const service = makeService(t, { dryRun: true });
      const { ctx, calls } = makeCtx();
      const res = json(await service.publish_dynamic(ctx, { content: "演练一下" }));
      t.eq(res.ok, true, "演练返回成功");
      t.eq(res.dryRun, true, "标记 dryRun");
      t.eq(res.action, "send_qzone_msg", "给出会调用的 action");
      t.eq(res.params.content, "演练一下", "给出会发的正文");
      t.eq(calls.length, 0, "没有碰任何接口");
    },
  },
  {
    name: "改资料：接口确认 + 回读校验 + selfInfo 只读兜底",
    run: async (t) => {
      const calls = [];
      const onebot = {
        selfId: 10001,
        connected: true,
        async call(action, params = {}) {
          calls.push({ action, params });
          if (action === "get_stranger_info") return { nickname: "新昵称", long_nick: "新签名", sex: "male" };
          return {};
        },
      };
      // 心语宿主把 selfInfo 暴露成只读 getter：扩展里的赋值必须被兜住，不能让工具失败。
      Object.defineProperty(onebot, "selfInfo", { get: () => ({ user_id: 10001, nickname: "旧昵称" }) });
      const { ctx } = makeCtx({ onebot });

      const service = makeService(t, { profileCooldownMinutes: 0 });
      const data = json(await service.update_profile(ctx, { nickname: "新昵称", signature: "新签名", sex: 1 }));
      t.eq(data.ok, true, "改资料成功");
      t.eq(data.acknowledged, true, "接口已确认");
      t.eq(data.verified, true, "回读校验通过");
      t.eq(data.readback.nickname, "新昵称", "回读昵称");
      t.eq(data.nicknameSyncError, false, "昵称回写未报错");
      t.deepEq(calls[0], { action: "set_qq_profile", params: { nickname: "新昵称", personal_note: "新签名", sex: 1 } }, "资料参数正确");
    },
  },
  {
    name: "setup 注册四个工具（id/名称/参数保持原样）",
    run: async (t) => {
      const host = createMockHost({ id: "qq-self", settings: {} });
      installTestRuntime({ dataDir: host.dataDir, settings: { "skills/qq-self": {} } });
      const mod = await import("./index.js");
      mod.setup(host.api);
      try {
        const ids = [...host.tools.keys()].sort();
        t.deepEq(ids, ["get_self_state", "publish_dynamic", "set_avatar", "update_profile"], "四个工具");
        t.eq(host.tools.get("get_self_state").name, "查看自己的空间与资料", "查看工具名");
        t.eq(host.tools.get("publish_dynamic").name, "自主发布QQ动态", "发布工具名");
        t.eq(host.tools.get("update_profile").name, "修改自己的QQ资料", "资料工具名");
        t.eq(host.tools.get("set_avatar").name, "修改自己的QQ头像", "头像工具名");
        t.deepEq(host.tools.get("publish_dynamic").parameters.required, ["content"], "发布必填 content");
        t.deepEq(host.tools.get("publish_dynamic").parameters.properties.visibility.enum, ["friends", "public", "self"], "可见范围枚举");

        const sections = mod.promptSections();
        t.eq(sections[0].id, "qq-self-live-policy", "动态提示词片段 id");
        t.contains(sections[0].content, "已授权", "默认自主授权文案");
        t.contains(sections[0].content, "friends", "默认可见范围文案");

        // 宿主关闭扩展会清空工具表，重新启用只调 activate()：应把工具补回来
        host.tools.clear();
        mod.activate();
        t.deepEq([...host.tools.keys()].sort(), ["get_self_state", "publish_dynamic", "set_avatar", "update_profile"], "重新启用后工具已补注册");

        // 宿主禁用→启用的正常语义：teardown 清工具，启用时重新走 setup —— 工具与动态提示词片段都要回来
        host.tools.clear();
        mod.setup(host.api);
        t.deepEq([...host.tools.keys()].sort(), ["get_self_state", "publish_dynamic", "set_avatar", "update_profile"], "重新 setup 后工具仍在");
        t.eq(mod.promptSections()[0].id, "qq-self-live-policy", "重新 setup 后动态提示词片段仍在");

        // manifest 的静态提示词片段 / 默认开关 / 权限（宿主重装时重新收集）
        const manifest = JSON.parse(t.fs.readFileSync(new URL("./skill.json", import.meta.url), "utf8"));
        t.eq(manifest.prompt.sections[0].id, "self-expression", "manifest 提示词片段还在");
        t.eq(manifest.enabledByDefault, false, "默认 disabled 不变");
        t.deepEq(manifest.permissions, [], "无联网权限声明不变");
      } finally {
        host.cleanup();
      }
    },
  },
];
