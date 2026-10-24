// qzone 技能测试（不联网、不连 QQ、不读写真实数据目录）。
//
// 覆盖：
//   · 安全边界：时政词表、群聊/他人隐私兜底、图床白名单（含 memecub 图床）
//   · comments：固定 HTML 样本的顶层评论 + 楼中楼解析、feed 列表解析
//   · meme：标题解析、图库关键词匹配、占位图排除、base64 图片源
//   · state：发布配额/最小间隔/冷却（纯逻辑），评论已回/已看去重落盘
//   · 工具行为：发说说（ugc_right=4、base64 配图、状态落盘）、时政/隐私拒发、
//     评论只回自己说说 & 一条只回一次 & 顶层 @ 回复
//   · 钩子：发说说/查评论提醒 + 安静时段静音 + 节流
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createMockHost } from "../../../tools/extension-harness.mjs";
import { DATA_DIR } from "../../src/config.js";
import { setup, hooks } from "./index.js";
import { checkContent, mentionsPersonOrChat, isAllowedImageUrl, blockedWordCount } from "./lib/safe-topic.js";
import { fetchHotTopics } from "./lib/hot.js";
import { parseComments, postsFromFeeds } from "./lib/comments.js";
import { parseTitle, pickMemes } from "./lib/meme.js";
import { isMemecubImageUrl, base64SourceFromFile, cachedWebImage } from "./lib/meme-search.js";
import { QzoneState } from "./lib/state.js";

const DEFAULTS = {
  maxPerWeek: 3,
  minGapDays: 2,
  cooldownHours: 18,
  noticeGapHours: 6,
  commentNoticeGapMin: 360,
  memeCooldownDays: 7,
  webMemeCount: 6,
  consolePort: 3210,
  webMemecub: 1,
  originalRatio: 0.35,
  // 测试里关掉安静时段，否则凌晨跑测试会得到「现在是凌晨」而不是被测的那条错误
  quietHours: ""
};

function newHost(overrides = {}) {
  return createMockHost({ id: "qzone", settings: { ...DEFAULTS, ...overrides } });
}

/** 一张尺寸合格（300×200）的假 PNG：imageSize 只读文件头，够过质量闸。 */
function fakePng(w = 300, h = 200) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  buf.write("IDAT", 28, "ascii");
  return buf;
}

