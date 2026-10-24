/**
 * smart-image 扩展测试（不联网、不写真实数据目录）。
 *
 * 覆盖移植要求里点名的那几块纯逻辑 + 工具编排：
 *   · 图源选择 / 降级顺序：360 → 百度 → 必应（tier 0/1/2 分层）、单源锁定、
 *     单源失败不影响其它源、搜索源全挂才补随机图；
 *   · 关键词变体：原词永远第一、最长前缀优先（「来张」不会被「来」吃掉）、
 *     剥尾部图/壁纸、剥修饰词、长中文串取尾词；
 *   · 图片格式头/尺寸校验：PNG/JPEG/GIF/WebP 构造 buffer、HTML 错误页拒收；
 *   · 历史去重指纹：URL 指纹 / 内容指纹、关键词级 + 全局级、落盘 + 重读；
 *   · pixiv 相关性判定：tag 必须真的包含查询词、多词全命中、R18 黑名单；
 *   · 工具行为：pixiv 优先出图 + sendImage(chatKey,{file},{note}) 契约签名、
 *     非 ACG 词回落到必应（下载落盘到 api.dataDir/smart-image）、参数/权限校验。
 */
import fs from "node:fs";
import path from "node:path";
import { createMockHost } from "../../../tools/extension-harness.mjs";
import { setup } from "./index.js";
import { collectCandidates, keywordVariants, randomFallbacks } from "./lib/sources.js";
import { pixivCandidates, matchesQuery, isNsfw } from "./lib/pixiv.js";
import { sniffSize, downloadImage, contentHash, isPublicHttpUrl } from "./lib/image.js";
import { seen, mark, reset as resetHistory, reload as reloadHistory, normKeyword } from "./lib/history.js";
import { setDataRoot } from "./lib/paths.js";

/** skill.json 的 settings 默认值（端口/来源顺序都锁在 manifest 里）。 */
const MANIFEST_DEFAULTS = {
  count: 1,
  maxCount: 3,
  source: "auto",
  minShortSide: 480,
  poolSize: 40,
  allowRandom: true,
  pixiv: "prefer",
  pixivExcludeAI: false
};

/* ------------------------------ 替身工具 ------------------------------ */

