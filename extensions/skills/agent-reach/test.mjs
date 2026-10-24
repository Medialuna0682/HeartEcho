// agent-reach 离线自检（不联网、不启动心语、不调用本机 exe）。
// 运行：node tools/extensions-test.mjs --only agent-reach
//
// 覆盖：
//   1. manifest / 工具注册（id、名称、描述保持原样）+ URL 校验（内网/非 http 拒绝）
//   2. HTML 正文抽取、实体解码、RSS/Atom 解析（纯函数）
//   3. buvid3 格式与随机性
//   4. mock api.fetch：web_read / bili_search / rss_read 成功与失败路径（含 buvid3 请求头）
//   5. reach_doctor：只做当前通道自检，不联网、不再依赖本机 agent-reach.exe
import fs from 'node:fs';
import { createMockHost } from '../../../tools/extension-harness.mjs';
import * as reach from './index.js';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('./skill.json', import.meta.url), 'utf8'));
const BUVID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}infoc$/;

/** 给 mock host 换一个可控的联网实现，并记录每次请求。 */
function installFetchMock(host, handler) {
  const requests = [];
  host.api.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? null });
    return handler(String(url), init ?? null);
  };
  return requests;
}

export const cases = [
  {
    name: '工具注册与 URL 校验（内网 / 非 http 一律拒绝）',
    async run(t) {
      // manifest 原样保留
      t.eq(MANIFEST.id, 'agent-reach');
      t.eq(MANIFEST.entry, 'index.js');
      t.deepEq(MANIFEST.permissions, ['web_fetch']);
      t.eq(MANIFEST.tools.length, 4);
      t.deepEq(MANIFEST.tools.map((item) => item.id), ['web_read', 'bili_search', 'rss_read', 'reach_doctor']);

      const host = createMockHost({ id: 'agent-reach' });
      let fetchCalls = 0;
      host.api.fetch = async () => { fetchCalls += 1; throw new Error('测试不应联网'); };
      reach.register(host.api);

      for (const id of ['web_read', 'bili_search', 'rss_read', 'reach_doctor']) {
        t.ok(host.tools.get(id), `应注册工具 ${id}`);
      }
      // id / 名称 / 描述保持原样
      t.eq(host.tools.get('web_read').name, '读网页');
      t.eq(host.tools.get('bili_search').name, '搜B站视频');
      t.eq(host.tools.get('rss_read').name, '读RSS');
      t.eq(host.tools.get('reach_doctor').name, '渠道体检');
      t.eq(host.tools.get('web_read').description, '抓取网页正文并转成纯文本（去脚本/样式/标签）。适合「这个链接讲了什么」。境外站点本机常超时。');
      t.eq(host.tools.get('bili_search').description, 'B 站官方搜索接口搜视频，返回标题/UP主/播放量/时长/链接。无需登录。');

      const webRead = host.tools.get('web_read');
      const rssRead = host.tools.get('rss_read');
      const ctx = host.ctx({});
      let r = await webRead.execute(ctx, { url: 'http://127.0.0.1:3210/api/status' });
      t.eq(r.isError, true);
      t.contains(r.content, '本机/内网');
      r = await webRead.execute(ctx, { url: 'http://192.168.1.1/' });
      t.eq(r.isError, true);
      r = await webRead.execute(ctx, { url: 'http://localhost:8080/x' });
      t.eq(r.isError, true);
      r = await webRead.execute(ctx, { url: 'http://[::1]:8080/x' });
      t.eq(r.isError, true, 'IPv6 本机地址也要拒');
      r = await webRead.execute(ctx, { url: 'http://10.1.2.3/' });
      t.eq(r.isError, true);
      r = await webRead.execute(ctx, { url: 'file:///C:/Windows/win.ini' });
      t.eq(r.isError, true);
      t.contains(r.content, 'http');
      r = await webRead.execute(ctx, { url: '不是网址' });
      t.eq(r.isError, true);
      r = await rssRead.execute(ctx, { url: 'http://10.0.0.1/feed.xml' });
      t.eq(r.isError, true);
      r = await rssRead.execute(ctx, { url: 'https://example.com/feed.xml' });
      // 走到网络出口说明 URL 通过了本地校验（mock fetch 抛错 → 工具如实报错）
      t.eq(r.isError, true);
      t.contains(r.content, '读取失败');
      t.eq(fetchCalls, 1, '只有通过校验的公网地址才会发请求');

      // IPv4 内网边界：172.16.0.0 ~ 172.31.255.255 拒，172.32 放行
      t.eq(reach.internals.isPrivateHost(new URL('http://172.16.0.1/')), true);
      t.eq(reach.internals.isPrivateHost(new URL('http://172.31.255.1/')), true);
      t.eq(reach.internals.isPrivateHost(new URL('http://172.32.0.1/')), false);
      t.eq(reach.internals.isPrivateHost(new URL('https://www.bilibili.com/')), false);
      t.eq(reach.internals.isPrivateHost(new URL('http://169.254.1.1/')), true);
    }
  },

  {
    name: 'HTML 正文抽取 / 实体解码 / RSS-Atom 解析（纯函数）',
    async run(t) {
      const I = reach.internals;

      const html = '<html><head><title>标题 &amp; 测试</title><style>.a{color:red}</style></head>'
        + "<body><h1>大标题</h1><p>你好&nbsp;世界</p><script>alert('x')</script>"
        + '<div>第二段 &#39;引号&#39;</div></body></html>';
      const text = I.htmlToText(html);
      t.contains(text, '大标题');
      t.contains(text, '你好 世界');
      t.contains(text, '第二段');
      t.notContains(text, 'alert', 'script 内容必须被剁掉');
      t.notContains(text, 'color:red', 'style 内容必须被剁掉');
      t.notContains(text, '<p>');
      t.eq(I.pickTitle(html), '标题 & 测试');
      t.eq(I.decodeEntities('&amp;&lt;&gt;&quot;&#39;&mdash;&#x41;'), '&<>"\'' + '—A');
      t.eq(I.stripTags('<b>甲</b> &amp; <i>乙</i>'), '甲 & 乙');

      const rss = '<?xml version="1.0"?><rss><channel><title>频道</title>'
        + '<item><title>第一篇</title><link>https://example.com/1</link>'
        + '<pubDate>Mon, 05 Jan 2026 00:00:00 GMT</pubDate><description>摘要一</description></item>'
        + '<item><title>第二篇</title><link>https://example.com/2</link>'
        + '<pubDate>Tue, 06 Jan 2026 00:00:00 GMT</pubDate><description>摘要二</description></item>'
        + '</channel></rss>';
      const items = I.parseFeed(rss, 10);
      t.eq(items.length, 2);
      t.eq(items[0].title, '第一篇');
      t.eq(items[0].link, 'https://example.com/1');
      t.contains(items[0].date, '2026');
      t.eq(items[1].summary, '摘要二');
      t.eq(I.parseFeed(rss, 1).length, 1, 'count 应限制解析条数');

      const atom = '<feed xmlns="http://www.w3.org/2005/Atom">'
        + '<entry><title>Atom 一篇</title><link href="https://example.com/a"/>'
        + '<published>2026-01-07T00:00:00Z</published><summary>原子摘要</summary></entry></feed>';
      const atomItems = I.parseFeed(atom, 5);
      t.eq(atomItems.length, 1);
      t.eq(atomItems[0].title, 'Atom 一篇');
      t.eq(atomItems[0].link, 'https://example.com/a', 'Atom 的 <link href> 也要能取到');
      t.contains(atomItems[0].date, '2026-01-07');
      t.eq(atomItems[0].summary, '原子摘要');

      t.eq(I.parseFeed('<html>不是订阅源</html>', 5).length, 0);
    }
  },

  {
    name: 'buvid3 格式与随机性（B 站风控关键）',
    async run(t) {
      const values = new Set();
      for (let i = 0; i < 20; i += 1) {
        const value = reach.internals.buvid3();
        t.ok(BUVID_RE.test(value), `buvid3 格式不对：${value}`);
        values.add(value);
      }
      t.ok(values.size >= 18, `buvid3 应基本随机（20 次得到 ${values.size} 个不同值）`);
    }
  },

  {
    name: 'mock api.fetch：三个联网工具的成功/失败路径',
    async run(t) {
      const host = createMockHost({ id: 'agent-reach' });
      const htmlArticle = '<html><head><title>文章标题</title></head><body>'
        + `<p>${'正文内容'.repeat(200)}</p><script>bad()</script></body></html>`;
      const rssXml = '<?xml version="1.0"?><rss><channel>'
        + '<item><title>订阅一篇</title><link>https://example.com/post-1</link>'
        + '<pubDate>Mon, 05 Jan 2026 00:00:00 GMT</pubDate></item>'
        + '</channel></rss>';
      const biliOk = {
        code: 0,
        data: {
          numResults: 2,
          result: [
            { title: '视频<em>一</em>', author: 'UP甲', play: 1000, duration: '10:00', bvid: 'BV1xx411c7mD' },
            { title: '视频二', author: 'UP乙', play: 2000, duration: '20:00', bvid: 'BV2yy411c7mE' }
          ]
        }
      };
      let biliMode = 'ok';
      const requests = installFetchMock(host, async (url) => {
        if (url.includes('api.bilibili.com')) {
          if (biliMode === 'risk') {
            return new Response(JSON.stringify({ code: -412, message: '请求被拦截' }), {
              status: 200, headers: { 'content-type': 'application/json' }
            });
          }
          if (biliMode === 'http412') return new Response('', { status: 412 });
          return new Response(JSON.stringify(biliOk), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('feed.xml') || url.endsWith('.xml')) {
          return new Response(rssXml, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
        }
        if (url.includes('blocked')) return new Response('nope', { status: 403 });
        if (url.includes('timeout')) {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          throw error;
        }
        if (url.includes('article')) {
          return new Response(htmlArticle, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (url.includes('not-a-feed')) {
          return new Response('<html><body>这里没有条目</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('', { status: 404 });
      });
      reach.register(host.api);
      const ctx = host.ctx({});

      // web_read 成功：标题 + 正文 + 截断提示；script 被剁掉
      const web = await host.tools.get('web_read').execute(ctx, { url: 'https://example.com/article', maxChars: 500 });
      t.eq(web.isError, undefined);
      t.contains(web.content, '《文章标题》');
      t.contains(web.content, '正文内容');
      t.contains(web.content, '已截断');
      t.notContains(web.content, 'bad()');

      // web_read 失败：HTTP 错误 / 超时都要如实报错，不能编造正文
      let bad = await host.tools.get('web_read').execute(ctx, { url: 'https://example.com/blocked' });
      t.eq(bad.isError, true);
      t.contains(bad.content, 'HTTP 403');
      bad = await host.tools.get('web_read').execute(ctx, { url: 'https://example.com/timeout' });
      t.eq(bad.isError, true);
      t.contains(bad.content, '连接超时');

      // rss_read 成功
      const rss = await host.tools.get('rss_read').execute(ctx, { url: 'https://example.com/feed.xml' });
      t.eq(rss.isError, undefined);
      t.contains(rss.content, '订阅一篇');
      t.contains(rss.content, 'https://example.com/post-1');

      // bili_search 成功：带 buvid3 / UA / referer，条数受 count 限制
      const bili = await host.tools.get('bili_search').execute(ctx, { keyword: '鲸鱼 女仆', count: 1 });
      t.eq(bili.isError, undefined);
      t.contains(bili.content, 'UP甲');
      t.contains(bili.content, 'BV1xx411c7mD');
      t.notContains(bili.content, 'BV2yy411c7mE', 'count=1 时只返回 1 条');
      const biliReq = requests.find((item) => item.url.includes('api.bilibili.com'));
      t.ok(biliReq, '应真的请求 B 站搜索接口');
      t.contains(biliReq.url, 'search_type=video');
      t.contains(biliReq.url, encodeURIComponent('鲸鱼 女仆'));
      t.eq(biliReq.init.headers.referer, 'https://www.bilibili.com/');
      t.contains(biliReq.init.headers['user-agent'], 'Mozilla/5.0');
      t.ok(BUVID_RE.test(String(biliReq.init.headers.cookie).replace(/^buvid3=/, '')), '请求应带随机 buvid3 cookie');

      // bili_search 风控：code=-412 / HTTP 412 如实报错
      biliMode = 'risk';
      bad = await host.tools.get('bili_search').execute(ctx, { keyword: '测试' });
      t.eq(bad.isError, true);
      t.contains(bad.content, '风控');
      biliMode = 'http412';
      bad = await host.tools.get('bili_search').execute(ctx, { keyword: '测试' });
      t.eq(bad.isError, true);
      t.contains(bad.content, 'HTTP 412');

      // 空关键词 / 解析不出条目：可读错误
      bad = await host.tools.get('bili_search').execute(ctx, { keyword: '   ' });
      t.eq(bad.isError, true);
      bad = await host.tools.get('rss_read').execute(ctx, { url: 'https://example.com/not-a-feed' });
      t.eq(bad.isError, true);
      t.contains(bad.content, '没解析出任何条目');
    }
  },

  {
    name: 'reach_doctor：基于当前可用通道自检（不调用 exe、不联网）',
    async run(t) {
      // 有 api.fetch 的宿主
      const host = createMockHost({ id: 'agent-reach' });
      let fetchCalls = 0;
      host.api.fetch = async () => { fetchCalls += 1; throw new Error('doctor 不应联网'); };
      reach.register(host.api);
      t.deepEq(reach.available(), { ok: true });
      const report = await host.tools.get('reach_doctor').execute(host.ctx({}), {});
      t.eq(fetchCalls, 0, 'doctor 只做本地自检，不联网探测');
      t.contains(report.content, '渠道体检');
      t.contains(report.content, 'api.fetch');
      t.contains(report.content, 'web_read');
      t.contains(report.content, 'bili_search');
      t.contains(report.content, 'rss_read');
      t.contains(report.content, '✅');
      t.contains(report.content, 'agent-reach CLI', '应说明不再依赖本机 CLI/exe');
      t.notContains(report.content, 'D:\\qqagent', '不能再去调本机 exe 路径');
      t.notContains(report.content, 'exe 不在位');

      // 没有 web_fetch 权限（宿主没注入 api.fetch）的宿主
      const bare = createMockHost({ id: 'agent-reach' });
      delete bare.api.fetch;
      reach.register(bare.api);
      const unavailable = reach.available();
      t.eq(unavailable && unavailable.ok, false, '没有网络出口时 available() 应报不可用');
      const broken = await bare.tools.get('reach_doctor').execute(bare.ctx({}), {});
      t.eq(broken.isError, true);
      t.contains(broken.content, 'api.fetch');
      const webAttempt = await bare.tools.get('web_read').execute(bare.ctx({}), { url: 'https://example.com/a' });
      t.eq(webAttempt.isError, true);
      t.contains(webAttempt.content, '网络出口不可用');
    }
  }
];
