// Agent Reach（心语移植版）：把「看全网」这件事实用化。
//
// 为什么不是照搬上游 SKILL.md：那份 SKILL.md 是写给会自己跑 shell 的 agent 的
// （curl r.jina.ai / mcporter / gh / twitter-cli …），而心语里的扩展只有工具、
// 没有 shell。所以这里只挑**心语真的能跑通、不需要登录态**的能力做成工具：
//   · web_read   —— 用宿主 api.fetch 抓取 + 现有正文抽取（心语的 fetch 出口已禁内网）
//   · bili_search—— B 站官方搜索接口（保留随机 buvid3 绕过 412 的技巧）
//   · rss_read   —— RSS/Atom 解析（内置正则解析，零第三方依赖）
//   · reach_doctor—— 基于心语当前可用通道的自检（不再调用本机 exe/CLI）
// 需要登录态/境外网络的（小红书、Twitter、Reddit、YouTube、Exa…）**故意不做成工具**：
// 心语网络出口限制与登录态都拿不到，做成工具只会让模型反复失败、浪费轮次。
//
// ── 移植改动（相对 QQ Agent 原实现）──────────────────────────────────────
//   · 删掉 node:child_process / node:fs / node:path 与 D:\qqagent 的本机 exe 依赖
//   · 所有网络请求从全局 fetch 改成宿主 api.fetch（唯一网络出口，自动禁内网/超时/限体积）
//   · reach_doctor 不再跑 agent-reach.exe doctor，改成检查当前宿主通道是否就绪
//   · 工具 id / 名称 / 描述、buvid3 技巧、UA、HTML-RSS 解析逻辑保持原样

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 宿主 api（register(api) 时注入），工具 execute 通过它拿 api.fetch。 */
let host = null;
let registeredFor = null;

/**
 * B 站风控用的 buvid3。2026-10-04 实测（同一台机、同一秒内对比）：
 *   · 裸请求 → 稳定 HTTP 412 code=-412（重试也一样，26ms 就被拒）
 *   · 带一个随机 buvid3 cookie → HTTP 200 code=0，20 条结果
 * 所以每次搜索都塞一个新的 buvid3，别去掉。
 */
function buvid3() {
  const h = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
  return `${h}infoc`;
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

/** 明显指向内网的地址直接拒掉：模型可能被「读一下 http://127.0.0.1:3210/...」这种话诱导。 */
function isPrivateHost(u) {
  const h = String(u?.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\.|^0\.|^10\.|^169\.254\.|^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** HTML → 纯文本：先剁掉脚本/样式/注释，再按块级标签换行，最后压空白。 */
function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter((l) => l.length > 1).join('\n')
    .trim();
}

/** 网络出口：只走宿主 api.fetch（无全局 fetch）。 */
function requireFetch() {
  if (!host || typeof host.fetch !== 'function') {
    throw new Error('网络出口不可用：宿主没有提供 api.fetch（检查 skill.json 的 permissions 是否含 web_fetch）');
  }
  return host.fetch;
}

/**
 * 抓取文本。心语 api.fetch 自带 20s 超时、禁内网/本机、8MB 响应体上限，这里不再叠 AbortSignal。
 * @returns {{status:number, ok:boolean, contentType:string, text:string}}
 */
async function fetchText(url) {
  const fetchImpl = requireFetch();
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
    }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = String(res.headers?.get?.('content-type') || '');
  let text = buf.toString('utf8');
  if (/charset=(gbk|gb2312|gb18030)/i.test(ct)) {
    try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保底用 utf8 */ }
  }
  return { status: Number(res.status) || 0, ok: Boolean(res.ok), contentType: ct, text };
}

function pickTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** XML 里的 <item>/<entry> 用正则取前 n 条 —— 不引第三方依赖，够用。 */
function parseFeed(xml, n) {
  const blocks = String(xml).match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const pick = (b, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(b);
    return m ? stripTags(m[1]) : '';
  };
  return blocks.slice(0, n).map((b) => {
    const link = pick(b, 'link') || (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '');
    return {
      title: pick(b, 'title') || '（无标题）',
      link,
      date: pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || '',
      summary: pick(b, 'description') || pick(b, 'summary') || ''
    };
  });
}

/** 网址校验（工具共用）：返回 {url} 或 {error}。 */
function checkUrl(raw) {
  const u = isHttpUrl(raw);
  if (!u) return { error: '错误：url 必须是 http/https 开头的完整地址' };
  if (isPrivateHost(u)) return { error: `错误：${u.hostname} 指向本机/内网，不允许抓取` };
  return { url: u };
}