function cacheKeyOf(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

/** 固定样本：一条顶层评论 + 一条楼中楼（和 lib/comments.js 头部记录的真实结构一致）。 */
const COMMENTS_HTML = `<div class="comments-list ">
  <li class="comments-item bor3" data-type="commentroot" data-tid="19" data-uin="20002" data-nick="群友A" data-who="1">
    <div class="comments-item-bd">
      <div class="comments-content">
        <a class="nickname ">群友A</a>&nbsp; : 测试
        <div class="comments-op">
          <span class=" ui-mr10 state" > 22:24 </span>
          <a class="act-reply" data-param="tid=19">回复</a>
        </div>
      </div>
    </div>
    <div class="comments-list mod-comments-sub">
      <ul>
        <li class="comments-item bor3" data-type="replyroot" data-tid="1" data-uin="20002" data-nick="群友A" data-who="1">
          <div class="comments-item-bd">
            <div class="comments-content">
              <a class="nickname">群友A</a> 回复 群友A : 抓包测试
              <div class="comments-op"><span class=" ui-mr10 state" > 22:25 </span></div>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </li>
</div>`;

const SELF_FEED = {
  uin: 10001,
  nickname: "小语",
  time: 1700000000,
  key: "POST1",
  html: COMMENTS_HTML
};

const OTHER_FEED = {
  uin: 30003,
  nickname: "别人",
  time: 1700000001,
  key: "POSTX",
  html: COMMENTS_HTML
};

export const cases = [
  {
    name: "manifest 资产与 6 个工具注册",
    run: async (t) => {
      const manifest = JSON.parse(fs.readFileSync(new URL("./skill.json", import.meta.url), "utf8"));
      t.eq(manifest.id, "qzone");
      t.eq(manifest.name, "QQ空间");
      t.deepEq(manifest.permissions, ["web_fetch", "onebot"]);
      t.eq(manifest.settings.maxPerWeek, 3);
      t.eq(manifest.settings.minGapDays, 2);
      t.eq(manifest.settings.cooldownHours, 18);
      t.eq(manifest.settings.webMemecub, 1);
      t.eq(manifest.prompt.sections[0].id, "qzone-guide");

      const host = newHost();
      try {
        setup(host.api);
        t.deepEq(
          [...host.tools.keys()].sort(),
          [
            "fetch_qzone_topics",
            "pick_qzone_meme",
            "publish_qzone_post",
            "qzone_check_comments",
            "qzone_reply_comment",
            "qzone_status"
          ]
        );
        // 心语宿主约定：工具自己声明执行超时 / 结果上限（不写回上游契约）
        t.eq(host.tools.get("fetch_qzone_topics").timeoutMs, 40000);
        t.eq(host.tools.get("pick_qzone_meme").timeoutMs, 120000);
        t.eq(host.tools.get("publish_qzone_post").timeoutMs, 180000);
        t.eq(host.tools.get("qzone_check_comments").timeoutMs, 40000);
        t.eq(host.tools.get("qzone_check_comments").maxResultChars, 20000);
        t.eq(host.tools.get("qzone_reply_comment").timeoutMs, 120000);

        const status = JSON.parse((await host.tools.get("qzone_status").execute(host.ctx(), {})).content);
        t.eq(status.visibility, "好友可见");
        t.eq(status.maxPerWeek, 3);
        t.eq(status.canPostNow, true);
        t.eq(status.stateModule, "正常");
        t.ok(status.blockedWords > 50, "时政词表应有一定规模");
        t.eq(host.calls.onebot.length, 0);
      } finally {
        host.cleanup();
      }
    }
  },

  {
    name: "安全闸门·时政/灾难词表硬拦截",
    run: async (t) => {
      const cases = ["国庆升旗仪式", "某地发生地震事故", "台湾问题", "股市崩盘了", "宗教信仰"];
      for (const text of cases) {
        const r = checkContent(text);
        t.eq(r.ok, false, `应拦截「${text}」`);
        t.ok(r.hit, `应给出命中的词「${text}」`);
      }
      const okCases = ["今天在游戏里摸了会儿鱼，爽", "这个新番的作画好离谱", "DeepSeek娘今天也很可爱"];
      for (const text of okCases) {
        const r = checkContent(text);
        t.eq(r.ok, true, `不应拦截「${text}」`);
        t.eq(r.hit, null);
      }
      t.eq(checkContent(null).ok, true);
      t.ok(blockedWordCount() > 50);
    }
  },

  {
    name: "安全闸门·群聊内容/他人痕迹兜底拦截",
    run: async (t) => {
      const blocked = ["刚才群里有人说这个", "朋友找我聊了会天，说他最近在准备考试", "@群友A 你好", "群里聊过的那个梗"];
      for (const text of blocked) {
        t.ok(mentionsPersonOrChat(text), `应拦住「${text}」`);
      }
      const allowed = ["作者说做了大半年", "我也想说说这个游戏", "这条是技能自动发的回复测试", "今天打游戏输麻了"];
      for (const text of allowed) {
        t.eq(mentionsPersonOrChat(text), null, `不应误杀「${text}」`);
      }
      t.eq(mentionsPersonOrChat(null), null);
    }
  },

  {
    name: "图床白名单（保留边界，只放行已确认图床）",
    run: async (t) => {
      t.eq(isAllowedImageUrl("https://img.aigengtu.com/meme/1001.webp"), true);
      t.eq(isAllowedImageUrl("https://gpic.code-nav.cn/abc/def.webp"), true);
      t.eq(isAllowedImageUrl("http://127.0.0.1:3210/api/qzone-img/abc"), false, "本机中转已随宿主移除，不再放行");
      t.eq(isAllowedImageUrl("file:///C:/Windows/win.ini"), false);
      t.eq(isAllowedImageUrl("https://evil.example.com/a.png"), false);
      t.eq(isAllowedImageUrl("javascript:alert(1)"), false);
      t.eq(isAllowedImageUrl(""), false);
      t.eq(isMemecubImageUrl("https://gpic.code-nav.cn/abc/def.webp"), true);
      t.eq(isMemecubImageUrl("https://img.aigengtu.com/meme/1.webp"), false);
      t.eq(isMemecubImageUrl("不是URL"), false);
    }
  },

  {
    name: "选题源：网络只走注入的 fetch / 题材+时政双过滤",
    run: async (t) => {
      const raw = {
        code: 0,
        data: {
          list: [
            { title: "新游戏发售了，玩家集体请假", desc: "笑死", tname: "单机游戏" },
            { title: "某地突发洪水事故", desc: "", tname: "单机游戏" },
            { title: "美国大选最新消息", desc: "", tname: "数码" },
            { title: "今天吃什么", desc: "", tname: "时事" },
            { title: "这个动画作画崩了", desc: "真的", tname: "动画" }
          ]
        }
      };
      const calls = [];
      const fakeFetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => raw };
      };
      const r = await fetchHotTopics(fakeFetch, { limit: 10 });
      t.deepEq(
        r.topics.map((x) => x.标题),
        ["新游戏发售了，玩家集体请假", "这个动画作画崩了"]
      );
      t.contains(calls[0].url, "api.bilibili.com", "热榜只允许从注入的 fetch 出口请求");
      t.ok(calls[0].init && calls[0].init.headers && typeof calls[0].init.headers["User-Agent"] === "string");
      t.ok(calls[0].init.signal, "请求应带超时 signal");

      const none = await fetchHotTopics(
        async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ title: "社会新闻", tname: "社会" }] } }) }),
        { limit: 3 }
      );
      t.eq(none.topics.length, 0);
      t.ok(none.error, "全被过滤掉时应如实报告，不要硬凑选题");

      const riskControl = await fetchHotTopics(async () => ({ ok: true, status: 200, json: async () => ({ code: -352, data: null }) }), { limit: 3 });
      t.contains(riskControl.error, "-352");
    }
  },

  {
    name: "comments：顶层评论 + 楼中楼解析 / feed 解析",
    run: async (t) => {
      const list = parseComments(COMMENTS_HTML);
      t.eq(list.length, 2);
      t.deepEq(
        { tid: list[0].tid, uin: list[0].uin, nick: list[0].nick, text: list[0].text, time: list[0].time, type: list[0].type, parentTid: list[0].parentTid },
        { tid: "19", uin: "20002", nick: "群友A", text: "测试", time: "22:24", type: "commentroot", parentTid: null }
      );
      t.deepEq(
        { tid: list[1].tid, type: list[1].type, parentTid: list[1].parentTid, replyToNick: list[1].replyToNick, text: list[1].text },
        { tid: "1", type: "replyroot", parentTid: "19", replyToNick: "群友A", text: "抓包测试" }
      );
      // 容错：坏输入返回空数组而不是抛错
      t.deepEq(parseComments(""), []);
      t.deepEq(parseComments(null), []);
      t.deepEq(parseComments("<div>没有评论</div>"), []);

      const posts = postsFromFeeds([SELF_FEED, OTHER_FEED]);
      t.eq(posts.length, 2);
      t.eq(posts[0].tid, "POST1");
      t.eq(posts[0].ownerUin, "10001");
      t.eq(posts[0].ownerNick, "小语");
      t.eq(posts[0].comments.length, 2);
      // 没 key 时从 html 的 data-tid 兜底
      const posts2 = postsFromFeeds([{ uin: 1, html: '<li data-tid="FALLBACK">x</li>' }]);
      t.eq(posts2[0].tid, "FALLBACK");
    }
  },

  {
    name: "meme：标题解析 / 关键词匹配 / 占位图与坏图剔除",
    run: async (t) => {
      t.deepEq(parseTitle("DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包"), { label: "真当我是便宜货啊", desc: "气鼓鼓" });
      t.deepEq(parseTitle("DeepSeek娘下班瘫家玩手机快乐摸鱼表情包"), { label: "", desc: "下班瘫家玩手机快乐摸鱼" });
      t.eq(parseTitle("DeepSeek娘表情包"), null, "纯占位标题应剔除");
      t.eq(parseTitle("DeepSeek娘『1000382598』表情包"), null, "元数据台词应剔除");
      t.eq(parseTitle(""), null);

      const gallery = {
        gallery: {
          DeepSeek娘: {
            name: "DeepSeek娘",
            images: [
              { name: "DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包", original: "https://img.aigengtu.com/meme/1001.webp" },
              { name: "DeepSeek娘下班瘫家玩手机快乐摸鱼表情包", original: "https://img.aigengtu.com/meme/1002.webp" },
              { name: "DeepSeek娘表情包", original: "https://img.aigengtu.com/meme/1003.webp" },
              { name: "坏图", original: "https://evil.example.com/meme/1004.webp" }
            ]
          }
        }
      };
      const fakeFetch = async (url) => {
        t.contains(String(url), "aigengtu.com/gallery-index.json", "只允许从图库索引取数据");
        return { ok: true, status: 200, json: async () => gallery };
      };

      const hit = await pickMemes(fakeFetch, { keyword: "摸鱼", limit: 5, digest: true });
      t.eq(hit.matchedKeyword, true);
      t.eq(hit.total, 3, "非图床域名应被剔除");
      t.eq(hit.items.length, 1);
      t.contains(hit.items[0].desc, "摸鱼");
      t.eq(hit.items[0].placeholder, false);
      t.ok(Array.isArray(hit.vocabulary) && hit.vocabulary.length >= 1, "应给出图库真实标签");

      const miss = await pickMemes(fakeFetch, { keyword: "这个词图库里肯定没有", limit: 5, digest: true });
      t.eq(miss.matchedKeyword, false, "没命中就明确告知，不许静默退回全库");
      t.eq(miss.items.length, 0);
      t.ok(Array.isArray(miss.vocabulary));

      const browse = await pickMemes(fakeFetch, { limit: 10 });
      t.eq(browse.items.length, 3, "不传关键词时占位图也在候选池里");
    }
  },

  {
    name: "meme：本地缓存命中 / base64 图片源",
    run: async (t) => {
      const dir = t.tempDir();
      const png = fakePng();
      const url = "https://gpic.code-nav.cn/abc/def.webp";
      t.eq(cachedWebImage(url, dir), null, "空缓存不应命中");

      fs.writeFileSync(path.join(dir, cacheKeyOf(url) + ".webp"), png);
      const hit = cachedWebImage(url, dir);
      t.ok(hit && hit.file.endsWith(cacheKeyOf(url) + ".webp"), "挑图阶段下载过的图应命中本地缓存，避免重复下载");

      const source = base64SourceFromFile(hit.file);
      t.ok(source.startsWith("base64://"), "OneBot 图片源应为 base64://（SnowLuma send_qzone_msg 支持）");
      t.ok(Buffer.from(source.slice("base64://".length), "base64").equals(png), "base64 内容应与原文件一致");
      t.throws(() => base64SourceFromFile(path.join(dir, "不存在.png")), "读不到文件应抛错");
    }
  },

  {
    name: "state：评论已回/已看去重落盘（重启不丢）",
    run: async (t) => {
      // 契约：默认状态目录 = DATA_DIR/qzone（DATA_DIR = <心语数据目录>/extensions）
      t.eq(path.basename(DATA_DIR), "extensions");
      t.eq(new QzoneState().dir, path.join(DATA_DIR, "qzone"), "默认状态目录应落在扩展数据目录下，不写扩展包目录");

      const dir = path.join(t.tempDir(), "qzone");
      const st = new QzoneState({ dir });
      t.ok(fs.existsSync(path.join(dir, "state.json")) === false, "全新状态不应凭空造文件");

      t.eq(st.hasReplied("p1", "c1"), false);
      st.markReplied("p1", "c1", { nick: "群友A", replyCommentId: "CMT1" });
      t.eq(st.hasReplied("p1", "c1"), true);

      st.markSeen([
        { postTid: "p1", commentTid: "c1" },
        { postTid: "p1", commentTid: "c2" }
      ]);
      t.eq(st.wasSeen("p1", "c2"), true);
      t.eq(st.wasSeen("p1", "c1"), false, "已回的评论不该留在 seen 表里");

      // 重新 new 一次 = 模拟重启
      const st2 = new QzoneState({ dir });
      t.eq(st2.hasReplied("p1", "c1"), true, "已回记录重启不丢（一条评论只回一次）");
      t.eq(st2.wasSeen("p1", "c2"), true);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
      t.eq(raw.repliedComments["p1:c1"].nick, "群友A");

      // 历史脏数据（同一评论既已回又未回）读取时清理
      const dir2 = path.join(t.tempDir(), "qzone2");
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(
        path.join(dir2, "state.json"),
        JSON.stringify({ posts: [], repliedComments: { "p:1": { ts: 1 } }, seenComments: { "p:1": { ts: 2 } }, lastAttempt: 0 })
      );
      const st3 = new QzoneState({ dir: dir2 });
      t.eq(st3.wasSeen("p", "1"), false, "读取时应清掉与已回重复的 seen 记录");
      t.eq(st3.hasReplied("p", "1"), true);
    }
  },

  {
    name: "state：频率限制（周配额 / 最小间隔 / 冷却 / forced 不计数）",
    run: async (t) => {
      const st = new QzoneState({ dir: path.join(t.tempDir(), "qzone") });
      const cfg = { maxPerWeek: 3, minGapDays: 2, cooldownHours: 18 };
      t.eq(st.canPost(cfg).allowed, true, "没有历史记录时应允许发布");

      const now = Date.now();
      const day = 86400000;
      // 一周以前的记录不占本周配额
      st.data.posts = [{ ts: now - 10 * day, counted: true }, { ts: now - 9 * day, counted: false }];
      t.eq(st.canPost(cfg).allowed, true);

      // 刚发过一条 → 最小间隔 + 冷却都不过
      st.data.posts.push({ ts: now - 1000, counted: true });
      const g = st.canPost(cfg);
      t.eq(g.allowed, false);
      t.contains(g.reason, "冷却");
      t.contains(g.reason, "天");
      t.ok(g.nextAllowedAt > now, "应给出下次可发时间");

      // forced（counted=false）不占配额、也不触发间隔
      st.data.posts = [{ ts: now - 1000, counted: false }];
      t.eq(st.canPost(cfg).allowed, true, "forced 发布不计数");

      // 本周已满
      st.data.posts = [
        { ts: now - 3 * day, counted: true },
        { ts: now - 2.5 * day, counted: true },
        { ts: now - 2 * day, counted: true }
      ];
      const g2 = st.canPost({ maxPerWeek: 2, minGapDays: 0, cooldownHours: 0 });
      t.eq(g2.allowed, false);
      t.contains(g2.reason, "本周已发满");
      t.eq(g2.weekCount, 3);

      // 连续记录上限保留最近 200 条
      for (let i = 0; i < 250; i++) st.recordPost({ content: "x" + i });
      t.eq(st.data.posts.length, 200);
    }
  },

  {
    name: "发送通道·发说说：ugc_right=4 / base64 配图 / 状态落盘 / 频率拦截",
    run: async (t) => {
      const host = newHost();
      try {
        host.setOnCall(async (action) => {
          if (action === "send_qzone_msg") return { tid: "TID123", time: 1700000000 };
          throw new Error("意外的 OneBot 动作：" + action);
        });
        setup(host.api);
        const tool = host.tools.get("publish_qzone_post");
        const ctx = host.ctx();

        // 预先放一张「挑图阶段下载过」的网图进本地缓存
        const cacheDir = path.join(host.dataDir, "qzone", "meme-cache");
        fs.mkdirSync(cacheDir, { recursive: true });
        const webUrl = "https://gpic.code-nav.cn/abc/def.webp";
        fs.writeFileSync(path.join(cacheDir, cacheKeyOf(webUrl) + ".webp"), fakePng());

        const res = await tool.execute(ctx, {
          content: "周末在游戏里摸鱼摸到飞起，爽",
          image: webUrl,
          topicTitle: "摸鱼",
          mood: "吐槽"
        });
        const data = JSON.parse(res.content);
        t.eq(res.isError, undefined);
        t.eq(data.posted, true);
        t.eq(data.visibility, "好友可见");
        t.eq(data.tid, "TID123");
        t.eq(data.withImage, true);
        t.eq(data.forced, false);
        t.eq(data.counted, true, "正常发布应占本周配额");

        const call = host.calls.onebot[0];
        t.eq(call.action, "send_qzone_msg");
        t.eq(call.params.ugc_right, 4, "可见范围必须写死好友可见（ugc_right=4）");
        t.eq(call.params.content, "周末在游戏里摸鱼摸到飞起，爽");
        t.eq(call.timeoutMs, 180000);
        t.eq(call.params.images.length, 1);
        t.ok(String(call.params.images[0]).startsWith("base64://"), "网图应转成 OneBot base64:// 图片源（宿主没有本机中转服务）");

        // 状态落盘：记原始地址（不存 base64）
        const stateFile = path.join(host.dataDir, "qzone", "state.json");
        t.ok(fs.existsSync(stateFile), "状态应写 DATA_DIR/qzone/state.json");
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        t.eq(saved.posts.length, 1);
        t.eq(saved.posts[0].image, webUrl, "state 里应记原始图床地址，不能塞 base64");
        t.eq(saved.posts[0].counted, true);

        // 不带 forced 再发 → 被频率闸门拦住（状态已落盘）
        const res2 = await tool.execute(ctx, { content: "再发一条试试" });
        t.eq(res2.isError, true);
        t.contains(res2.content, "还不能发");
        t.eq(host.calls.onebot.length, 1, "被拦截时不应调用 OneBot");

        // 图库直链照旧直传（SnowLuma 自己下载）
        await tool.execute(ctx, { content: "再摸一条鱼", image: "https://img.aigengtu.com/meme/1001.webp", forced: true });
        const call2 = host.calls.onebot[1];
        t.eq(call2.params.images[0], "https://img.aigengtu.com/meme/1001.webp");

        // 白名单外的图静默降级为纯文字
        await tool.execute(ctx, { content: "白名单外配图测试", image: "https://evil.example.com/a.png", forced: true });
        const call3 = host.calls.onebot[2];
        t.eq(call3.params.images, undefined, "白名单外的图片不能被带进空间");
        const data3 = JSON.parse((await tool.execute(ctx, { content: "纯文字兜底", forced: true })).content);
        t.ok(data3.whyNoImage, "没配图时应说明原因");
      } finally {
        host.cleanup();
      }
    }
  },

  {
    name: "发送通道·时政/群聊内容拒发（安全边界不变）",
    run: async (t) => {
      const host = newHost();
      try {
        host.setOnCall(async () => {
          throw new Error("不该被调用");
        });
        setup(host.api);
        const tool = host.tools.get("publish_qzone_post");
        const ctx = host.ctx();

        const political = await tool.execute(ctx, { content: "祝福祖国！天安门广场举行国庆升旗仪式", forced: true });
        t.eq(political.isError, true);
        t.contains(political.content, "不能发");

        const privacy = await tool.execute(ctx, { content: "刚才群里有人说这个游戏很好玩", forced: true });
        t.eq(privacy.isError, true);
        t.contains(privacy.content, "提到了人");

        t.eq(host.calls.onebot.length, 0, "被安全闸门拦下的内容绝不能发出去");
      } finally {
        host.cleanup();
      }
    }
  },

  {
    name: "评论工具：只读自己说说 / 顶层评论 @ 回复 / 一条只回一次",
    run: async (t) => {
      const host = newHost();
      try {
        host.setOnCall(async (action, params) => {
          if (action === "get_qzone_feeds") return { feeds: [SELF_FEED, OTHER_FEED], has_more: false };
          if (action === "comment_qzone") return { comment_id: "CMT9", tid: params.tid };
          throw new Error("意外的 OneBot 动作：" + action);
        });
        setup(host.api);
        const ctx = host.ctx({ selfId: "10001" });

        const check = host.tools.get("qzone_check_comments");
        const checked = JSON.parse((await check.execute(ctx, { limit: 10 })).content);
        t.eq(checked.count, 2, "只应返回自己说说下的外部评论（自己发的不算、别人的说说跳过）");
        t.deepEq(
          checked.needReply.map((x) => x.评论id).sort(),
          ["1", "19"]
        );
        t.eq(host.calls.onebot[0].action, "get_qzone_feeds");
        t.eq(host.calls.onebot[0].timeoutMs, 40000);

        const reply = host.tools.get("qzone_reply_comment");
        // 回复正文同样要过两层安全闸门（时政优先）
        const bad = await reply.execute(ctx, { postTid: "POST1", commentTid: "19", targetUin: 20002, nickname: "群友A", content: "国庆升旗" });
        t.eq(bad.isError, true);
        t.contains(bad.content, "不能发");
        // 隐私闸门（回复这条路不能绕过「群聊内容不进空间」）
        const leak = await reply.execute(ctx, { postTid: "POST1", commentTid: "19", targetUin: 20002, nickname: "群友A", content: "刚才群里有人问我这个" });
        t.eq(leak.isError, true);
        t.contains(leak.content, "群聊");

        const ok = await reply.execute(ctx, { postTid: "POST1", commentTid: "19", targetUin: 20002, nickname: "群友A", content: "哈哈哈这个确实" });
        const okData = JSON.parse(ok.content);
        t.eq(okData.replied, true);
        t.eq(okData.sentAs, "@群友A 哈哈哈这个确实", "回复要以顶层评论开头 @ 对方");
        const call = host.calls.onebot.filter((x) => x.action === "comment_qzone")[0];
        t.eq(call.params.tid, "POST1");
        t.eq(call.params.target_uin, undefined, "不能传 target_uin（它表示说说所属者，会把评论带到别人空间）");
        t.eq(call.timeoutMs, 120000);

        // 同一条评论第二次 → 去重拦截，不再发
        const again = await reply.execute(ctx, { postTid: "POST1", commentTid: "19", targetUin: 20002, nickname: "群友A", content: "重复回复" });
        t.eq(again.isError, true);
        t.contains(again.content, "已经回过了");
        t.eq(host.calls.onebot.filter((x) => x.action === "comment_qzone").length, 1, "一条评论只回一次");

        // 模型自己带 @ 时不重复加
        const withAt = await reply.execute(ctx, { postTid: "POST1", commentTid: "1", nickname: "群友A", content: "@群友A 你也来" });
        const withAtData = JSON.parse(withAt.content);
        t.eq((withAtData.sentAs.match(/@/g) || []).length, 1);
        t.ok(fs.existsSync(path.join(host.dataDir, "qzone", "state.json")), "回复去重记录应落盘");

        // 再查一次：两条都已回复 → 进入 alreadyReplied，不再要求回复
        const checked2 = JSON.parse((await check.execute(ctx, { limit: 10 })).content);
        t.eq(checked2.count, 0);
        t.eq(checked2.alreadyReplied.length, 2);
      } finally {
        host.cleanup();
      }
    }
  },

  {
    name: "钩子：发说说/查评论提醒 + 节流 + 安静时段静音",
    run: async (t) => {
      const host = newHost();
      try {
        setup(host.api);
        const ctx = host.ctx();
        await hooks["before-llm-messages"](ctx);
        const injected = ctx.messages[ctx.messages.length - 1].content;
        t.contains(injected, "qzone_check_comments");
        t.contains(injected, "publish_qzone_post");
        t.contains(injected, "不要写群里刚聊的事");

        // 同一次运行再调一次：两个提醒都已被节流，不再追加
        const before = ctx.messages[ctx.messages.length - 1].content.length;
        await hooks["before-llm-messages"](ctx);
        t.eq(ctx.messages[ctx.messages.length - 1].content.length, before, "提醒有节流，不应反复注入");
      } finally {
        host.cleanup();
      }

      // 动态构造一个「一定包含当前小时」的安静时段 → 任何时间跑都不注入
      const hour = new Date().getHours();
      const quietHost = newHost({ quietHours: `${hour}-${(hour + 1) % 24}` });
      try {
        setup(quietHost.api);
        const quietCtx = quietHost.ctx();
        const original = quietCtx.messages[quietCtx.messages.length - 1].content;
        await hooks["before-llm-messages"](quietCtx);
        t.eq(quietCtx.messages[quietCtx.messages.length - 1].content, original, "安静时段不应注入任何空间提醒");
      } finally {
        quietHost.cleanup();
      }
    }
  }
];