/** 最小 Response 替身：只实现被测代码用到的 ok/status/headers/text/json/arrayBuffer。 */
function makeResp({ json, text, buf, ok = true, status = 200, headers = {} } = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  return {
    ok,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    async text() {
      return typeof text === "function" ? text() : String(text ?? "");
    },
    async json() {
      return typeof json === "function" ? json() : json;
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

/** 构造只有文件头是真的 PNG：sniffSize 只读 IHDR，这就够走完下载校验。 */
function fakePng(w = 100, h = 80, extra = 0) {
  const buf = Buffer.alloc(Math.max(33, 33 + extra));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

/** 构造 SOI + SOF0 的 JPEG 头（sniffJpeg 从 SOFn 读宽高）。 */
function fakeJpeg(w = 800, h = 600) {
  const buf = Buffer.alloc(32);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0;
  buf.writeUInt16BE(17, 4);   // 段长
  buf[6] = 8;                 // 精度
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  return buf;
}

/** 构造 GIF89a 头（宽高小端在偏移 6/8）。 */
function fakeGif(w = 320, h = 240) {
  const buf = Buffer.alloc(24);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

/** 构造 VP8L 无损 WebP 头（14 位宽高各减 1）。 */
function fakeWebpLossless(w = 500, h = 400) {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(24, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf[20] = 0x2f;
  buf.writeUInt32LE((((h - 1) << 14) | (w - 1)) >>> 0, 21);
  return buf;
}

function newHost(settings = {}) {
  return createMockHost({ id: "smart-image", settings: { ...MANIFEST_DEFAULTS, ...settings } });
}

/** 只注册工具、不联网：fetchImpl 不传就删掉 api.fetch，模拟没有 web_fetch 权限。 */
function makeTool(settings, fetchImpl) {
  const host = newHost(settings);
  if (typeof fetchImpl === "function") host.api.fetch = fetchImpl;
  else delete host.api.fetch;
  setup(host.api);
  return { host, tool: host.tools.get("find_image") };
}

/** 当前会话的自定义 sender：按契约签名 (chatKey, image, {note}) 记录每一次发送。 */
function ctxWithSender(host) {
  const sends = [];
  const ctx = host.ctx({
    sender: {
      async sendImage(chatKey, image, options) {
        sends.push({ chatKey, image, options });
        return { ok: true, messageId: `mock-img-${sends.length}` };
      }
    }
  });
  return { ctx, sends };
}

/* ---------------------- 图源 mock（按 host 分派） ---------------------- */

const QIHOO_PAYLOAD = {
  list: [
    { img: "https://img.example.test/360-orig.jpg", width: 4000, height: 3000, imgsize: "2.1MB", title: "猫" },
    { thumb: "https://img.example.test/360-thumb.jpg", thumbWidth: 240, thumbHeight: 240, title: "猫" }
  ]
};

const BAIDU_PAYLOAD = {
  data: [
    {
      replaceUrl: [{ ObjURL: "https://img.example.test/baidu-orig.jpg" }],
      middleURL: "https://img.example.test/baidu-mid.jpg",
      width: 2400,
      height: 1800,
      fromPageTitleEnc: "猫"
    }
  ]
};

/** auto 模式：三家都返回，用来锁"降级顺序/分层"。 */
function sourceFetch(calls, { qihooStatus = 200 } = {}) {
  return async (url) => {
    const host = new URL(String(url)).hostname;
    calls.push(host);
    if (host === "image.so.com") {
      if (qihooStatus !== 200) return makeResp({ ok: false, status: qihooStatus });
      return makeResp({ text: JSON.stringify(QIHOO_PAYLOAD) });
    }
    if (host === "image.baidu.com") return makeResp({ json: BAIDU_PAYLOAD });
    if (host === "tse2.mm.bing.net") return makeResp({ buf: Buffer.alloc(2048, 1) });
    throw new Error(`不期望的请求：${host}`);
  };
}

const PIXIV_PAYLOAD = {
  data: [
    {
      pid: 11,
      tags: ["初音ミク", "Vocaloid"],
      width: 1200,
      height: 1600,
      ext: "png",
      urls: { regular: "https://i.pixiv.re/img-original/img/11_p0.png" },
      title: "初音",
      author: "画师"
    },
    {
      // 模糊匹配带回来的无关图：tags 里没有「初音」
      pid: 12,
      tags: ["猫耳", "白丝"],
      width: 1200,
      height: 1600,
      ext: "png",
      urls: { regular: "https://i.pixiv.re/img-original/img/12_p0.png" }
    },
    {
      // 相关性通过但踩 R18 黑名单
      pid: 13,
      tags: ["初音ミク", "R-18"],
      width: 1200,
      height: 1600,
      ext: "png",
      urls: { regular: "https://i.pixiv.re/img-original/img/13_p0.png" }
    },
    {
      // 动图体积不可控
      pid: 14,
      tags: ["初音ミク"],
      ext: "gif",
      urls: { regular: "https://i.pixiv.re/img-original/img/14_p0.gif" }
    },
    {
      // 同 pid 重复，应当被去重
      pid: 11,
      tags: ["初音ミク"],
      width: 1200,
      height: 1600,
      ext: "png",
      urls: { regular: "https://i.pixiv.re/img-original/img/11_p0.png" }
    }
  ]
};

export const cases = [
  {
    name: "图源选择/降级：auto 下 360→百度→必应 的分层顺序、单源锁定、单源失败互补、全挂补随机图",
    run: async (t) => {
      // ① auto：三家都返回 → 候选按任务顺序排列，tier 锁定 0/2/0/1/1
      const autoCalls = [];
      const auto = await collectCandidates(sourceFetch(autoCalls), "猫", { want: 1, allowRandom: false });
      t.deepEq(auto.errors, [], "三家都正常时不应有错误");
      t.deepEq(
        auto.candidates.map((c) => c.source),
        ["360图搜", "360缩略图", "百度原图", "百度图", "必应"],
        "降级顺序/各源内部顺序应保持原样"
      );
      t.deepEq(auto.candidates.map((c) => c.tier), [0, 2, 0, 1, 1], "分级：原图0 / 小图2 / 中档1");
      t.eq(auto.candidates[0].w, 4000, "360 原图标称尺寸应带出来（供排序用）");

      // ② 锁定单源：只打必应的接口
      const bingCalls = [];
      const bing = await collectCandidates(sourceFetch(bingCalls), "樱花", { sources: ["bing"], want: 1, allowRandom: false });
      t.deepEq(bingCalls, ["tse2.mm.bing.net"], "source=bing 时不应请求 360/百度");
      t.eq(bing.candidates.length, 1, "want=1 时必应只取一种查询形式");
      t.eq(bing.candidates[0].tier, 1);
      t.contains(bing.candidates[0].title, "樱花");

      // ③ 360 挂了不影响百度/必应（单源失败只记录错误）
      const brokenCalls = [];
      const broken = await collectCandidates(sourceFetch(brokenCalls, { qihooStatus: 503 }), "猫", { allowRandom: false });
      t.ok(broken.errors.some((e) => e.startsWith("360:") && e.includes("503")), "360 的失败应被记录");
      t.deepEq(broken.candidates.map((c) => c.source), ["百度原图", "百度图", "必应"], "其它源应照常返回");

      // ④ 搜索源一条都没有 → 才补随机图（tier 3），且仅在 allowRandom 时
      const failCalls = [];
      const fallback = await collectCandidates(sourceFetch(failCalls, { qihooStatus: 503 }), "猫", { sources: ["360"] });
      t.deepEq(failCalls, ["image.so.com"]);
      t.eq(fallback.candidates.length, 2, "随机图源固定两条");
      t.ok(fallback.candidates.every((c) => c.tier === 3 && c.source === "随机图"), "兜底候选应为 tier 3 随机图");
      t.ok(fallback.candidates.every((c) => c.url.startsWith("https://picsum.photos/")), "随机图地址应来自 picsum");

      const noRandom = await collectCandidates(sourceFetch([], { qihooStatus: 503 }), "猫", { sources: ["360"], allowRandom: false });
      t.eq(noRandom.candidates.length, 0, "allowRandom=false 时宁可不发也不发无关图");

      // ⑤ 随机图端点本身：两条、tier 3
      const randoms = randomFallbacks();
      t.eq(randoms.length, 2);
      t.ok(randoms.every((c) => c.tier === 3 && c.w >= 720 && c.h >= 720));
    }
  },
  {
    name: "关键词变体：原词第一、最长前缀优先、剥请求语气/图后缀/修饰词、长中文串取尾词",
    run: async (t) => {
      const raw = "来张橘猫的高清壁纸";
      const variants = keywordVariants(raw);
      t.eq(variants[0], raw, "原词必须永远排第一（变体只是后备）");
      t.ok(variants.includes("橘猫"), "应剥到核心名词「橘猫」");
      t.ok(variants.length <= 7, "最多 7 个变体");
      t.ok(variants.slice(1).every((v) => !v.includes("来张")), "变体里不应残留请求语气");

      // 最长优先：「来张猫咪」不能先被「来」吃掉留下「张猫咪」
      const cat = keywordVariants("来张猫咪");
      t.ok(cat.includes("猫咪"));
      t.ok(!cat.slice(1).some((v) => v.includes("张猫咪")), "剥词表必须最长优先（否则会留下「张猫咪」）");

      // 长中文串没有分隔符时靠尾部截取兜住中心词
      const sanTi = keywordVariants("三体里那个罗辑");
      t.ok(sanTi.includes("罗辑"), "「…那个X」应能剥出 X");
      t.ok(sanTi.every((v) => v.length >= 1));

      // 装饰引号/emoji 只做减法
      const quoted = keywordVariants("「向日葵」🌻");
      t.ok(quoted.includes("向日葵"));

      t.deepEq(keywordVariants("   "), [], "空关键词不应产生变体");
    }
  },
  {
    name: "图片格式头/尺寸：PNG/JPEG/GIF/WebP 构造 buffer、HTML 错误页与 HTTP 错误拒收、内网地址拦截",
    run: async (t) => {
      const pngSize = sniffSize(fakePng(1920, 1080));
      t.eq(pngSize.format, "png");
      t.eq(pngSize.w, 1920);
      t.eq(pngSize.h, 1080);
      const jpegSize = sniffSize(fakeJpeg(800, 600));
      t.eq(jpegSize.format, "jpeg");
      t.eq(jpegSize.w, 800);
      t.eq(jpegSize.h, 600);
      const gifSize = sniffSize(fakeGif(320, 240));
      t.eq(gifSize.format, "gif");
      t.eq(gifSize.w, 320);
      t.eq(gifSize.h, 240);
      const webpSize = sniffSize(fakeWebpLossless(500, 400));
      t.eq(webpSize.format, "webp");
      t.eq(webpSize.w, 500);
      t.eq(webpSize.h, 400);
      t.eq(sniffSize(Buffer.from("<!doctype html><html>404</html>")), null, "HTML 错误页不能当图片");
      t.eq(sniffSize(Buffer.alloc(8)), null, "过短 buffer 认不出");

      // downloadImage：用实测尺寸 + 内容指纹，不信响应头
      const png = fakePng(1600, 1200);
      const dl = await downloadImage(async () => makeResp({
        buf: png,
        headers: { "content-type": "image/png", "content-length": String(png.length) }
      }), "https://img.example.test/a.png", { timeoutMs: 1000 });
      t.eq(dl.w, 1600);
      t.eq(dl.h, 1200);
      t.eq(dl.format, "png");
      t.eq(dl.bytes, png.length);
      t.eq(dl.hash, contentHash(png), "内容指纹应是整段字节的 sha1 前 20 位");
      t.eq(dl.contentType, "image/png");

      const htmlErr = await t.throwsAsync(
        () => downloadImage(async () => makeResp({ buf: Buffer.from("<html>403 Forbidden</html>") }), "https://img.example.test/x"),
        "200 + HTML 错误页应拒收"
      );
      t.contains(String(htmlErr.message), "不是可识别的图片");

      const httpErr = await t.throwsAsync(
        () => downloadImage(async () => makeResp({ ok: false, status: 404 }), "https://img.example.test/gone.jpg"),
        "HTTP 404 应拒收"
      );
      t.contains(String(httpErr.message), "HTTP 404");

      // SSRF 口径：内网/本机一律不放行
      for (const bad of [
        "http://localhost/x.png",
        "http://127.0.0.1/x.png",
        "http://10.1.2.3/x.png",
        "http://192.168.1.5/x.png",
        "http://172.20.0.1/x.png",
        "http://169.254.1.1/x.png",
        "http://[::1]/x.png",
        "ftp://img.example.test/x.png"
      ]) {
        t.eq(isPublicHttpUrl(bad), false, `应拦截：${bad}`);
      }
      t.eq(isPublicHttpUrl("https://picsum.photos/1600/900"), true);
    }
  },
  {
    name: "历史去重指纹：URL/内容两个维度、关键词级 + 全局级、落盘后重读仍生效",
    run: async (t) => {
      const root = t.tempDir();
      setDataRoot(root);
      resetHistory();

      mark("猫", { urlHash: "u1", hash: "c1" });
      t.eq(seen("猫", { urlHash: "u1" }), "url", "URL 指纹命中（下载前就能拦，省流量）");
      t.eq(seen("猫", { hash: "c1" }), "content", "内容指纹命中（换域名同图也认得）");
      t.eq(seen("  猫  ", { urlHash: "u1" }), "url", "关键词归一后不应记忆分裂");
      t.eq(seen("橘猫", { hash: "c1" }), "content", "全局级：别的关键词发过的图也不重复");
      t.eq(seen("猫", { urlHash: "u-other", hash: "c-other" }), null, "没发过的图不应误判");

      t.eq(normKeyword("  猫， 猫 "), "猫 猫", "归一：大小写/空白/标点");
      t.eq(normKeyword("CAT"), "cat");

      // 落盘：<DATA_DIR>/smart-image/history.json（不再写系统临时目录）
      const file = path.join(root, "smart-image", "history.json");
      t.ok(fs.existsSync(file), "去重记忆应落盘到 DATA_DIR/smart-image/history.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      t.ok(saved.global.includes("c:c1"));
      t.ok(saved.global.includes("u:u1"));

      // 模拟重启：丢掉进程内缓存，重新读盘
      reloadHistory();
      t.eq(seen("猫", { hash: "c1" }), "content", "重启后记忆应仍然有效");
      t.eq(seen("橘猫", { urlHash: "u1" }), "url");

      // URL 指纹与内容指纹互不干扰
      mark("猫", { urlHash: "u2" });
      t.eq(seen("猫", { hash: "c2" }), null);
      t.eq(seen("猫", { urlHash: "u2" }), "url");

      resetHistory();
      t.eq(seen("猫", { hash: "c1" }), null, "reset 后记忆清空");
    }
  },
  {
    name: "pixiv 相关性判定：tag 必须真的含查询词、多词全命中、R18 黑名单、非 ACG 词静默返回空",
    run: async (t) => {
      t.eq(matchesQuery(["初音ミク", "Vocaloid"], "初音"), true);
      t.eq(matchesQuery(["猫耳", "白丝"], "橘猫"), false, "模糊匹配带回来的无关图必须挡掉");
      t.eq(matchesQuery(["甘雨(原神)"], "原神 甘雨"), true, "多词查询要求每个词都在 tag 里");
      t.eq(matchesQuery(["原神"], "原神 甘雨"), false);
      t.eq(matchesQuery([], "初音"), false);

      t.eq(isNsfw(["R-18"]), true);
      t.eq(isNsfw(["巨乳"]), true);
      t.eq(isNsfw(["ロリ"]), true);
      t.eq(isNsfw(["初音ミク", "Vocaloid"]), false, "正常作品不应被误杀");

      // 端到端：同一份接口数据里只留下「初音」那一条正常图
      const calls = [];
      const fetchImpl = async (url) => {
        calls.push(String(url));
        return makeResp({ json: PIXIV_PAYLOAD });
      };
      const hit = await pixivCandidates(fetchImpl, "初音");
      t.deepEq(hit.errors, []);
      t.eq(hit.candidates.length, 1, "无关图/R18/动图/重复 pid 都应被过滤");
      const only = hit.candidates[0];
      t.eq(only.pid, 11);
      t.eq(only.source, "pixiv");
      t.eq(only.tier, 0);
      t.eq(only.pixiv, true, "下载时要据此走 pixiv 的短超时+重试计划");
      t.eq(only.url, "https://i.pixiv.re/img-original/img/11_p0.png");
      t.eq(only.mirrors.length, 1);
      t.contains(only.mirrors[0], "i.pixiv.nl", "备用反代应换域名保留路径");

      // 非 ACG 词：接口有返回但 tag 全不匹配 → 空候选，交给普通图搜
      const miss = await pixivCandidates(fetchImpl, "橘猫");
      t.deepEq(miss.candidates, [], "非 ACG 词应静默返回空，不能拿无关图充数");
    }
  },
  {
    name: "工具行为：pixiv 优先出图，sendImage(chatKey,{file},{note}) 发当前会话并落盘记账",
    run: async (t) => {
      const calls = [];
      const fetchImpl = async (url) => {
        const host = new URL(String(url)).hostname;
        calls.push(host);
        if (host === "api.lolicon.app") return makeResp({ json: PIXIV_PAYLOAD });
        if (host === "i.pixiv.re") return makeResp({ buf: fakePng(1200, 1600), headers: { "content-type": "image/png" } });
        throw new Error(`不期望的请求：${host}`);
      };
      const { host, tool } = makeTool({}, fetchImpl);
      const { ctx, sends } = ctxWithSender(host);
      try {
        // 工具契约字段保持原样（id/名称/参数/描述一字不改；仅按宿主约定加了 timeoutMs）
        t.eq(tool.id, "find_image");
        t.eq(tool.name, "智能配图");
        t.eq(tool.category, "media");
        t.eq(tool.icon, "🎨");
        t.eq(tool.timeoutMs, 60000, "find_image 应声明 60s 超时（默认 30s 会误杀）");
        t.deepEq(tool.parameters.required, ["keyword"]);
        t.deepEq(Object.keys(tool.parameters.properties), ["keyword", "count"]);
        t.contains(tool.description, "按关键词找一张图并直接发到当前会话");
        t.contains(tool.description, "永远不要回答");

        const res = await tool.execute(ctx, { keyword: "初音" });
        t.eq(res.isError, undefined, `不应报错：${res.content}`);
        t.contains(res.content, "已发出 1 张「初音」的图");
        t.contains(res.content, "1200x1600 pixiv", "提示里的尺寸/来源要与实测一致");

        t.eq(sends.length, 1, "一次工具调用只发一张");
        t.eq(sends[0].chatKey, "group:123456", "发送必须绑定当前会话 chatKey");
        t.eq(sends[0].options.note, "配图：初音", "note 走宿主签名的第三个参数");
        const file = sends[0].image.file;
        t.ok(typeof file === "string" && path.isAbsolute(file), "应发本地文件（协议端读盘，body 很小）");
        t.ok(file.startsWith(path.join(host.dataDir, "smart-image")), "临时图必须落在 DATA_DIR/smart-image");
        t.ok(fs.existsSync(file), "落盘文件应真实存在");
        t.deepEq([...fs.readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

        t.deepEq(calls, ["api.lolicon.app", "i.pixiv.re"], "pixiv 命中后不应再走普通图搜");
        t.contains(res.content, "不要再描述或复述图片内容");

        const historyFile = path.join(host.dataDir, "smart-image", "history.json");
        t.ok(fs.existsSync(historyFile), "发送成功后应记入去重历史");
        t.contains(fs.readFileSync(historyFile, "utf8"), "c:", "应记录内容指纹");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "工具降级：非 ACG 词 pixiv 空 → 360 原图挂 → 必应兜底出图；缺参数/无网络权限的报错",
    run: async (t) => {
      const calls = [];
      const fetchImpl = async (url) => {
        const host = new URL(String(url)).hostname;
        calls.push(host);
        if (host === "api.lolicon.app") return makeResp({ json: { data: [] } });
        if (host === "image.so.com") return makeResp({ ok: false, status: 403 });
        if (host === "image.baidu.com") return makeResp({ json: { data: [] } });
        if (host === "tse2.mm.bing.net") return makeResp({ buf: fakePng(1600, 1200, 4096) });
        throw new Error(`不期望的请求：${host}`);
      };
      const { host, tool } = makeTool({}, fetchImpl);
      const { ctx, sends } = ctxWithSender(host);
      try {
        const res = await tool.execute(ctx, { keyword: "橘猫" });
        t.eq(res.isError, undefined, `应兜底出图：${res.content}`);
        t.contains(res.content, "已发出 1 张「橘猫」的图");
        t.contains(res.content, "1600x1200 必应", "360 原图 403 后应降级到必应");
        t.eq(sends.length, 1);
        t.eq(sends[0].options.note, "配图：橘猫");
        t.ok(calls.includes("api.lolicon.app"), "prefer 模式应先试 pixiv");
        t.ok(calls.includes("image.so.com"), "pixiv 空后应走普通图搜");
        t.ok(calls.filter((h) => h === "tse2.mm.bing.net").length >= 2, "必应候选还要再下载校验一次");
        t.ok(!calls.includes("picsum.photos"), "必应已出图就不该再发随机图");
      } finally {
        host.cleanup();
      }

      // 缺 keyword：直接报错，不联网
      const naked = [];
      const kb = makeTool({}, async (url) => {
        naked.push(String(url));
        return makeResp({ json: {} });
      });
      try {
        const res = await kb.tool.execute(kb.host.ctx(), {});
        t.ok(res.isError === true);
        t.contains(res.content, "缺少 keyword");
        t.eq(naked.length, 0);
      } finally {
        kb.host.cleanup();
      }

      // 没有 web_fetch 权限（api.fetch 不存在）：明确提示，不崩
      const noNet = makeTool({});
      try {
        const res = await noNet.tool.execute(noNet.host.ctx(), { keyword: "猫" });
        t.ok(res.isError === true);
        t.contains(res.content, "未启用网络权限");
      } finally {
        noNet.host.cleanup();
      }
    }
  }
];