function timeoutMessage(error) {
  const name = String(error?.name || '');
  const text = String(error?.message ?? error);
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|超时|aborted/i.test(text)) {
    return '连接超时（网络不可达或站点响应太慢）';
  }
  return text;
}

export function register(api) {
  host = api || host;
  // 重复 setup/register 幂等：同一个宿主实例只注册一次；换新宿主实例才重新注册
  if (registeredFor === api) return;
  registeredFor = api;
  const log = typeof api?.log === 'function' ? api.log : () => {};

  api.registerTool({
    id: 'web_read',
    name: '读网页',
    description: '抓取网页正文并转成纯文本（去脚本/样式/标签）。适合「这个链接讲了什么」。境外站点本机常超时。',
    category: 'web',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页地址（http/https）' },
        maxChars: { type: 'number', description: '正文最多返回多少字，默认 4000，上限 12000' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const checked = checkUrl(args?.url);
      if (checked.error) return { content: checked.error, isError: true };
      const u = checked.url;
      const maxChars = Math.max(400, Math.min(12000, Number(args?.maxChars) || 4000));
      try {
        const r = await fetchText(u.href);
        if (!r.ok) {
          return {
            content: `抓取失败：HTTP ${r.status}（${u.href}）${r.status === 403 || r.status === 412 ? '，多半是站点风控，需要登录/换地址' : ''}`,
            isError: true
          };
        }
        const text = /html/i.test(r.contentType) || /<html/i.test(r.text.slice(0, 500)) ? htmlToText(r.text) : r.text.trim();
        if (!text) {
          return { content: `抓到了 HTTP ${r.status}，但正文是空的（多半是全 JS 渲染的页面，扩展没有浏览器渲染通道）`, isError: true };
        }
        const title = /html/i.test(r.contentType) ? pickTitle(r.text) : '';
        const cut = text.length > maxChars;
        return {
          content: `${title ? `《${title}》\n` : ''}${text.slice(0, maxChars)}${cut ? `\n…（正文共 ${text.length} 字，已截断，需要更多就再调一次把 maxChars 调大）` : ''}`
        };
      } catch (error) {
        return { content: `抓取失败：${timeoutMessage(error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'bili_search',
    name: '搜B站视频',
    description: 'B 站官方搜索接口搜视频，返回标题/UP主/播放量/时长/链接。无需登录。',
    category: 'web',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回条数，默认 5，上限 20' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      const kw = String(args?.keyword ?? '').trim();
      if (!kw) return { content: '错误：请给出搜索关键词', isError: true };
      const n = Math.max(1, Math.min(20, Number(args?.count) || 5));
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(kw)}`;
      try {
        const fetchImpl = requireFetch();
        const res = await fetchImpl(url, {
          headers: {
            'user-agent': UA,
            referer: 'https://www.bilibili.com/',
            accept: 'application/json',
            cookie: `buvid3=${buvid3()}`
          }
        });
        if (!res.ok) {
          const hint = res.status === 412 || res.status === 403 ? '（B 站风控：已带随机 buvid3 cookie 仍被拒，等一会儿再试）' : '';
          return { content: `B 站搜索失败：HTTP ${res.status}${hint}`, isError: true };
        }
        const data = await res.json();
        if (data?.code !== 0) {
          const hint = data?.code === -412 || data?.code === -403 ? '（B 站风控，稍后重试）' : '';
          return { content: `B 站搜索失败：code=${data?.code} ${data?.message || ''}${hint}`, isError: true };
        }
        const arr = Array.isArray(data?.data?.result) ? data.data.result : [];
        if (!arr.length) return { content: `B 站没搜到「${kw}」的视频` };
        const lines = arr.slice(0, n).map((v, i) => {
          const title = stripTags(v.title);
          const link = v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : (v.arcurl || '');
          return `${i + 1}. ${title}\n   UP主 ${v.author || '—'} · 播放 ${v.play ?? '—'} · 时长 ${v.duration || '—'} · ${link}`;
        });
        return { content: `B 站「${kw}」的前 ${Math.min(n, arr.length)} 个结果：\n${lines.join('\n')}\n（共 ${data.data.numResults ?? arr.length} 个结果）` };
      } catch (error) {
        return { content: `B 站搜索失败：${timeoutMessage(error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'rss_read',
    name: '读RSS',
    description: '读取 RSS/Atom 订阅源，返回最近几条的标题、时间、链接。',
    category: 'web',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RSS/Atom 源地址' },
        count: { type: 'number', description: '返回条数，默认 8，上限 30' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const checked = checkUrl(args?.url);
      if (checked.error) return { content: checked.error, isError: true };
      const u = checked.url;
      const n = Math.max(1, Math.min(30, Number(args?.count) || 8));
      try {
        const r = await fetchText(u.href);
        if (!r.ok) return { content: `读取失败：HTTP ${r.status}`, isError: true };
        const items = parseFeed(r.text, n);
        if (!items.length) return { content: '这个地址里没解析出任何条目（不是 RSS/Atom，或者内容在 JS 里）', isError: true };
        const lines = items.map((it, i) => `${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ''}${it.link ? `\n   ${it.link}` : ''}`);
        return { content: `订阅源共取到 ${items.length} 条：\n${lines.join('\n')}` };
      } catch (error) {
        return { content: `读取失败：${timeoutMessage(error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'reach_doctor',
    name: '渠道体检',
    description: '运行 Agent Reach 的 doctor，报告哪些平台渠道现在可用、哪些缺登录态。',
    category: 'system',
    icon: '🩺',
    parameters: { type: 'object', properties: {} },
    async execute() {
      // 心语移植版：不再调用本机 agent-reach.exe，只检查当前宿主真正给了哪些通道。
      // 不联网探测（境外站点/风控会导致误报），实际可用性以工具返回的真实错误为准。
      try {
        const fetchOk = typeof host?.fetch === 'function';
        const toolList = typeof host?.tools?.all === 'function' ? host.tools.all() : [];
        const hasTool = (id) => {
          if (toolList.some((t) => String(t?.id ?? t?.function?.name ?? '').endsWith(id))) return true;
          // 宿主工具表拿不到时，按"本技能已注册"算（execute 时仍会如实报错）
          return !toolList.length;
        };
        const rows = [];
        rows.push(`${fetchOk ? '✅' : '❌'} 网络出口 api.fetch${fetchOk ? '（禁内网/本机、20s 超时、8MB 上限）' : '：不可用（检查 skill.json 的 permissions 是否含 web_fetch）'}`);
        rows.push(`${fetchOk ? '✅' : '❌'} web_read 网页正文抽取（内置 HTML→纯文本，无需 Jina）`);
        rows.push(`${fetchOk ? '✅' : '❌'} bili_search B 站官方搜索接口（随机 buvid3 绕过 412）`);
        rows.push(`${fetchOk ? '✅' : '❌'} rss_read RSS/Atom 解析（内置正则解析，零依赖）`);
        rows.push('❌ 需登录态/境外网络的渠道（小红书 / Twitter(X) / Reddit / YouTube / Exa 等）：本移植版未提供');
        const ready = rows.filter((r) => r.startsWith('✅')).length;
        const note = '口径：doctor 只做本地通道自检（心语宿主给了哪些出口/工具），不联网探测——'
          + '境外站点与 B 站风控经常让探测结果失真，真实可用性请看每次工具调用的返回。'
          + '心语移植版不再依赖本机 agent-reach CLI / exe。';
        return {
          content: `Agent Reach 渠道体检（心语移植版）：${ready}/${rows.length} 条通道可用\n${rows.join('\n')}\n\n${note}`,
          isError: !fetchOk
        };
      } catch (error) {
        return { content: `渠道体检失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  log('Agent Reach 技能已注册（web_read / bili_search / rss_read / reach_doctor，网络统一走心语 api.fetch）');
}

// 宿主的统一入口（部分宿主只认 setup）；重复调用由 registered 兜住
export const setup = register;

/** 可用性判定必须同步：只有网络出口缺失时才算不可用（工具自身会如实报错）。 */
export function available() {
  return typeof host?.fetch === 'function' ? { ok: true } : { ok: false, reason: '缺少 api.fetch（web_fetch 权限）' };
}

// 离线自检用（不参与运行时逻辑）
export const internals = {
  UA, buvid3, isHttpUrl, isPrivateHost, decodeEntities, htmlToText, pickTitle, stripTags,
  parseFeed, checkUrl, timeoutMessage, fetchText, TOOL_IDS: ['web_read', 'bili_search', 'rss_read', 'reach_doctor']
};
