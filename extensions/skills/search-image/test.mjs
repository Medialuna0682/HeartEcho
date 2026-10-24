/**
 * search-image 扩展测试（不联网）。
 *
 * mock 宿主 + 固定 JSON：覆盖参数校验、未配置报错、apihz 请求 URL 拼装、
 * 返回解析、ctx.sender.sendImage 发送参数（契约签名 image + {caption}）、
 * 数量钳制与错误路径（HTTP 失败 / code 非 200 / 空结果 / fetch 抛错 / 发送失败）。
 */
import { createMockHost } from "../../../tools/extension-harness.mjs";

/** skill.json 的 settings 默认值。 */
const MANIFEST_DEFAULTS = {
  apiUrl: "https://cn.apihz.cn/api/img/apihzimgbaidu.php",
  apiId: "",
  apiKey: "",
  defaultCount: 1,
  maxCount: 3
};

let modPromise = null;
function loadExt() {
  if (!modPromise) modPromise = import("./index.js");
  return modPromise;
}

/** 标准 Response 替身：搜图只用 ok / status / json()。 */
function jsonResponse(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return json;
    }
  };
}

async function makeTool(settings, fetchImpl) {
  const { setup } = await loadExt();
  const host = createMockHost({
    id: "search-image",
    settings: { ...MANIFEST_DEFAULTS, ...(settings ?? {}) }
  });
  if (fetchImpl) host.api.fetch = fetchImpl;
  setup(host.api);
  return { host, tool: host.tools.get("search_image") };
}

/** apihz 常见返回：{code:200, data:[{imgurl}|{url}]}。 */
function imagePayload(urls) {
  return { code: 200, msg: "ok", data: urls.map((url) => ({ imgurl: url })) };
}

export const cases = [
  {
    name: "参数校验：缺 keyword / 未配置 apiId+apiKey 时明确报错且不联网",
    run: async (t) => {
      const calls = [];
      const { host, tool } = await makeTool({}, async (url) => {
        calls.push(String(url));
        return jsonResponse(imagePayload(["https://img.example.test/a.jpg"]));
      });

      try {
        const noKeyword = await tool.execute(host.ctx(), { keyword: "   " });
        t.ok(noKeyword.isError === true);
        t.contains(noKeyword.content, "缺少 keyword");

        const notConfigured = await tool.execute(host.ctx(), { keyword: "猫" });
        t.ok(notConfigured.isError === true);
        t.contains(notConfigured.content, "还没配置搜图 API");
        t.contains(notConfigured.content, "apihz");
        t.eq(calls.length, 0, "参数/配置校验阶段不应发起网络请求");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "请求 URL 拼装 + 固定 JSON 解析 + sendImage(caption) 发送",
    run: async (t) => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(
          imagePayload([
            "https://img.example.test/a.jpg",
            "https://img.example.test/b.jpg",
            "https://img.example.test/c.jpg"
          ])
        );
      };
      const { host, tool } = await makeTool({ apiId: "id123", apiKey: "key456", defaultCount: 2, maxCount: 3 }, fetchImpl);

      try {
        const res = await tool.execute(host.ctx(), { keyword: "猫", count: 2 });
        t.eq(res.isError, undefined);
        t.contains(res.content, "已发送 2 张「猫」的图片");

        // 只发一次请求，参数齐全
        t.eq(calls.length, 1);
        const url = new URL(calls[0].url);
        t.eq(`${url.origin}${url.pathname}`, "https://cn.apihz.cn/api/img/apihzimgbaidu.php");
        t.eq(url.searchParams.get("id"), "id123");
        t.eq(url.searchParams.get("key"), "key456");
        t.eq(url.searchParams.get("words"), "猫");
        t.eq(url.searchParams.get("page"), "1");
        t.eq(url.searchParams.get("type"), "1");
        t.eq(url.searchParams.get("limit"), "2");
        t.eq(calls[0].init.method, "GET");

        // 发送走 ctx.sender.sendImage({url}, {caption})，只发当前的 count 张
        const images = host.calls.images;
        t.eq(images.length, 2);
        t.eq(images[0].image.url, "https://img.example.test/a.jpg");
        t.eq(images[1].image.url, "https://img.example.test/b.jpg");
        t.eq(images[0].options.caption, "搜图：猫");
        t.ok(!("note" in images[0].options), "发送参数应使用契约字段 caption，不再传旧 note/chatKey");

        // count 超过 maxCount 被钳制；不给 count 用 defaultCount
        const over = await tool.execute(host.ctx(), { keyword: "狗", count: 9 });
        t.contains(over.content, "已发送 3 张「狗」的图片");
        t.eq(new URL(calls[1].url).searchParams.get("limit"), "3");
        const fallback = await tool.execute(host.ctx(), { keyword: "风景" });
        t.contains(fallback.content, "已发送 2 张「风景」的图片");
        t.eq(new URL(calls[2].url).searchParams.get("limit"), "2", "未传 count 时应使用 defaultCount");
      } finally {
        host.cleanup();
      }
    }
  },
  {
    name: "错误路径：HTTP 失败 / code 非 200 / 空结果 / fetch 抛错",
    run: async (t) => {
      const http500 = await makeTool({ apiId: "id", apiKey: "key" }, async () => jsonResponse({}, { ok: false, status: 500 }));
      try {
        const res = await http500.tool.execute(http500.host.ctx(), { keyword: "猫" });
        t.ok(res.isError === true);
        t.contains(res.content, "HTTP 500");
      } finally {
        http500.host.cleanup();
      }

      const apiError = await makeTool({ apiId: "id", apiKey: "key" }, async () =>
        jsonResponse({ code: 500, msg: "额度不足", data: null })
      );
      try {
        const res = await apiError.tool.execute(apiError.host.ctx(), { keyword: "猫" });
        t.ok(res.isError === true);
        t.contains(res.content, "没搜到「猫」的图片");
        t.contains(res.content, "额度不足");
      } finally {
        apiError.host.cleanup();
      }

      const empty = await makeTool({ apiId: "id", apiKey: "key" }, async () => jsonResponse({ code: 200, data: [] }));
      try {
        const res = await empty.tool.execute(empty.host.ctx(), { keyword: "猫" });
        t.ok(res.isError === true);
        t.contains(res.content, "没搜到「猫」的图片");
      } finally {
        empty.host.cleanup();
      }

      const network = await makeTool({ apiId: "id", apiKey: "key" }, async () => {
        throw new Error("network down");
      });
      try {
        const res = await network.tool.execute(network.host.ctx(), { keyword: "猫" });
        t.ok(res.isError === true);
        t.contains(res.content, "搜图失败");
        t.contains(res.content, "network down");
      } finally {
        network.host.cleanup();
      }
    }
  },
  {
    name: "发送通道：单张失败跳过继续，全部失败时返回 isError",
    run: async (t) => {
      const { host, tool } = await makeTool({ apiId: "id", apiKey: "key" }, async () =>
        jsonResponse(imagePayload(["https://img.example.test/a.jpg", "https://img.example.test/b.jpg"]))
      );

      try {
        let attempt = 0;
        const partial = host.ctx({
          sender: {
            async sendImage(image, options) {
              attempt += 1;
              if (attempt === 1) throw new Error("发送失败");
              return { messageId: "mock-img-ok" };
            }
          }
        });
        const okRes = await tool.execute(partial, { keyword: "猫", count: 2 });
        t.eq(okRes.isError, undefined);
        t.contains(okRes.content, "已发送 1 张「猫」的图片", "单张失败应跳过、继续发下一张");

        const broken = host.ctx({
          sender: {
            async sendImage() {
              throw new Error("发送失败");
            }
          }
        });
        const badRes = await tool.execute(broken, { keyword: "猫", count: 2 });
        t.ok(badRes.isError === true);
        t.contains(badRes.content, "发送失败");
      } finally {
        host.cleanup();
      }
    }
  }
];
