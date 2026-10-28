/**
 * 控制面板前端（单文件，无外部依赖）。
 *
 * 目标：傻瓜式操作——每一步都有说明、有默认值、有「测试」按钮，出错时给出人能看懂的修复指引。
 * 同时把规划书里的高级能力（作用域隔离、决策审计、费用账单、能力门控）都做成可视化界面。
 */
import { icon, brandMark } from "./ui-icons.mjs";

export const APP_JS = String.raw`
const launchToken = new URLSearchParams(location.hash.slice(1)).get("panelToken");
if (launchToken) {
  sessionStorage.setItem("heartechoPanelToken", launchToken);
  history.replaceState(null, "", location.pathname + location.search);
}
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const S = { page: "overview", status: null, config: null, characters: [], activeCharacter: null, providers: [], taskTypes: [], life: null, memory: null, schedule: null, qzone: null, system: null, llm: null, groups: null, convs: [], providersLoaded: false, wizards: {}, onboarding: null, logLevel: "info", decideText: "", simText: "", groupSel: "", busy: {} };
document.documentElement.setAttribute("data-heartecho", "booting");
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\u0022": "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ENT[c]);
const t = (ts) => { if (!ts) return "—"; const d = new Date(ts); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
const ago = (ts) => { if (!ts) return "从未"; const diff = Date.now() - ts; if (diff < 60000) return "刚刚"; if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前"; if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前"; return Math.floor(diff / 86400000) + " 天前"; };
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : (d ?? 0));
const money = (v) => "¥" + (Number(v) || 0).toFixed(3);
/*
 * 等一会儿。
 *
 * 面板里「重连 QQ」「修复协议端」「重启」都要等几秒再重新拉状态，
 * 但以前这个函数只有在服务端才存在，浏览器里从来没有定义过——
 * 于是这三处 await sleep(4000) 会直接抛 ReferenceError，
 * 后面的 render() 永远不会执行：用户点了按钮，看到一句 toast，界面就再也不动了。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json" } };
  const token = sessionStorage.getItem("heartechoPanelToken");
  if (token) opts.headers.Authorization = "Bearer " + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch { json = { ok: false, message: "服务没有返回合法 JSON（HTTP " + res.status + "）" }; }
  if (!res.ok && json && json.message === undefined) json.message = "HTTP " + res.status;
  return json;
}

function toast(message, kind = "info", title = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  const ic = kind === "ok" ? "check" : kind === "error" ? "alert" : kind === "warn" ? "alert" : "info";
  el.innerHTML = '<span style="color:var(--' + (kind === "ok" ? "ok" : kind === "error" ? "danger" : kind === "warn" ? "warn" : "info") + ')">' + ICON(ic, 18) + "</span><div><div>" + esc(message) + "</div>" + (title ? '<div class="tiny muted mt-sm">' + esc(title) + "</div>" : "") + "</div>";
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; el.style.transition = "all .3s"; setTimeout(() => el.remove(), 320); }, kind === "error" ? 7000 : 3800);
}

function ICON(name, size) {
  const p = ICONS[name] || ICONS.dot;
  return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>";
}

/** 品牌标记：一颗心和一颗星，和 favicon 同一套线条。 */
function brandMark(size) {
  const s = size || 24;
  return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20.2S4.8 15.8 4.8 10.9A4.1 4.1 0 0 1 12 8.1a4.1 4.1 0 0 1 7.2 2.8c0 4.9-7.2 9.3-7.2 9.3Z"/>' +
    '<path d="M16.4 3.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z"/></svg>';
}

/* ------------------------------- 通用片段 ------------------------------- */

function card(opts) {
  return '<section class="card' + (opts.className ? " " + opts.className : "") + '">' +
    (opts.title ? '<div class="card-head">' + (opts.icon ? '<div class="card-icon">' + ICON(opts.icon, 17) + "</div>" : "") + "<h2>" + esc(opts.title) + "</h2>" + (opts.hint ? '<div class="hint">' + opts.hint + "</div>" : "") + "</div>" : "") +
    (opts.body || "") + "</section>";
}

function pill(text, kind, dot) {
  return '<span class="pill' + (kind ? " " + kind : "") + '">' + (dot ? '<span class="dot' + (dot === "pulse" ? " pulse" : "") + '"></span>' : "") + esc(text) + "</span>";
}

function switchRow(id, label, checked, hint) {
  return '<label class="switch" style="margin:2px 0"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + '><span class="track"></span><span>' + esc(label) + (hint ? ' <span class="tiny muted">' + esc(hint) + "</span>" : "") + "</span></label>";
}

function field(label, id, value, opts) {
  opts = opts || {};
  const tag = opts.tag || (opts.rows ? "textarea" : "input");
  const type = opts.type || "text";
  const attrs = 'id="' + id + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : "") + (opts.rows ? ' rows="' + opts.rows + '"' : ' type="' + type + '"') + (opts.min !== undefined ? ' min="' + opts.min + '"' : "") + (opts.max !== undefined ? ' max="' + opts.max + '"' : "") + (opts.step !== undefined ? ' step="' + opts.step + '"' : "");
  return '<div class="field"><label for="' + id + '">' + esc(label) + (opts.tip ? ' <span class="tiny muted">' + esc(opts.tip) + "</span>" : "") + "</label>" +
    (tag === "textarea" ? "<textarea " + attrs + ">" + esc(value ?? "") + "</textarea>" : "<input " + attrs + ' value="' + esc(value ?? "") + '">') + "</div>";
}

function selectField(label, id, value, options, hint) {
  return '<div class="field"><label for="' + id + '">' + esc(label) + (hint ? ' <span class="tiny muted">' + esc(hint) + "</span>" : "") + "</label><select id='" + id + "'>" +
    options.map((o) => '<option value="' + esc(o.value) + '"' + (String(o.value) === String(value) ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") + "</select></div>";
}

function emptyState(title, desc, iconName) {
  return '<div class="empty">' + ICON(iconName || "inbox", 34) + '<div class="t">' + esc(title) + '</div><div class="d">' + esc(desc || "") + "</div></div>";
}

function stat(k, v, extra) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + (extra ? "<small>" + esc(extra) + "</small>" : "") + "</div></div>";
}

function bar(ratio, kind) {
  const pct = Math.max(0, Math.min(100, (Number(ratio) || 0) * 100));
  return '<div class="bar ' + (kind || (pct >= 100 ? "danger" : pct >= 80 ? "warn" : "ok")) + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
}

function bind(id, event, handler) { const el = document.getElementById(id); if (el) el.addEventListener(event, handler); return el; }
function val(id) { const el = document.getElementById(id); return el ? el.value : ""; }
function checked(id) { const el = document.getElementById(id); return el ? el.checked : false; }

/* ------------------------------- 页面定义 ------------------------------- */

const NAV = [
  { group: "陪伴" },
  { id: "overview", label: "总览", icon: "gauge" },
  { id: "studio", label: "角色工作室", icon: "feather" },
  { id: "chat", label: "试聊与对话", icon: "chat" },
  { id: "dialog", label: "对话设置", icon: "sliders" },
  { group: "关系" },
  { id: "groups", label: "群聊与审核", icon: "users" },
  { id: "memory", label: "记忆", icon: "layers" },
  { id: "interaction", label: "记忆与互动", icon: "sliders" },
  { id: "life", label: "数字生命", icon: "brain" },
  { group: "主动" },
  { id: "schedule", label: "主动与日程", icon: "bell" },
  { id: "weather", label: "天气与位置", icon: "cloudRain" },
  { id: "qzone", label: "QQ 空间", icon: "cloud" },
  { group: "扩展" },
  { id: "extensions", label: "插件与技能", icon: "layers" },
  { group: "系统" },
  { id: "account", label: "QQ 账号", icon: "user" },
  { id: "llm", label: "模型与资费", icon: "cpu" },
  { id: "system", label: "运行环境", icon: "settings" },
  { id: "logs", label: "日志", icon: "terminal" },
];

function renderNav() {
  const collapsed = localStorage.getItem("he.nav") === "1";
  const side = $("#sidebar");
  side.className = "sidebar" + (collapsed ? " collapsed" : "");
  side.innerHTML =
    '<div class="brand"><div class="brand-logo">' + brandMark(22) + '</div><div class="brand-text"><span class="brand-name">心语 · HeartEcho</span><span class="brand-sub">QQ 数字生命伴侣</span></div></div>' +
    NAV.map((item) => item.group
      ? '<div class="nav-group-title">' + esc(item.group) + "</div>"
      : '<div class="nav-item' + (S.page === item.id ? " active" : "") + '" data-page="' + item.id + '">' + ICON(item.icon, 20) + '<span class="nav-label">' + esc(item.label) + "</span></div>"
    ).join("") +
    '<div class="side-foot"><div class="side-foot-text">数据目录<br>' + esc((S.status && S.status.paths && S.status.paths.data) || "…") + '</div>' +
    '<button class="btn ghost sm block" id="btnCollapse">' + ICON(collapsed ? "chevronRight" : "menu", 15) + '<span class="side-foot-text">' + (collapsed ? "" : "收起侧栏") + "</span></button></div>";
  $$("#sidebar .nav-item").forEach((el) => el.addEventListener("click", () => { go(el.dataset.page); $("#sidebar").classList.remove("open"); }));
  bind("btnCollapse", "click", () => { localStorage.setItem("he.nav", collapsed ? "0" : "1"); renderNav(); });
}

function go(page) {
  S.page = page;
  location.hash = page;
  renderNav();
  render();
}

/* --------------------------------- 总览 --------------------------------- */

async function pageOverview() {
  const st = S.status || (S.status = await api("/api/status"));
  const cfg = st.config || {};
  const bot = st.bots || {};
  const ob = st.onebot || {};
  const health = st.health || { checks: [] };
  const char = st.character || {};

  // QQ 没连上时，先问协议端到底卡在哪 —— 用户看到的第一块内容必须是「怎么修」
  let repair = "";
  if (!ob.online) {
    const proto = await api("/api/protocol").catch(() => null);
    const blocker = proto?.blockers?.[0];
    const canStart = proto?.looksLikeProtocol && proto?.node && !proto?.running;
    repair = card({
      title: "QQ 连不上，先修这一步",
      icon: "alert",
      className: "repair-card",
      hint: "不用刷新，点按钮就行",
      body:
        '<div class="notice danger">' + ICON("alert", 18) + '<div><div class="nt">' +
        esc(blocker?.title || "还没连上 QQ") +
        '</div><div class="nd">' + esc(blocker?.detail || ob.lastError || "协议端（把 QQ 变成接口的那个程序）大概没在运行。") +
        "</div></div></div>" +
        '<div class="small soft mt-sm">建议动作：' + esc(blocker?.fix || proto?.nextAction || "点下面的按钮让心语自动处理") + "</div>" +
        '<div class="row mt">' +
        (canStart
          ? '<button class="btn primary" id="btnFixProtocol">' + ICON("play", 16) + "一键启动协议端</button>"
          : '<button class="btn primary" id="btnFixProtocol">' + ICON("wand", 16) + "自动诊断并修复</button>") +
        '<button class="btn" id="btnReconnectQq">' + ICON("refresh", 16) + "重新连接 QQ</button>" +
        '<button class="btn ghost" id="btnProtocolLog">' + ICON("terminal", 16) + "看协议端日志</button>" +
        "</div>" +
        '<div id="fixOut" class="mt"></div>',
    });
  }

  const wx = st.weather;
  const statusPills = [
    ob.online ? pill("QQ 已连接：" + (ob.nickname || ob.selfId), "ok", "pulse") : pill("QQ 未连接", "danger", "pulse"),
    st.llm && st.llm.ready ? pill("模型就绪：" + st.llm.model, "ok") : pill("模型未配置", "warn"),
    st.paused && st.paused.paused ? pill("自动化已暂停", "warn") : pill("自动运行中", "accent"),
    st.memory ? pill("记忆 " + st.memory.total + " 条", "info") : "",
    wx && wx.ok ? pill((wx.city || "本地") + " " + (wx.text || "") + (Number.isFinite(wx.min) ? " " + Math.round(wx.min) + "~" + Math.round(wx.max) + "℃" : ""), "info") : "",
  ].filter(Boolean).join(" ");

  const healthHtml = (health.checks || []).map((c) => '<div class="notice ' + (c.ok ? "ok" : "warn") + '">' + ICON(c.ok ? "check" : "alert", 18) + '<div><div class="nt">' + esc(c.label) + (c.ok ? "" : " · 需要处理") + '</div><div class="nd">' + esc(c.detail) + "</div></div></div>").join("");

  const budget = st.budget || { scopes: [] };
  const budgetRows = (budget.scopes || []).filter((s) => s.limit > 0).map((s) =>
    '<div style="margin-bottom:10px"><div class="row"><span class="small soft">' + esc(s.label) + '</span><span class="spacer"></span><span class="small mono">' + money(s.spent) + " / " + money(s.limit) + "</span></div>" + bar(s.ratio) + "</div>"
  ).join("") || '<div class="muted small">还没有设置预算上限（到「模型与资费」里设一个，避免花超）</div>';

  // 「我现在能做什么」——新手最缺的就是这个
  const nextSteps = [
    { done: Boolean(char.name), icon: "feather", title: "写她的角色卡", desc: "「角色工作室」里改人设和说话风格，保存立刻生效", page: "studio" },
    { done: Boolean(st.llm && st.llm.ready), icon: "key", title: "确认模型能用", desc: "「模型与资费」点「测试连接」就好", page: "llm" },
    { done: Boolean(ob.online), icon: "plug", title: "连上 QQ", desc: "协议端跑起来后 QQ 会自动连上", page: "account" },
    { done: Boolean(bot.masterId), icon: "user", title: "填好两个 QQ 号", desc: "「QQ 账号」里填机器人号和你的号", page: "account" },
    { done: num(st.storage && st.storage.todayMessages) > 0, icon: "chat", title: "直接去 QQ 里跟她说话", desc: "发一句「记住：我不吃香菜」试试，她会记下来", page: "chat" },
  ];
  const stepsHtml = nextSteps.map((item, index) =>
    '<div class="row" style="padding:8px 0;border-bottom:1px solid rgba(148,163,199,.1)">' +
    '<span style="color:var(--' + (item.done ? "ok" : "text-dim") + ')">' + ICON(item.done ? "check" : item.icon, 17) + "</span>" +
    '<div style="flex:1;min-width:0"><div class="small' + (item.done ? " muted" : "") + '" style="font-weight:560">' + (index + 1) + ". " + esc(item.title) + '</div>' +
    '<div class="tiny muted">' + esc(item.desc) + "</div></div>" +
    (item.done ? pill("已就绪", "ok") : '<button class="btn sm ghost" data-goto="' + item.page + '">去处理</button>') +
    "</div>"
  ).join("");

  const otherEdition = st.otherEdition && st.otherEdition.running
    ? '<div class="notice warn mb">' + ICON("alert", 18) + '<div><div class="nt">检测到' + esc(st.otherEdition.name) + '也在运行</div><div class="nd">两个版本的协议端可能争用同一个 QQ 客户端。请先退出另一版本，再连接 QQ。</div></div></div>' : "";
  return otherEdition + repair + '<div class="grid cols-2">' +
    '<div>' +
    card({
      title: "她现在怎么样", icon: "moon",
      hint: "点右上角可以一键暂停所有自动行为",
      body: '<div class="row" style="gap:14px;align-items:flex-start"><div class="avatar-lg">' + esc((char.name || "心").slice(0, 1)) + '</div><div style="flex:1;min-width:0">' +
        '<div style="font-size:17px;font-weight:640">' + esc(char.name || "（还没有角色）") + '</div>' +
        '<div class="small muted">' + esc(char.title || "") + "</div>" +
        '<div class="row mt-sm">' + statusPills + "</div></div></div>" +
        '<div class="row mt" style="gap:10px">' +
        '<button class="btn primary" id="btnPause">' + ICON(st.paused && st.paused.paused ? "play" : "pause", 16) + (st.paused && st.paused.paused ? "恢复自动" : "一键暂停") + "</button>" +
        '<button class="btn" id="btnSandboxJump">' + ICON("chat", 16) + "试聊一下</button>" +
        '<button class="btn ghost" id="btnRefresh">' + ICON("refresh", 16) + "刷新</button>" +
        "</div>",
    }) +
    card({
      title: "联结状态", icon: "plug",
      body: healthHtml + '<div class="kv mt"><span class="k">机器人 QQ</span><span class="mono">' + esc(bot.selfId || "—") + '</span><span class="k">对方 QQ</span><span class="mono">' + esc(bot.masterId || "还没设置") + '</span><span class="k">控制面板</span><span class="mono">' + esc(bot.panel || "") + "</span></div>" +
        '<div class="row mt-sm"><button class="btn sm" id="btnJumpAccount">' + ICON("user", 15) + "改 QQ 号</button>" +
        '<button class="btn sm ghost" id="btnJumpTray">' + ICON("settings", 15) + "启动与托盘</button></div>",
    }) +
    "</div>" +
    '<div>' +
    card({
      title: "今天在做什么", icon: "activity",
      body: '<div class="grid cols-2" style="gap:12px">' +
        stat("今日消息", num(st.storage && st.storage.todayMessages)) +
        stat("记忆条数", num(st.memory && st.memory.total)) +
        stat("进过的群", num(st.groups)) +
        stat("模型调用", num(st.llm && st.llm.calls)) +
        stat("运行时长", Math.floor(num(st.uptimeSec) / 3600) + "h" + Math.floor((num(st.uptimeSec) % 3600) / 60) + "m") +
        stat("上次回复", ago(st.chat && st.chat.lastReply && st.chat.lastReply.at)) +
        "</div>" +
        (st.schedule && st.schedule.lastSent ? '<div class="notice info mt">' + ICON("bell", 18) + '<div><div class="nt">最近一次主动消息</div><div class="nd">' + esc(st.schedule.lastSent.text) + " · " + ago(st.schedule.lastSent.at) + "</div></div></div>" : ""),
    }) +
    card({ title: "费用保护", icon: "wallet", hint: "达到 80% 会预警，100% 自动熔断", body: budgetRows }) +
    card({ title: "我现在能做什么", icon: "target", hint: "按顺序做完，她就能正常陪你了", body: stepsHtml + '<div class="row mt-sm"><button class="btn sm ghost" id="btnRerunWizard">' + ICON("wand", 15) + "重新走一遍引导</button></div>" }) +
    "</div></div>";
}

/* -------------------------------- QQ 账号 -------------------------------- */

/**
 * 「机器人用哪个号、跟谁说」这两个数字以前埋在「运行环境」里，用户根本找不到。
 * 现在单独一页：左边改号，右边一眼看到协议端到底接管了哪些号。
 */
async function pageAccount() {
  const res = await api("/api/account");
  const inst = await api("/api/instances").catch(() => null);
  const cfg = res || {};
  const loggedNick = (cfg.loggedIn && cfg.loggedIn.nickname) || "";
  const loggedId = (cfg.loggedIn && cfg.loggedIn.selfId) || "";

  const statePills = [
    cfg.online ? pill("QQ 已连接：" + (loggedNick || loggedId), "ok", "pulse") : pill("QQ 未连接", "danger", "pulse"),
    pill("协议端目录：" + (cfg.protocolDirExists ? "存在" : "没找到"), cfg.protocolDirExists ? "info" : "warn"),
  ].join(" ");

  const configs = cfg.configs || [];
  const rows = configs.length
    ? '<div class="table-wrap"><table><thead><tr><th>QQ 号</th><th>WebSocket 端口</th><th>HTTP 端口</th><th>状态</th></tr></thead><tbody>' +
      configs
        .map((item) => {
          const current = String(item.selfId) === String(cfg.selfId);
          return '<tr><td class="mono">' + esc(item.selfId) + (current ? ' <span class="pill ok">当前使用</span>' : "") + "</td>" +
            '<td class="mono small">' + esc((item.wsPorts || []).join("、") || "—") + "</td>" +
            '<td class="mono small">' + esc((item.httpPorts || []).join("、") || "—") + "</td>" +
            "<td>" + (item.readable ? pill("可读", "ok") : pill("配置读不出来", "warn")) + "</td></tr>";
        })
        .join("") +
      "</tbody></table></div>"
    : '<div class="notice warn">' + ICON("alert", 18) + '<div><div class="nt">协议端里还没有任何 QQ 号</div><div class="nd">先启动协议端并登录 QQ，这里就会出现对应的配置文件。</div></div></div>';

  const accountCard = card({
    title: "QQ 账号", icon: "user", hint: "改完点保存",
    body:
      '<div class="row mb">' + statePills + "</div>" +
      '<div class="grid cols-2" style="gap:0 16px">' +
      field("机器人 QQ 号", "acc_self", cfg.selfId, { tip: "在 QQ 里登录、并且能正常收发的那个号" }) +
      field("对方 QQ 号", "acc_master", cfg.masterId, { tip: "你自己" }) +
      "</div>" +
      field("对方的称呼", "acc_mastername", cfg.masterName) +
      '<div class="row">' +
      '<button class="btn primary" id="btnSaveAccount">' + ICON("save", 16) + "保存</button>" +
      '<button class="btn" id="btnAdoptAccount">' + ICON("download", 16) + "用协议端当前登录的号</button>" +
      '<button class="btn ghost" id="btnTestAccount">' + ICON("wifi", 16) + "测试连接</button>" +
      "</div>" +
      '<div id="accountOut" class="mt"></div>' +
      '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nt">换机器人 QQ 号要三步</div><div class="nd">' +
      "① 在这里填新号并保存（心语会顺手给协议端补一份账号配置）；" +
      "② 在 QQ 客户端里退出旧号、登录新号；" +
      "③ 到「运行环境」点「重启协议端」，然后回来点「用协议端当前登录的号」确认。" +
      "</div></div></div>",
  });

  const protocolCard = card({
    title: "协议端中的账号配置", icon: "plug", hint: "配置文件不代表 QQ 已连接",
    body: rows +
      '<div class="kv mt"><span class="k">协议端目录</span><span class="mono tiny" style="word-break:break-all">' + esc(cfg.protocolDir || "—") + "</span>" +
      '<span class="k">当前号的配置</span><span class="mono tiny" style="word-break:break-all">' + esc(cfg.configFile || "—") + "</span>" +
      '<span class="k">这份配置</span><span>' + (cfg.configFound ? pill("已存在", "ok") : pill("还没有", "warn")) + "</span></div>" +
      (cfg.configFound ? "" : '<div class="notice warn mt-sm">' + ICON("alert", 18) + '<div class="nd">当前 QQ 号在协议端里还没有配置，保存上面那张卡时心语会自动补一份。</div></div>'),
  });

  return '<div class="grid cols-2">' + accountCard + protocolCard + "</div>" + '<div class="mt">' + instancesHtml(inst) + "</div>";
}

/* -------------------------------- 多实例 -------------------------------- */

/**
 * 「一个账号 = 一个实例 = 一个角色」。
 *
 * 用户想同时和两个角色聊天时，最自然的做法不是在一个进程里塞两个账号
 * （记忆、关系、日记、端口、协议端登录态全都是单份的，串台风险极高），
 * 而是给第二个角色配第二个 QQ 号、开第二个实例——目录、端口、锁、协议端全都分开。
 * 这张卡就是那个入口：看现有实例、启动它们、以及新建一个。
 */
function instancesHtml(data) {
  const list = (data && data.instances) || [];
  const rows = list
    .map((item) => {
      const state = item.alive
        ? pill(item.online ? "在线" : "已启动·QQ 未连", item.online ? "ok" : "warn", "pulse")
        : pill("未运行", "");
      const title = esc(item.name) + (item.current ? ' <span class="pill info">当前</span>' : "");
      const meta = [
        item.accountId ? "QQ " + esc(item.accountId) : "QQ 未设置",
        item.character ? "角色 " + esc(item.character) : "",
        "面板 " + esc(item.panelPort),
      ]
        .filter(Boolean)
        .join(" · ");
      const actions =
        '<div class="row" style="gap:6px;flex-wrap:wrap">' +
        (item.alive ? '<button class="btn sm" data-inst-open="' + esc(item.dir) + '">打开面板</button>' : '<button class="btn sm primary" data-inst-start="' + esc(item.dir) + '">启动</button>') +
        (item.current ? "" : '<button class="btn sm ghost" data-inst-forget="' + esc(item.id) + '">移出列表</button>') +
        "</div>";
      return '<div style="padding:10px 0;border-bottom:1px solid rgba(148,163,199,.1)">' +
        '<div class="row"><span class="small strong">' + title + "</span>" + state + '<span class="spacer"></span></div>' +
        '<div class="tiny muted mono mt-sm" style="word-break:break-all">' + meta + "</div>" +
        (item.note ? '<div class="tiny muted mt-sm">' + esc(item.note) + "</div>" : "") +
        '<div class="mt-sm">' + actions + "</div>" +
        "</div>";
    })
    .join("") || '<div class="muted small">还没有其它实例。</div>';

  const chars = (S.characters || []).map((c) => ({ value: c.id, label: c.name + "（" + c.id + "）" }));
  return card({
    title: "同时和多个角色聊天（一个账号一个实例）",
    icon: "layers",
    hint: "一个 QQ 号只能开一个实例；两个角色请用两个 QQ 号",
    body:
      '<div class="notice info">' + ICON("info", 18) + '<div><div class="nd">' +
      "同一个 QQ 号在两个实例里同时登录会互相顶下线、消息会串，所以这里做了互斥。" +
      "想同时和另一个角色聊天，就给它配一个新的 QQ 号，新建一个实例——两个实例的数据、端口、面板彼此独立；" +
      "协议端只共用一份（SnowLuma 要往 QQ 客户端里注入 hook，一台机器只能有一份，各跑一份会互相抢钩子，表现为其中一个实例突然掉线）。" +
      "</div></div></div>" +
      '<div class="mt">' + rows + "</div>" +
      '<div class="row mt"><button class="btn" id="btnShowNewInstance">' + ICON("plus", 16) + "新增实例（新账号）</button></div>" +
      '<div id="newInstanceBox" class="hidden mt">' +
      '<div class="grid cols-2" style="gap:0 16px">' +
      field("给这个实例起个名字", "ni_name", "", { tip: "例如「阿尔萨斯」" }) +
      field("机器人 QQ 号（这个角色用哪个号）", "ni_account", "", { tip: "必须是另一个 QQ 号，不能和现在这个重复" }) +
      field("对方 QQ 号（你自己）", "ni_master", "") +
      '<label class="field"><span class="label">复制哪张角色卡过去</span><select id="ni_character">' +
        chars.map((item) => '<option value="' + esc(item.value) + '"' + (item.value === ((S.editingCharacter || S.activeCharacter || {}).id) ? " selected" : "") + '>' + esc(item.label) + "</option>").join("") +
      "</select></label>" +
      "</div>" +
      '<div class="row mt"><button class="btn primary" id="btnCreateInstance">' + ICON("check", 16) + "创建实例</button>" +
      '<span class="spacer"></span><span class="tiny muted">创建后要先在新实例里扫码登录那个 QQ</span></div>' +
      '<div id="niOut" class="mt"></div>' +
      "</div>" +
      '<div class="tiny muted mt-sm">实例目录：' + esc((data && data.root) || "") + "\\instances\\" + "（每个实例都有自己的 心语设置.json / data；协议端共用主实例的 protocol）</div>",
  });
}

/* -------------------------------- 对话设置 -------------------------------- */

/**
 * 「她回得多长、回几条、多积极」这一页。
 * 三个旋钮互相独立，页面下方会实时算出「现在的效果」——不用点保存也能看到会变成什么样。
 */
async function pageDialog() {
  const res = await api("/api/style");
  const st = res.style || {};
  const chat = res.chat || {};
  const files = chat.files || {};
  const model = res.model || {};
  const presets = res.lengthPresets || [];
  const activityPresets = res.activityPresets || [];
  const follow = chat.followUp || {};

  const lengthOptions = presets.map((item) => ({ value: item.chars, label: item.label + " · " + item.chars + " 字" }));
  if (!lengthOptions.some((item) => Number(item.value) === Number(chat.maxReplyChars))) {
    lengthOptions.push({ value: chat.maxReplyChars, label: "自定义 · " + chat.maxReplyChars + " 字" });
  }
  const bubbleOptions = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: n + " 条" }));

  const activityChips = activityPresets
    .map((item) => '<button class="chip' + (Number(chat.activity) === Number(item.value) ? " active" : "") + '" data-activity="' + item.value + '" title="' + esc(item.note) + '">' + esc(item.label) + "</button>")
    .join("");

  return '<div class="grid cols-2">' +
    card({
      title: "回复长度与条数", icon: "filter", hint: "条数是上限，不是必须发这么多",
      body:
        '<div class="grid cols-2" style="gap:0 16px">' +
        selectField("回复长度", "dlg_chars", chat.maxReplyChars, lengthOptions, "单条消息大概多少字") +
        selectField("最多回复几条", "dlg_bubbles", chat.maxBubbles, bubbleOptions, "超过这个数就合并") +
        "</div>" +
        '<div class="notice info">' + ICON("info", 18) + '<div><div class="nt">「几条」只是上限</div><div class="nd">她说什么就发什么：没什么可说的就只发一条，不会为了凑数把一句话硬拆成好几条。</div></div></div>' +
        '<div class="row mt"><button class="btn primary" id="btnSaveDialog">' + ICON("save", 16) + "保存对话设置</button>" +
        '<span class="spacer"></span><span class="tiny muted">改完立刻生效，不用重启</span></div>' +
        '<div id="dlgOut" class="mt"></div>',
    }) +
    card({
      title: "对话活跃度", icon: "activity", hint: "越高越积极，越低越简短",
      body:
        '<div class="activity-head"><span class="big-num" id="dlgActNum">' + esc(chat.activity) + '</span><span class="tiny muted">/ 100</span><span class="spacer"></span><span class="small soft" id="dlgActLabel"></span></div>' +
        '<input type="range" id="dlg_activity" min="0" max="100" step="5" value="' + esc(chat.activity) + '" style="width:100%">' +
        '<div class="row mt-sm">' + activityChips + "</div>" +
        '<div class="notice info mt">' + ICON("sparkle", 18) + '<div><div class="nt">活跃度会改什么</div><div class="nd" id="dlgActEffect"></div></div></div>' +
        '<div class="mt-sm">' +
        switchRow("dlg_follow", "回完之后主动再补一句", follow.enabled !== false, "像真人聊着聊着又想起什么") +
        '<div class="grid cols-2 mt-sm" style="gap:0 16px">' +
        field("追话概率（%）", "dlg_chance", Math.round(Number(follow.chance ?? 0.5) * 100), { type: "number", min: 0, max: 100, tip: "活跃度会再乘一次" }) +
        field("隔多久补（秒）", "dlg_delay", follow.delaySec ?? 9, { type: "number", min: 2, max: 120 }) +
        "</div></div>" +
        '<div class="notice warn mt">' + ICON("alert", 18) + '<div class="nd">只在私聊里追话（群里追等于刷屏）；静默时段、暂停中、预算超限时一律不追。</div></div>',
    }) +
    card({
      title: "现在的效果", icon: "eye", hint: "这是按上面设置算出来的",
      body: '<div id="dlgPreview" class="preview-box">' + esc(st.instruction || "") + "</div>" +
        '<div class="kv mt"><span class="k">最多几条</span><span class="mono">' + esc(st.maxBubbles) + " 条</span>" +
        '<span class="k">单条上限</span><span class="mono">' + esc(st.maxChars) + " 字</span>" +
        '<span class="k">这次想要几条</span><span class="mono">' + esc(st.wantBubbles) + " 条</span>" +
        '<span class="k">追话概率</span><span class="mono">' + esc((Number(st.followUpChance || 0) * 100).toFixed(0)) + "%</span></div>",
    }) +
    (function () {
      const m = model || {};
      const list = (m.available && m.available.length ? m.available : m.preset) || [];
      const options = list.slice();
      if (m.model && !options.includes(m.model)) options.unshift(m.model);
      return card({
        title: "她用什么模型跟你聊", icon: "cpu", hint: "换了模型，说话的味道也会变",
        body:
          (m.ready ? '<div class="row mb-sm">' + pill((m.providerName || m.provider || "") + " · " + (m.model || "—"), "ok") + (m.vision ? pill("支持看图", "info") : "") + (m.contextTokens ? pill("上下文 " + Math.round(m.contextTokens / 1000) + "k", "info") : "") + "</div>"
            : '<div class="notice warn mb">' + ICON("alert", 18) + '<div class="nd">模型还没配好，先去「模型与资费」填 Key。</div></div>') +
          '<div class="row" style="gap:8px;align-items:flex-end">' +
          '<div class="field" style="flex:1;margin:0"><label for="dlg_model">聊天模型</label><select id="dlg_model">' +
          options.map((id) => '<option value="' + esc(id) + '"' + (id === m.model ? " selected" : "") + ">" + esc(id) + "</option>").join("") +
          "</select></div>" +
          '<button class="btn sm ghost" id="btnDlgFetchModels">' + ICON("download", 15) + "拉取可用模型</button>" +
          '<button class="btn primary sm" id="btnDlgSetModel">' + ICON("check", 15) + "用它聊天</button>" +
          "</div>" +
          '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nd">模型名各家经常变（比如 Kimi 的 moonshot-v1-8k 已经下线，调用会 404）。点「拉取可用模型」直接问服务商要真实列表，选一个就行。换模型只影响之后的对话，已有的记忆不受影响。</div></div></div>',
      });
    })() +
    card({
      title: "对方发来的文件", icon: "scroll",
      body:
        '<div class="notice info">' + ICON("info", 18) + '<div><div class="nd">对方在 QQ 上发来的文字文件（txt、md、csv、日志、代码、Word 文档 .docx）她会真的打开看内容，然后照着内容聊。图片、压缩包、PDF 这些她读不出文字，会老实说只看到文件名——不会编。原件存在 data/media/files 下面。</div></div></div>' +
        switchRow("dlg_files", "允许她下载并查看对方发来的文件", files.enabled !== false) +
        '<div class="grid cols-2 mt-sm" style="gap:0 16px">' +
        field("单文件大小上限（KB）", "dlg_file_kb", Math.round((files.maxBytes ?? 2097152) / 1024), { type: "number", min: 16, max: 32768, tip: "超过就不下载" }) +
        field("读进对话的字数上限", "dlg_file_chars", files.maxChars ?? 12000, { type: "number", min: 200, max: 200000, tip: "太长就留头留尾" }) +
        field("之后几轮还能记得这份文件", "dlg_file_turns", files.keepTurns ?? 2, { type: "number", min: 0, max: 5, tip: "0 = 只在收到那一轮能看" }) +
        "</div>" +
        '<div class="row mt-sm"><button class="btn" id="btnSaveFiles">' + ICON("save", 15) + "保存文件设置</button></div>",
    }) +
    card({
      title: "其它小设置", icon: "settings",
      body:
        switchRow("dlg_split", "允许她把一句话拆成几条发", chat.splitBubbles !== false, "更接近真人打字") +
        switchRow("dlg_antistall", "只说了开场白时自动接着说", chat.antiStall !== false, "她偶尔会只回一句「我按我理解的说哦」就没下文；开着会自动补一次正文") +
        switchRow("dlg_emoji", "允许使用 emoji", chat.useEmoji !== false) +
        '<div class="grid cols-2 mt-sm" style="gap:0 16px">' +
        field("第一条前的停顿（毫秒）", "dlg_first", chat.firstDelayMs, { type: "number", min: 0, max: 15000, tip: "像在打字" }) +
        field("私聊连发等待（秒）", "dlg_merge", chat.privateMergeWindowSec ?? 3, { type: "number", min: 1, max: 15, tip: "新消息重置静默计时；整轮等待不超过下方上限" }) +
        field("整轮最长等待（秒）", "dlg_deadline", chat.privateMaxWaitSec ?? 15, { type: "number", min: 1, max: 15 }) +
        switchRow("dlg_typing_status", "收到 QQ 输入状态时继续等待", chat.waitForTyping !== false, "协议端未提供时只使用静默等待；输入状态不能突破整轮上限") +
        field("每条之间停顿（毫秒）", "dlg_typing", chat.typingDelayMs, { type: "number", min: 0, max: 15000 }) +
        "</div>" +
        '<div class="row mt-sm"><button class="btn" id="btnSaveMisc">' + ICON("save", 15) + "保存这些小设置</button></div>",
    }) +
    "</div>";
}

/* -------------------------------- 天气与位置 -------------------------------- */

async function pageWeather() {
  const w = S.weatherLive || (S.weatherLive = await api("/api/weather"));
  const days = w.days || [];
  const alerts = w.alerts || [];
  const kinds = w.alertKinds || [];
  const pro = w.proactive || {};
  const allowed = Array.isArray(pro.kinds) ? pro.kinds : [];
  const fb = w.feedback || { muted: false, note: "", mentions: { kinds: [] } };
  const muteUntilText = fb.mutedUntil ? t(fb.mutedUntil) : "";

  const locPills = [
    w.location && w.location.city ? pill("位置：" + (w.location.city + (w.location.region ? "，" + w.location.region : "")), "ok") : pill("还没有位置信息", "warn"),
    w.location && String(w.location.source || "").startsWith("ip:") ? pill("自动定位", "info") : "",
    w.cached ? pill("缓存", "info") : "",
  ].filter(Boolean).join(" ");

  const errorCard = w.error
    ? '<div class="notice warn">' + ICON("alert", 18) + '<div><div class="nt">现在没拿到天气</div><div class="nd">' + esc(w.error) + "</div></div></div>"
    : w.warning
      ? '<div class="notice warn">' + ICON("alert", 18) + '<div class="nd">' + esc(w.warning) + "</div></div>"
      : "";

  const alertList = alerts.length
    ? alerts.map((item) => '<div class="notice ' + (item.level === "soft" ? "info" : "warn") + ' mt-sm">' + ICON(item.level === "soft" ? "info" : "alert", 18) +
      '<div><div class="nt">' + esc(item.text) + '</div><div class="nd">' + esc(item.hint) + "</div></div></div>").join("")
    : '<div class="muted small mt">今天没什么需要特别提醒的天气。</div>';

  const dayRows = days.length
    ? '<div class="table-wrap"><table><thead><tr><th>日期</th><th>天气</th><th>气温</th><th>降雨概率</th><th>风</th></tr></thead><tbody>' +
      days.map((d, index) => "<tr><td>" + esc(d.date) + (index === 0 ? ' <span class="pill accent">今天</span>' : index === 1 ? ' <span class="pill">明天</span>' : "") + "</td>" +
        '<td><span class="row" style="gap:6px;align-items:center">' + ICON(weatherIconName(d.code), 16) + esc(d.text) + "</span></td>" +
        '<td class="mono">' + esc(Math.round(d.min)) + "~" + esc(Math.round(d.max)) + "℃</td>" +
        '<td class="mono">' + esc(Math.round(d.rainProb)) + "%</td>" +
        '<td class="mono">' + esc(Math.round(d.windMax)) + " km/h</td></tr>").join("") +
      "</tbody></table></div>"
    : '<div class="muted small">还没有预报数据。</div>';

  const kindRows = kinds.map((item) => switchRow("wkind_" + item.id, item.label, allowed.includes(item.id))).join("");

  return '<div class="grid cols-2">' +
    card({
      title: "现在在哪", icon: "pin", hint: "定位不对就直接填城市",
      body: locPills +
        '<div class="grid cols-2 mt" style="gap:0 16px">' +
        field("城市（留空 = 自动定位）", "wx_city", w.city || "", { tip: "填「杭州」「武汉」这种就行，中文可以" }) +
        field("每天什么时候说天气", "wx_at", pro.at || "07:30", { tip: "HH:MM，只在有雨雪降温时才真的开口" }) +
        "</div>" +
        '<div class="row"><button class="btn primary" id="btnWxSave">' + ICON("save", 16) + "保存并重新获取</button>" +
        '<button class="btn" id="btnWxRefresh">' + ICON("refresh", 16) + "只刷新天气</button></div>" +
        '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nt">位置是怎么来的</div><div class="nd">优先用你手填的城市；没填就按公网 IP 猜一个城市级位置（不需要系统定位权限，也不会上传任何东西）。天气数据来自 Open-Meteo，免费、无需 Key。</div></div></div>' +
        errorCard,
    }) +
    card({
      title: "今天", icon: "cloudRain", hint: w.summary ? "" : "还没取到",
      body: '<div class="wx-hero"><div class="wx-icon">' + ICON(weatherIconName(w.today ? w.today.code : -1), 40) + "</div>" +
        '<div><div class="wx-temp">' + (w.today ? esc(Math.round(w.today.min)) + "~" + esc(Math.round(w.today.max)) + "℃" : "—") + "</div>" +
        '<div class="small muted">' + esc(w.summary || "还没有天气数据") + "</div></div></div>" +
        '<div class="grid cols-3 mt" style="gap:12px">' +
        stat("降雨概率", w.today ? Math.round(w.today.rainProb) + "%" : "—") +
        stat("阵风", w.today ? Math.round(w.today.windMax) + " km/h" : "—") +
        stat("体感", w.current && Number.isFinite(w.current.feels) ? Math.round(w.current.feels) + "℃" : "—") +
        "</div>" +
        alertList,
    }) +
    card({ title: "未来几天", icon: "calendar", body: dayRows }) +
    card({
      title: "她现在会不会提天气", icon: "shield", hint: "说一句「我这边大晴天」她就会立刻收手",
      body:
        (fb.muted
          ? '<div class="notice warn">' + ICON("alert", 18) + '<div><div class="nt">已暂停：暂时不会主动提天气</div><div class="nd">到 ' + esc(muteUntilText) + " 为止。" + (fb.note ? "她记住的实际情况：「" + esc(fb.note) + "」" : "") + "</div></div></div>"
          : '<div class="notice ok">' + ICON("check", 18) + '<div><div class="nt">正常</div><div class="nd">会按上面的设置提醒' + (fb.note ? "；她记得你那边实际是「" + esc(fb.note) + "」" : "") + "</div></div></div>") +
        '<div class="kv mt"><span class="k">今天已提过</span><span class="small">' +
        (fb.mentions && fb.mentions.kinds && fb.mentions.kinds.length ? esc(fb.mentions.kinds.join("、")) + ' <span class="tiny muted">（今天不会再提第二次）</span>' : "还没提过") +
        "</span></div>" +
        '<div class="row mt">' +
        '<button class="btn" id="btnWxMute">' + ICON("pause", 16) + "今天别再提天气</button>" +
        '<button class="btn ghost" id="btnWxRestore">' + ICON("refresh", 16) + "恢复提醒</button></div>" +
        '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nt">为什么会有这一块</div><div class="nd">天气预报只能到市级，一个市里几个区天气可能完全不同。所以只要你在 QQ 里说「我这边没下雨 / 是大晴天 / 知道了 / 别再说了」，她会立刻停止提天气——你的观察永远比预报优先。</div></div></div>',
    }) +
    card({
      title: "什么时候主动提醒", icon: "bell", hint: "每天最多一次",
      body:
        switchRow("wx_enabled", "开启天气提醒", pro.enabled !== false, "到了设定的时间，她会在有雨雪降温时说一句") +
        switchRow("wx_onlyalert", "只在值得说的时候开口", pro.onlyOnAlert !== false, "晴天大太阳就不打扰你") +
        selectField("到什么程度才值得专门发一条", "wx_minlevel", pro.minLevel || "warn", [
          { value: "warn", label: "只发明显影响出门的（雨雪雷雨、骤降 8℃、35℃ 以上、大风）" },
          { value: "info", label: "连「有点热 / 明天凉一点」也发（更啰嗦）" },
          { value: "soft", label: "什么都说（不建议）" },
        ], "市级预报不准，默认只发最值得说的") +
        '<div class="mt-sm"><div class="tiny muted mb-sm">允许她主动提醒这些情况：</div>' + kindRows + "</div>" +
        '<div class="row mt"><button class="btn primary" id="btnWxSavePro">' + ICON("save", 16) + "保存提醒设置</button>" +
        '<button class="btn" id="btnWxTest">' + ICON("send", 16) + "让她现在发一条试试</button></div>" +
        '<div id="wxOut" class="mt"></div>' +
        '<div class="notice info mt">' + ICON("info", 18) + '<div class="nd">每天最多一次；错过设定时间 ' + esc(pro.windowMinutes || 150) + " 分钟就不补发（免得中午突然收到「今天记得带伞」）；聊天里说过一次，当天就不再重复。</div></div>",
    }) +
    "</div>";
}

/** 天气代码 → 前端图标名（和 lib/weather.mjs 里同一套判断）。 */
function weatherIconName(code) {
  const value = Number(code);
  if (!Number.isFinite(value) || value < 0) return "cloud";
  if ([95, 96, 99, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 71, 73, 75, 77, 85, 86].includes(value)) return "cloudRain";
  if (value <= 1) return "sun";
  return "cloud";
}

/* ------------------------------- 角色工作室 ------------------------------- */

const CHAR_LABELS = [
  ["worldview", "世界观", "她生活在一个怎样的世界：年代、地点、有没有奇幻/科幻设定、社会怎么运作。她按这个世界的常识说话，但不会向你讲解它。"],
  ["persona", "她是谁（基础人设）", "出身、身份、平时在做什么。越具体她演得越准。"],
  ["appearance", "外貌特征", "只在她自然提到时才会用到，不用写太细。"],
  ["personality", "性格", "用日常语言描述，比如「嘴硬心软、爱逞强」。"],
  ["speechStyle", "说话风格", "称呼、语气、口头禅、句尾习惯。这是最影响观感的一项。"],
  ["habits", "行为习惯", "她平时的小动作、小毛病。"],
  ["relations", "人际关系", "和对方、和其他人的关系。"],
  ["boundaries", "边界与底线", "她不会做的事、不愿聊的话题（会作为硬约束写进提示词）。"],
  ["exampleDialogue", "说话示例", "几组对话，她照着这个语气说话，不要照抄内容。"],
  ["extras", "补充设定", "任何还想告诉她的东西。"],
];

/** 「关于对方」的字段（和 lib/config.mjs 的 USER_FIELDS 对应）。 */
const USER_LABELS = [
  ["name", "你的名字 / 昵称", "她可以用名字叫你", 1],
  ["gender", "性别", "", 1],
  ["age", "年龄", "", 1],
  ["occupation", "职业 / 身份", "学生、程序员、医生……", 1],
  ["city", "所在城市", "和天气功能用同一个城市最好", 1],
  ["likes", "喜欢的东西", "吃的、玩的、日常习惯", 2],
  ["dislikes", "不喜欢 / 忌口", "她不会再给你推荐这些", 2],
  ["taboos", "雷区与禁忌", "绝对不能提的话题", 2],
  ["notes", "其他设定", "作息、口头习惯、你们之间的背景", 3],
];

async function pageStudio() {
  if (!S.characters.length) await loadCharacters();
  const c = S.editingCharacter || S.activeCharacter || {};
  const user = c.user || {};
  const list = S.characters.map((item) =>
    '<div class="nav-item' + (item.id === c.id ? " active" : "") + '" data-char="' + esc(item.id) + '">' + ICON("user", 18) + '<span class="nav-label">' + esc(item.name || item.id) + '</span><span class="spacer"></span>' + (item.id === (S.activeCharacter && S.activeCharacter.id) ? pill("正在使用", "accent") : "") + "</div>"
  ).join("");

  const fieldsHtml = CHAR_LABELS.map(([key, label, tip]) => field(label, "ch_" + key, c[key] || "", { rows: key === "persona" || key === "exampleDialogue" || key === "speechStyle" || key === "worldview" ? 4 : 3, tip })).join("");
  const userHtml = USER_LABELS.map(([key, label, tip, rows]) => field(label, "ch_user_" + key, user[key] || "", { rows: rows > 1 ? rows : 0, tip })).join("");
  const locks = ["name", "worldview", "persona", "personality", "speechStyle", "boundaries"];
  const lockHtml = locks.map((key) => switchRow("lk_" + key, "锁定「" + (CHAR_LABELS.find((f) => f[0] === key) || [, key])[1] + "」", (c.locked || []).includes(key), "锁定后，聊天内容与自动推断都无法改动它")).join("");

  return '<div class="grid" style="grid-template-columns: 260px 1fr;align-items:start">' +
    card({ title: "角色", icon: "users", body: list + '<button class="btn ghost sm block mt" id="btnNewChar">' + ICON("plus", 15) + "新建角色</button>" + '<button class="btn ghost sm block mt-sm" id="btnCloneChar">' + ICON("copy", 15) + "复制选中角色</button>" }) +
    "<div>" +
    card({
      title: "角色卡", icon: "feather", hint: "新建和编辑不会切换正在使用的角色",
      body: '<div class="row mb">' + (c.id === (S.activeCharacter && S.activeCharacter.id)
        ? pill("本账号正在使用此角色", "ok")
        : '<span class="small muted">正在编辑，尚未启用；可复制到新账号实例。</span><button class="btn primary sm" id="btnActivateChar">本账号启用此角色</button>') + '</div><div class="grid cols-2" style="gap:0 16px">' +
        field("角色名", "ch_name", c.name || "", { tip: "别人怎么称呼她" }) +
        field("头衔 / 一句话身份", "ch_title", c.title || "", { tip: "例如「某艘船的四号舰」或「隔壁面包店的学徒」" }) +
        "</div>" +
        fieldsHtml +
        field("第一句话", "ch_greeting", c.greeting || "", { rows: 2, tip: "第一次连上 QQ 时她主动发给你的那句" }) +
        '<div class="row"><button class="btn primary" id="btnSaveChar">' + ICON("save", 16) + "保存角色卡</button>" +
        '<button class="btn ghost" id="btnReloadChar">' + ICON("refresh", 16) + "放弃修改</button>" +
        '<span class="spacer"></span><span class="tiny muted">版本 v' + esc(c.version || 1) + " · 更新于 " + esc(ago(c.updatedAt ? Date.parse(c.updatedAt) : 0)) + "</span></div>",
    }) +
    card({
      title: "关于你（对方）", icon: "user", hint: "私人档案只用于绑定用户的私聊",
      body: '<div class="small soft mb">请明确绑定所属 QQ 和机器人 QQ；未绑定的旧档案不会提供给模型。群聊和其他联系人不能使用这份档案。角色人格、关系、示例对话等共享字段请勿填写私人资料。</div>' +
        field("档案所属用户 QQ", "ch_userOwnerId", c.userOwnerId || "", { tip: "留空即不注入私人档案" }) +
        field("使用此档案的机器人 QQ", "ch_userAccountId", c.userAccountId || "") +
        '<div class="grid cols-2" style="gap:0 16px">' +
        USER_LABELS.slice(0, 5).map(([key, label, tip, rows]) => field(label, "ch_user_" + key, user[key] || "", { rows: rows > 1 ? rows : 0, tip })).join("") +
        "</div>" +
        USER_LABELS.slice(5).map(([key, label, tip, rows]) => field(label, "ch_user_" + key, user[key] || "", { rows, tip })).join("") +
        '<div class="row"><button class="btn primary" id="btnSaveChar2">' + ICON("save", 16) + "保存（含角色卡）</button>" +
        '<button class="btn ghost" id="btnSyncUserCity">' + ICON("pin", 15) + "把城市同步给天气</button></div>",
    }) +
    card({
      title: "提示词分层与锁定", icon: "lock", hint: "系统硬约束 → 世界观 → 核心人格 → 关于你 → 关系 → 记忆 → 当前聊天",
      body: '<div class="small soft mb">锁定字段后，群消息、聊天内容、模型推断都无法修改它们——这是防止「人设漂移」的硬保障。</div>' + lockHtml +
        '<div class="mt"><button class="btn sm" id="btnPreviewPrompt">' + ICON("eye", 15) + "预览最终提示词</button></div>",
    }) +
    "</div></div>";
}

async function loadCharacters(editingId) {
  const revision = S.characterLoadRevision = (S.characterLoadRevision || 0) + 1;
  const res = await api("/api/characters");
  if (!res.ok) throw new Error(res.message || "角色列表读取失败");
  const characters = res.list || [];
  const active = res.active;
  let activeCard = null;
  if (active && characters.some((item) => item.id === active)) {
    const one = await api("/api/characters/" + encodeURIComponent(active));
    if (!one.ok) throw new Error(one.message || "角色读取失败");
    activeCard = one.character;
  }
  const selected = editingId || (S.editingCharacter && S.editingCharacter.id) || active;
  let editingCard = activeCard;
  if (selected && characters.some((item) => item.id === selected) && selected !== active) {
    const one = await api("/api/characters/" + encodeURIComponent(selected));
    if (!one.ok) throw new Error(one.message || "角色读取失败");
    editingCard = one.character;
  }
  if (S.characterLoadRevision !== revision) return;
  S.characters = characters;
  S.activeCharacter = activeCard;
  S.editingCharacter = editingCard;
}

/* ------------------------------ 试聊与对话 ------------------------------ */

async function pageChat() {
  if (!S.convs.length) { const res = await api("/api/conversations"); S.convs = res.list || []; }
  const selected = S.chatScope || (S.convs[0] && S.convs[0].scopeKey) || "";
  S.chatScope = selected;
  const options = S.convs.map((c) => ({ value: c.scopeKey, label: c.label + "（" + c.count + " 条）" }));
  return '<div class="grid cols-2">' +
    card({
      title: "离线试聊", icon: "wand", hint: "不会发到 QQ，随便试",
      body: '<div id="sandboxLog" class="chat" style="min-height:180px"><div class="muted small">在下面输入一句话，看看她会怎么回。这里不会打扰到任何人。</div></div>' +
        '<div class="row mt"><input type="text" id="sandboxInput" placeholder="例如：今天有点累……"><button class="btn primary" id="btnSandbox">' + ICON("send", 16) + "发送</button>" +
        '<button class="btn ghost sm" id="btnSandboxClear">' + ICON("trash", 15) + "清空</button></div>",
    }) +
    card({
      title: "真实对话记录", icon: "chat", hint: "记忆按会话严格隔离",
      body: (options.length ? selectField("看哪一段对话", "chatScope", selected, options) + '<div id="convBox" class="chat"><div class="muted small">加载中…</div></div>' +
        '<div class="row mt"><button class="btn ghost sm" id="btnConvRefresh">' + ICON("refresh", 15) + '刷新</button>' +
        '<button class="btn ghost sm" id="btnConvRecover">' + ICON("download", 15) + "补回漏掉的消息</button>" +
        '<span class="spacer"></span><button class="btn danger sm" id="btnConvClear">' + ICON("trash", 15) + "彻底清除这段对话与记忆</button></div>" +
        '<div id="recoverOut" class="mt"></div>'
        : emptyState("还没有任何对话", "等她在 QQ 里回上第一句话，这里就会出现记录", "chat")),
    }) +
    "</div>";
}

async function loadConversation(scopeKey) {
  const box = $("#convBox");
  if (!box || !scopeKey) return;
  box.innerHTML = '<div class="muted small">加载中…</div>';
  const res = await api("/api/conversation?key=" + encodeURIComponent(scopeKey) + "&limit=200");
  const list = res.messages || [];
  if (!list.length) { box.innerHTML = '<div class="muted small">这段对话还没有消息。</div>'; return; }
  box.innerHTML = list.map((m) => {
    const out = m.direction === "out";
    return '<div class="bubble ' + (out ? "out" : "in") + '"><div class="avatar">' + (out ? esc((S.activeCharacter && S.activeCharacter.name || "心").slice(0, 1)) : "TA") + '</div><div><div class="body">' + esc(m.body) + '</div><div class="meta">' + t(m.at) + (out ? "" : " · " + esc(m.sender_name || m.sender_id)) + "</div></div></div>";
  }).join("");
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------ 群聊与审核 ------------------------------ */

const GROUP_MEMBER_VIEWS = new Map();
function groupMemberView(groupId) {
  const key = String(groupId || "");
  if (!GROUP_MEMBER_VIEWS.has(key)) GROUP_MEMBER_VIEWS.set(key, { open: false, page: 1, q: "", searchText: "", drafts: new Map() });
  return GROUP_MEMBER_VIEWS.get(key);
}

async function pageGroups() {
  if (!S.groups) S.groups = await api("/api/groups?members=none");
  const g = S.groups;
  const groups = g.groups || [];
  if (!groups.length) {
    return card({
      title: "群聊与审核", icon: "users",
      body: emptyState("还没有拉到任何群", "点下面的按钮让她去读一次群列表（需要 QQ 已连接）", "search") +
        '<div class="row mt"><button class="btn primary" id="btnSyncGroups">' + ICON("refresh", 16) + "读取群列表与成员</button></div>",
    });
  }
  const sel = S.groupSel || String(groups[0].groupId);
  S.groupSel = sel;
  const current = groups.find((x) => String(x.groupId) === String(sel)) || groups[0];
  const f = g.filter || {};
  const r = g.rate || {};
  const view = groupMemberView(sel);
  const members = view.open ? await api("/api/groups/members?" + new URLSearchParams({ groupId: sel, page: view.page, pageSize: 50, q: view.q })) : null;
  if (members && !members.ok) throw new Error(members.message || "群成员读取失败");
  if (members) view.page = members.page;

  const memberRows = ((members && members.members) || []).map((m) => ({ ...m, ...(view.drafts.get(String(m.peerId)) || {}) })).map((m) =>
    '<tr><td class="mono">' + esc(m.peerId) + "</td><td>" + esc(m.card || m.nickname || "—") + (m.left ? ' <span class="pill warn">已离群</span>' : "") + "</td>" +
    '<td><input type="text" data-att="' + esc(m.peerId) + '" value="' + esc(m.attitude || "") + '" placeholder="' + esc(g.defaultAttitude || "普通群友") + '" style="min-width:180px"></td>' +
    '<td><input type="text" data-note="' + esc(m.peerId) + '" value="' + esc(m.note || "") + '" placeholder="备注" style="min-width:140px"></td>' +
    '<td><select data-trigger="' + esc(m.peerId) + '">' + ["at:仅 @ 时回", "all:每句都参与", "keyword:只回关键词", "probability:按概率回", "never:从不回复"].map((o) => { const [v, l] = o.split(":"); return '<option value="' + v + '"' + (m.trigger === v ? " selected" : "") + ">" + l + "</option>"; }).join("") + "</select></td>" +
    "<td>" + (m.blocked ? pill("已拉黑", "danger") : pill("正常", "ok")) + '<div class="tiny muted">' + (m.quota || []).filter((item) => item.limitKey.startsWith("perUser") && item.limit > 0).map((item) => ({ perUserPerMinute: "分钟", perUserPerHour: "小时", perUserPerDay: "天" }[item.limitKey] || "") + "剩 " + item.remaining + "/" + item.limit).join(" · ") + '</div><button class="btn ghost sm" data-quota="' + esc(m.peerId) + '">查看 / 设置额度</button></td>' +
    '<td class="nowrap"><button class="btn sm ghost" data-save="' + esc(m.peerId) + '">保存</button> ' +
    (m.blocked ? '<button class="btn sm ok" data-unblock="' + esc(m.peerId) + '">解除</button>' : '<button class="btn sm danger" data-block="' + esc(m.peerId) + '">拉黑</button>') + "</td></tr>"
  ).join("");

  return '<div class="grid" style="gap:16px">' +
    card({
      title: "群聊与审核", icon: "users", hint: "群成员的「态度」会直接写进她的提示词，写得越像人话她演得越准",
      body: '<div class="row mb">' +
        selectField("选择群", "groupSel", sel, groups.map((x) => ({ value: x.groupId, label: (x.memberCount || 0) + " 人 · 群 " + x.groupId })), "").replace('<div class="field">', '<div class="field" style="flex:1;min-width:200px;margin-bottom:0">') +
        '<button class="btn primary" id="btnSyncGroups">' + ICON("refresh", 16) + "刷新成员</button>" +
        "</div>" +
        '<details id="groupMembers"' + (view.open ? " open" : "") + '><summary style="cursor:pointer;padding:12px 0">群成员（' + esc(current.memberCount || 0) + ' 人）' + (view.drafts.size ? ' · ' + view.drafts.size + ' 人有未保存修改' : '') + '</summary>' +
        (view.open ? '<div class="row mb">' + field("搜索 QQ、昵称或群名片", "groupMemberQuery", view.searchText) + '<button class="btn" id="btnSearchMembers">搜索</button></div>' +
          '<div class="table-wrap" style="max-height:480px;overflow:auto"><table><thead><tr><th>QQ</th><th>昵称</th><th>你对 ta 的态度</th><th>备注</th><th>回复方式</th><th>状态</th><th>操作</th></tr></thead><tbody>' + (memberRows || '<tr><td colspan="7">没有匹配的成员</td></tr>') + '</tbody></table></div>' +
          '<div class="row mt"><button class="btn sm" id="btnMembersPrev"' + (view.page <= 1 ? ' disabled' : '') + '>上一页</button><span class="small muted">第 ' + view.page + '/' + members.totalPages + ' 页 · 共 ' + members.total + ' 人 · 每页 50 人</span><button class="btn sm" id="btnMembersNext"' + (view.page >= members.totalPages ? ' disabled' : '') + '>下一页</button></div>'
          : '<div class="small muted">展开查看成员，可按 QQ、昵称或群名片搜索。</div>') + '</details>',
    }) +
    '<div class="grid cols-2">' +
    card({
      title: "屏蔽词与警告", icon: "shield", hint: "默认第 1 次警告、第 2 次拉黑；被拉黑的人不会产生任何模型费用",
      body: selectField("处理方式", "fl_action", f.action, [{ value: "warn_then_block", label: "先警告，再犯就拉黑（默认）" }, { value: "warn_only", label: "只警告，不拉黑" }, { value: "block_now", label: "直接拉黑" }, { value: "log_only", label: "只记录，不拦截" }]) +
        field("警告几次后拉黑", "fl_max", f.maxWarnings, { type: "number", min: 0, max: 10, tip: "默认 1 表示「警告一次、再犯拉黑」" }) +
        field("屏蔽词（一行一个）", "fl_words", (f.words || []).join("\n"), { rows: 4, tip: "普通词直接写；正则写在下一栏" }) +
        field("正则规则（一行一个）", "fl_regex", (f.regex || []).join("\n"), { rows: 2, tip: "高级用法，写错会被自动忽略" }) +
        selectField("警告语从哪来", "fl_src", f.warnSource, [{ value: "fixed", label: "固定文案（不花模型钱）" }, { value: "template", label: "模板（可用 {word} {name} {group}）" }, { value: "llm", label: "让她按自己的口吻现写" }]) +
        field("固定警告文案 / 模板", "fl_text", f.warnText, { rows: 2 }) +
        '<div class="row"><button class="btn primary" id="btnSaveFilter">' + ICON("save", 16) + "保存审核设置</button>" +
        '<input type="text" id="filterTest" placeholder="粘贴一句话试试命中" style="flex:1;min-width:160px"><button class="btn ghost" id="btnFilterTest">' + ICON("search", 16) + "试一下</button></div>" +
        '<div id="filterTestOut" class="mt"></div>',
    }) +
    card({
      title: "回复频率闸门", icon: "filter", hint: "触到上限她就安静，时间窗口过去自动恢复",
      body: '<div class="grid cols-2" style="gap:0 16px">' +
        field("每人每小时", "rate_uh", r.perUserPerHour, { type: "number", min: 0 }) +
        field("每人每天", "rate_ud", r.perUserPerDay, { type: "number", min: 0 }) +
        field("每群每小时", "rate_gh", r.perGroupPerHour, { type: "number", min: 0 }) +
        field("每群每天", "rate_gd", r.perGroupPerDay, { type: "number", min: 0 }) +
        field("全局每天", "rate_all", r.globalPerDay, { type: "number", min: 0 }) +
        field("两次回复最小间隔（秒）", "rate_gap", r.minGapSeconds, { type: "number", min: 0 }) +
        field("连续回几条后静默", "rate_cons", r.maxConsecutive, { type: "number", min: 0 }) +
        field("静默多久（分钟）", "rate_silent", r.silentMinutes, { type: "number", min: 1 }) +
        "</div>" +
        switchRow("rate_enabled", "启用频率限制", r.enabled !== false) +
        switchRow("rate_private", "私聊也受频率限制", r.applyToPrivate !== false) +
        '<button class="btn primary mt" id="btnSaveRate">' + ICON("save", 16) + "保存频率设置</button>",
    }) +
    "</div>" +
    card({
      title: "决策审计：为什么回 / 为什么没回", icon: "target", hint: "模拟一条消息，看她会不会回、以及是哪一步拦下的",
      body: '<div class="row"><select id="simScope" style="max-width:280px">' + groups.map((x) => '<option value="group_' + esc(x.groupId) + '_' + esc(x.samplePeerId || ((x.members || [])[0] || {}).peerId || "0") + '">群 ' + esc(x.groupId) + "</option>").join("") + '<option value="private_0">私聊</option></select>' +
        '<input type="text" id="simText" placeholder="要模拟的消息内容" style="flex:1;min-width:200px">' +
        '<label class="switch"><input type="checkbox" id="simAt"><span class="track"></span><span>@ 我</span></label>' +
        '<button class="btn primary" id="btnSimulate">' + ICON("play", 16) + "模拟判定</button></div>" +
        '<div id="simOut" class="mt"></div>',
    }) +
    "</div>";
}

/* --------------------------------- 记忆 --------------------------------- */

async function pageMemory() {
  if (!S.memory) S.memory = await api("/api/memory");
  const m = S.memory;
  const cats = m.categories || [];
  const items = m.items || [];
  const catName = (id) => (cats.find((c) => c.id === id) || {}).label || id;
  const catKind = { episodic: "accent", fact: "info", preference: "ok", agreement: "warn", relation: "info", reflection: "accent", diary: "info" };
  /* 来源标签：新增的 diary 也要有名字，否则会掉进最后的「模型推断」里，看着像记忆被污染了 */
  const SOURCE_LABEL = { observed: ["真实发生", "ok"], authored: ["用户手写", "accent"], simulated: ["虚构日常", "warn"], diary: ["她写的日记", "info"] };
  const sourcePill = (id) => {
    const entry = SOURCE_LABEL[id] || ["模型推断", "info"];
    return pill(entry[0], entry[1]);
  };
  const scopeOptions = (m.sessions || []).map((s) => ({ value: s.scopeKey, label: s.label + "（" + s.count + " 条消息）" }));

  const rows = items.map((x) =>
    "<tr><td>" + pill(catName(x.category), catKind[x.category] || "info") + "</td>" +
    '<td><div class="pre-wrap" style="max-width:360px">' + esc(x.content) + "</div>" +
    (x.status !== "active" ? '<div class="tiny muted">状态：' + esc(x.status) + (x.superseded_by ? " → 被 #" + esc(x.superseded_by) + " 取代" : "") + "</div>" : "") + "</td>" +
    '<td class="small muted">' + esc(x.label || x.scope_key) + "</td>" +
    "<td>" + sourcePill(x.source_type) + "</td>" +
    '<td class="mono small">' + (num(x.confidence) * 100).toFixed(0) + "%</td>" +
    '<td class="small muted nowrap">' + t(x.at) + "</td>" +
    '<td class="nowrap">' + (x.pinned ? pill("已锁定", "accent") + " " : "") +
    '<button class="btn sm ghost" data-mem-pin="' + x.id + '">' + (x.pinned ? "解锁" : "锁定") + "</button> " +
    '<button class="btn sm danger" data-mem-del="' + x.id + '">删除</button></td></tr>'
  ).join("");

  return '<div class="grid cols-3 mb">' +
    stat("活跃记忆", num(m.stats && m.stats.total)) +
    stat("已被新事实取代", num(m.stats && m.stats.superseded), "保留可追溯") +
    stat("已撤回", num(m.stats && m.stats.retracted)) +
    "</div>" +
    card({
      title: "记忆检索测试", icon: "search", hint: "验证「记忆隔离」：换一个会话就绝对查不到别人的事",
      body: '<div class="row">' + selectField("会话作用域", "memScope", scopeOptions[0] && scopeOptions[0].value, scopeOptions).replace('<div class="field">', '<div class="field" style="flex:1;min-width:220px;margin-bottom:0">') +
        '<input type="text" id="memQuery" placeholder="要检索的内容，例如「面试」" style="flex:1;min-width:180px">' +
        '<button class="btn primary" id="btnRecall">' + ICON("search", 16) + "检索</button></div>" +
        '<div id="recallOut" class="mt"></div>',
    }) +
    card({
      title: "手动补一条记忆", icon: "plus", hint: "用 QQ 直接说「记住：我不吃香菜」也可以",
      body: '<div class="row">' + selectField("记到哪个会话", "addScope", scopeOptions[0] && scopeOptions[0].value, scopeOptions).replace('<div class="field">', '<div class="field" style="flex:1;min-width:200px;margin-bottom:0">') +
        selectField("类型", "addCat", "fact", cats.map((c) => ({ value: c.id, label: c.label }))).replace('<div class="field">', '<div class="field" style="width:130px;margin-bottom:0">') +
        '<input type="text" id="addContent" placeholder="例如：他在准备考研，最近压力很大" style="flex:2;min-width:220px">' +
        '<button class="btn primary" id="btnAddMem">' + ICON("save", 16) + "记住</button></div>",
    }) +
    card({
      title: "全部记忆", icon: "layers", hint: "共 " + items.length + " 条（按时间倒序）",
      body: items.length ? '<div class="table-wrap" style="max-height:560px;overflow-y:auto"><table><thead><tr><th>类型</th><th>内容</th><th>属于</th><th>来源</th><th>可信度</th><th>时间</th><th>操作</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyState("还没有任何记忆", "多聊几次，或者直接说「记住：…」，她会把重要的事记下来", "brain"),
    });
}

/* ------------------------------- 数字生命 ------------------------------- */

/* ------------------------------ 长任务进度卡 ------------------------------ */

const JOB_TITLES = { archive: "归档记忆", diary: "写日记", reflect: "自我反思" };
const JOB_STATUS = {
  running: { text: "正在跑", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  skipped: { text: "没做", tone: "warn" },
  failed: { text: "失败", tone: "danger" },
};

function elapsedText(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return sec < 60 ? sec + " 秒" : Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
}

/** 把任务列表画成卡片内容（轮询时只重画这一块，页面不闪）。 */
function jobsHtml(jobs) {
  if (!jobs || !jobs.length) {
    return '<div class="muted small">还没跑过。点上面的按钮开始，进度会显示在这里。</div>';
  }
  return jobs
    .map((job) => {
      const meta = JOB_STATUS[job.status] || JOB_STATUS.running;
      const steps = (job.steps || [])
        .map((s) => '<div class="row tiny" style="gap:8px;padding:2px 0"><span class="muted mono nowrap">' + t(s.at) + "</span><span class=\"soft\">" + esc(s.message) + "</span></div>")
        .join("");
      const tail = job.status === "failed"
        ? '<div class="notice danger mt-sm" style="padding:8px 10px">' + ICON("alert", 16) + '<div><div class="nd pre-wrap">' + esc(job.error || "失败了") + "</div></div></div>"
        : (job.result && job.result.summary ? '<div class="small soft mt-sm">' + esc(job.result.summary) + "</div>" : "");
      return '<div style="padding:10px 0;border-bottom:1px solid rgba(148,163,199,.1)">' +
        '<div class="row"><span class="small strong">' + esc(job.title || JOB_TITLES[job.kind] || job.kind) + "</span>" +
        pill(meta.text, meta.tone, job.status === "running" ? "pulse" : "") +
        '<span class="spacer"></span><span class="tiny muted">' + elapsedText(job.elapsedMs) + "</span></div>" +
        (steps ? '<div class="mt-sm">' + steps + "</div>" : "") +
        tail +
        "</div>";
    })
    .join("");
}

let jobPollTimer = null;
function stopJobPolling() {
  if (jobPollTimer) clearTimeout(jobPollTimer);
  jobPollTimer = null;
}

/**
 * 轮询任务进度。
 *
 * 以前点完按钮只有一句 toast，之后就什么反馈都没有了；
 * 现在的做法是：请求立刻返回任务号 → 这里每秒看一眼进度 → 画到卡片上，
 * 全部跑完再刷新一次页面数据（经历/反思/日记才会更新）。
 */
function startJobPolling() {
  stopJobPolling();
  const tick = async () => {
    if (S.page !== "life") { stopJobPolling(); return; }
    let res;
    try {
      res = await api("/api/jobs?limit=8");
    } catch {
      jobPollTimer = setTimeout(tick, 2500);
      return;
    }
    const box = $("#jobBox");
    if (box) box.innerHTML = jobsHtml(res.jobs || []);
    const running = (res.jobs || []).some((job) => job.running);
    ["btnArchive", "btnDiary", "btnReflect"].forEach((id) => {
      const el = $("#" + id);
      if (!el) return;
      el.disabled = running;
      el.classList.toggle("is-busy", running);
    });
    if (running) {
      jobPollTimer = setTimeout(tick, 1200);
      return;
    }
    // 跑完了：把经历 / 反思 / 日记这些真正的数据刷一遍
    S.life = null;
    const fresh = await api("/api/life").catch(() => null);
    if (fresh) {
      S.life = fresh;
      const statBox = $("#lifeStats");
      if (statBox) statBox.outerHTML = statRowHtml(fresh);
      const box2 = $("#jobBox");
      if (box2) box2.innerHTML = jobsHtml(fresh.jobs || []);
      /*
       * 卡片内容也要重画。
       * 以前这里只换了顶上三个数字，于是日记写完、经历归档完，卡片还是老样子——
       * 用户看到的就是「任务说写好了，日记栏还是空的」。
       */
      const tlBox = $("#lifeTimelineBody");
      if (tlBox) tlBox.innerHTML = timelineBodyHtml();
      const diaryBox = $("#lifeDiaryBody");
      if (diaryBox) diaryBox.innerHTML = diaryBodyHtml();
      const refBox = $("#lifeReflectionBody");
      if (refBox) refBox.innerHTML = reflectionBodyHtml();
      ["btnArchive", "btnDiary", "btnReflect"].forEach((id) => { const el = $("#" + id); if (el) el.disabled = false; });
    }
  };
  jobPollTimer = setTimeout(tick, 600);
}

/**
 * 点按钮：只负责「发起任务」，不再等它跑完。
 * 同一类任务在跑时后端会拒绝重复启动，这里把它如实告诉用户。
 */
async function startLifeJob(kind, path, body, okText) {
  const res = await api(path, body);
  if (!res.ok) { toast(res.message || "没能开始", "error"); return; }
  if (res.started === false) {
    toast((JOB_TITLES[kind] || "这个任务") + "已经在跑了，别急，进度在下面。", "warn");
  } else {
    toast(okText || "开始了，进度在下面这张卡片里", "ok");
  }
  const box = $("#jobBox");
  if (box && res.job) {
    const list = (S.life && S.life.jobs) || [];
    const merged = [res.job, ...list.filter((item) => item.id !== res.job.id)];
    box.innerHTML = jobsHtml(merged);
  }
  startJobPolling();
}

function statRowHtml(l) {
  /* 这三个数字要的是「一共有多少」，不是「这次取回来多少条」——经历现在只取最近 400 条 */
  const cnt = (value, list) => (value != null ? num(value) : (list || []).length);
  return '<div class="grid cols-3 mb" id="lifeStats">' +
    stat("经历", num(l.experienceTotal)) +
    stat("反思", cnt(l.reflectionTotal, l.reflections)) +
    stat("日记", cnt(l.diaryTotal, l.diary)) +
    "</div>";
}

/* ---------------------- 数字生命：按天浏览的经历时间线 ---------------------- */

/*
 * 聊得越久经历越多，原来那一栏是平铺的：一屏塞不下，也翻不到「上周三」。
 * 现在按本地日期分组——上面是日期列表，下面是那一天发生了什么；两块各自的框高度固定，
 * 多了就在框里上下滚。搜索框只认数字，2026 / 2026-10 / 2026-10-21 都行。
 * 选了哪天、搜了什么存在 TL 里而不是 DOM 里：任务跑完只重画卡片内容，选择不会丢。
 */
const TL = { day: "", q: "" };
const TL_WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function tlDayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return String(date || "");
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const head = Number(m[1]) === new Date().getFullYear() ? "" : m[1] + "年";
  return head + m[2] + "-" + m[3] + " " + TL_WEEK[day.getDay()];
}

/** 只看数字，别让用户纠结分隔符：4 位当年、6 位当年月、8 位当整条日期。 */
function tlDayMatch(date, query) {
  const q = String(query || "").replace(/[^0-9]/g, "");
  if (q.length < 4) return true;
  const d = String(date || "").replace(/[^0-9]/g, "");
  if (q.length >= 8) return d === q.slice(0, 8);
  if (q.length >= 6) return d.slice(0, 6) === q.slice(0, 6);
  return d.slice(0, 4) === q.slice(0, 4);
}

function tlItemHtml(x) {
  return '<div class="tl-item"><div class="tl-rail"><div class="tl-dot' + (x.source_type === "simulated" ? " sim" : "") + '"></div><div class="tl-line"></div></div><div class="tl-body">' +
    '<div class="txt">' + esc(x.content) + "</div>" +
    '<div class="sub"><span>' + esc(x.label || "") + "</span><span>" + esc(t(x.at).slice(11)) + "</span>" + (x.source_type === "simulated" ? pill("虚构日常", "warn") : "") + "</div></div></div>";
}

/** 日期列表 + 选中那天的时间线。换一天、改搜索词都只重画这一块（搜索框在外面，不会掉焦点）。 */
function timelineBodyHtml() {
  const days = (S.life && S.life.experienceDays) || [];
  if (!days.length) return emptyState("还没有积累经历", "攒够十几条消息后她会自动把这段关系归档成经历", "clock");
  const shown = days.filter((day) => tlDayMatch(day.date, TL.q));
  if (!shown.length) {
    return '<div class="tl-none">没有「' + esc(TL.q) + "」这段时间的经历" +
      '<div class="tiny muted mt-sm">换个写法试试：2026、2026-10 或 2026-10-21</div></div>';
  }
  if (!shown.some((day) => day.date === TL.day)) TL.day = shown[0].date;
  const current = shown.find((day) => day.date === TL.day) || shown[0];
  const dayList = shown.map((day) =>
    '<button type="button" class="tl-day' + (day.date === current.date ? " active" : "") + '" data-tl-day="' + esc(day.date) + '">' +
    '<span class="tl-day-d">' + esc(tlDayLabel(day.date)) + '</span><span class="tl-day-n">' + num(day.count) + " 条</span></button>"
  ).join("");
  return '<div class="tl-days">' + dayList + "</div>" +
    '<div class="tl-panel"><div class="timeline">' + current.items.map(tlItemHtml).join("") + "</div></div>";
}

function timelineCard(l) {
  const loaded = (l.experienceDays || []).reduce((sum, day) => sum + num(day.count), 0);
  const total = num(l.experienceTotal);
  return card({
    title: "经历时间线", icon: "clock",
    hint: "按天整理：点日期看她那一天记得什么；框的大小固定，多了在框里滚",
    body: '<div class="tl-bar"><input type="search" id="tlSearch" placeholder="按年月日搜：2026 / 2026-10 / 2026-10-21" value="' + esc(TL.q) + '">' +
      '<span class="tl-total">共 ' + total + " 条" + (total > loaded ? "（显示最近 " + loaded + " 条）" : "") + "</span></div>" +
      '<div id="lifeTimelineBody">' + timelineBodyHtml() + "</div>",
  });
}

/*
 * 日记：一条一条收起来。
 *
 * 时间线那一栏原来就是平铺的，写多了以后一屏滚不到底——日记不能重复这个毛病。
 * 现在每篇默认只露一行（日期 + 开头几个字），点一下才展开全文；
 * 列表本身是固定高度，篇数再多也只在框里滚；上面的搜索框能搜正文，也能搜日期。
 * 展开状态存在 DL 里：任务跑完只重画列表，手动展开的那几篇不会被合上。
 */
const DL = { q: "", open: {} };
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 这篇日记要不要展开：手动点过的听手动，没点过的默认展开最新一篇（搜索时命中的都展开）。 */
function diaryIsOpen(row, index, searching) {
  const key = String(row.id);
  if (hasOwn(DL.open, key)) return DL.open[key];
  return Boolean(searching) || index === 0;
}

function diaryBodyHtml() {
  const list = (S.life && S.life.diary) || [];
  if (!list.length) {
    return '<div class="muted small">还没有日记。点上面「写今天的日记」，她会用当天的经历写一篇，写完就出现在这里。</div>';
  }
  const raw = String(DL.q || "").trim();
  const lower = raw.toLowerCase();
  /*
   * 搜的是两样东西：正文里的词、或者日期。
   * 日期只在输入里真的带数字时才拿来比——否则「不要乱写」这种词会被当成
   * 「日期没命中 = 全都不命中」而搜出空白，或者反过来「没有数字 = 不筛」而全放行。
   */
  const wantsDate = raw.replace(/[^0-9]/g, "").length >= 4;
  const shown = !raw
    ? list
    : list.filter((row) => String(row.content || "").toLowerCase().indexOf(lower) >= 0 || (wantsDate && tlDayMatch(row.date, raw)));
  if (!shown.length) {
    return '<div class="tl-none">没有搜到「' + esc(raw) + '」的日记' +
      '<div class="tiny muted mt-sm">可以搜正文，也可以搜日期，例如 2026-10</div></div>';
  }
  return shown.map((x, index) => {
    const text = String(x.content || "").replace(/^\[日记 [\d-]+\]\s*/, "");
    const open = diaryIsOpen(x, index, Boolean(raw));
    const head = '<button type="button" class="diary-head" data-diary-toggle="' + esc(x.id) + '" data-diary-open="' + (open ? "1" : "0") + '">' +
      '<span class="diary-caret">' + ICON(open ? "chevronDown" : "chevronRight", 14) + "</span>" +
      '<span class="diary-date mono">' + esc(x.date || t(x.at)) + "</span>" +
      (open ? "" : '<span class="diary-preview">' + esc(text.slice(0, 24)) + (text.length > 24 ? "…" : "") + "</span>") +
      '<span class="spacer"></span><span class="tiny muted">' + num(text.length) + " 字</span></button>";
    return '<div class="diary-item' + (open ? " open" : "") + '">' + head +
      (open ? '<div class="pre-wrap small diary-text">' + esc(text) + "</div>" : "") + "</div>";
  }).join("");
}

function reflectionBodyHtml() {
  const list = (S.life && S.life.reflections) || [];
  if (!list.length) return '<div class="muted small">积累到足够多的经历后，她会形成一些「我注意到…」的反思。</div>';
  return '<div class="timeline">' + list.map((x) =>
    '<div class="tl-item"><div class="tl-rail"><div class="tl-dot inferred"></div></div><div class="tl-body"><div class="txt">' + esc(x.content) + '</div><div class="sub"><span>' + esc(x.label || "") + '</span><span>证据 ' + num(x.evidence_count) + " 条</span><span>置信度 " + (num(x.confidence) * 100).toFixed(0) + "%</span></div></div></div>"
  ).join("") + "</div>";
}

async function pageLife() {
  if (!S.life) S.life = await api("/api/life");
  const l = S.life;
  const st = l.state || {};
  const statePills = [pill(st.label && st.label.mood || "—", "accent"), pill(st.label && st.label.energy || "—", "info")].join(" ");
  const rels = (l.relationships || []).map((x) =>
    '<div style="margin-bottom:10px"><div class="row"><span class="small soft">' + esc(x.label || x.context_id) + '</span><span class="spacer"></span><span class="tiny muted mono">熟悉 ' + num(x.familiarity).toFixed(2) + " · 信任 " + num(x.trust).toFixed(2) + " · 好感 " + num(x.affection).toFixed(2) + "</span></div>" + bar(num(x.familiarity)) + "</div>"
  ).join("") || '<div class="muted small">还没有积累出关系数据。</div>';
  const goals = (l.goals || []).map((x) =>
    '<div class="row" style="padding:6px 0;border-bottom:1px solid rgba(148,163,199,.1)"><span class="small" style="flex:1">' + esc(x.content) + '</span><span class="tiny muted">' + esc(x.label || "") + '</span><button class="btn sm ghost" data-goal-done="' + x.id + '">已完成</button></div>'
  ).join("") || '<div class="muted small">她还没有惦记着要跟进的事。</div>';

  const card1 = card({
    title: "她此刻的状态", icon: "sparkle", hint: "由真实交互驱动，随时间自然回落，不会因为一句话就剧变",
    body: '<div class="row">' + statePills + '</div><div class="grid cols-3 mt">' +
      '<div><div class="small muted">情绪</div>' + bar((num(st.valence) + 1) / 2) + "</div>" +
      '<div><div class="small muted">精力</div>' + bar(num(st.energy)) + "</div>" +
      '<div><div class="small muted">社交意愿</div>' + bar(num(st.social_drive)) + "</div>" +
      "</div>" +
      '<div class="row mt"><button class="btn primary" id="btnArchive">' + ICON("recycle", 16) + "现在就归档</button>" +
      '<button class="btn" id="btnDiary">' + ICON("book", 16) + "写今天的日记</button>" +
      '<button class="btn" id="btnReflect">' + ICON("brain", 16) + "做一次反思</button></div>",
  });
  const cardJobs = card({
    title: "正在做的事", icon: "activity",
    hint: "点上面三个按钮之后，进度和结果都在这里；同一件事不会因为连点而重复跑",
    body: '<div id="jobBox">' + jobsHtml(l.jobs || []) + "</div>",
  });
  const cardTimeline = timelineCard(l);
  const cardRelation = card({ title: "关系演化", icon: "heart", hint: "每次变化都有上限，不会因为一句话就反转", body: rels });
  const cardGoals = card({ title: "她惦记着的事", icon: "target", body: goals });
  const cardDiary = card({
    title: "日记", icon: "book", hint: "点日期展开 / 收起；框大小固定，多了在框里滚",
    body: '<div class="tl-bar"><input type="search" id="diarySearch" placeholder="搜日记：写过的词，或 2026-10 这样的日期" value="' + esc(DL.q) + '">' +
      '<span class="tl-total">共 ' + num(l.diaryTotal) + " 篇" + (num(l.diaryTotal) > (l.diary || []).length ? "（载入最近 " + (l.diary || []).length + " 篇）" : "") + "</span></div>" +
      '<div id="lifeDiaryBody" class="diary-scroll">' + diaryBodyHtml() + "</div>",
  });
  const cardRefs = card({
    title: "自我反思", icon: "brain", hint: "需要多条证据，证据不足时不会下结论",
    body: '<div id="lifeReflectionBody" class="refs-scroll">' + reflectionBodyHtml() + "</div>",
  });
  const middle = '<div class="grid cols-2 mt">' + cardTimeline + "<div>" + cardRelation + cardGoals + "</div></div>";
  const last = '<div class="grid cols-2 mt">' + cardDiary + cardRefs + "</div>";
  return statRowHtml(l) + card1 + cardJobs + middle + last;
}

/* ------------------------------ 主动与日程 ------------------------------ */

async function pageSchedule() {
  if (!S.schedule) S.schedule = await api("/api/schedule");
  const s = S.schedule;
  const p = s.proactive || {};
  const reminders = (s.reminders || []).map((r) =>
    "<tr><td>" + esc(r.text) + "</td><td>" + esc(r.target_id || "—") + '</td><td class="mono small">' + esc(r.atText || t(r.at)) + "</td><td>" + esc({ none: "一次性", daily: "每天", weekly: "每周" }[r.repeat_rule] || r.repeat_rule) + "</td><td>" + (r.enabled ? pill("启用", "ok") : pill("已停用", "")) + '</td><td class="nowrap">' +
    '<button class="btn sm ghost" data-rem-toggle="' + r.id + '" data-en="' + (r.enabled ? "0" : "1") + '">' + (r.enabled ? "停用" : "启用") + '</button> <button class="btn sm danger" data-rem-del="' + r.id + '">删除</button></td></tr>'
  ).join("");
  const birthdays = (s.birthdays || []).map((b) =>
    '<div class="row" style="padding:6px 0;border-bottom:1px solid rgba(148,163,199,.1)"><span class="small" style="flex:1">' + esc(b.name || b.peer_id) + '</span><span class="mono small">' + esc(b.month_day) + '</span><button class="btn sm danger" data-bd-del="' + b.id + '">删除</button></div>'
  ).join("") || '<div class="muted small">还没有录入生日。</div>';
  const state = (p.state || []).map((x) =>
    '<div class="row small" style="padding:4px 0"><span class="mono">' + esc(x.peerId) + '</span><span class="muted">今天已发 ' + num(x.count) + ' 条 · 未回复 ' + num(x.unanswered) + ' 次</span><span class="spacer"></span><span class="muted">下次约 ' + (x.nextAt ? t(x.nextAt) : "待定") + "</span></div>"
  ).join("");

  return '<div class="grid cols-2">' +
    card({
      title: "主动找你说话", icon: "bell", hint: "默认关闭——所有对外主动行为都需要你显式打开",
      body: switchRow("greet_on", "启用随机搭话", p.enabled === true, "间隔在下面两个值之间随机") +
        '<div class="grid cols-2 mt" style="gap:0 16px">' +
        field("最短间隔（分钟）", "greet_min", ((p.targets || [])[0] || {}).minMinutes || 180, { type: "number", min: 5 }) +
        field("最长间隔（分钟）", "greet_max", ((p.targets || [])[0] || {}).maxMinutes || 480, { type: "number", min: 5 }) +
        field("每天最多几条", "greet_daily", ((p.targets || [])[0] || {}).dailyMax || 3, { type: "number", min: 0 }) +
        field("连续 N 条没人回就停手", "greet_unans", p.maxUnanswered || 3, { type: "number", min: 1 }) +
        "</div>" +
        '<div class="grid cols-2" style="gap:0 16px">' + field("免打扰开始", "greet_qf", (p.quietHours || {}).from || "23:30") + field("免打扰结束", "greet_qt", (p.quietHours || {}).to || "07:30") + "</div>" +
        switchRow("greet_quiet", "启用免打扰时段", (p.quietHours || {}).enabled !== false) +
        '<div class="row mt"><button class="btn primary" id="btnSaveGreet">' + ICON("save", 16) + "保存</button>" +
        '<button class="btn" id="btnGreetNow">' + ICON("send", 16) + "立刻主动发一条（会真的发出去）</button></div>" +
        (state ? '<div class="mt"><div class="small muted mb">当前节奏</div>' + state + "</div>" : ""),
    }) +
    card({
      title: "早 / 午 / 晚安", icon: "sunrise",
      body: ["morning", "noon", "night"].map((k) => {
        const c = s[k] || {};
        const label = { morning: "早安", noon: "午安", night: "晚安" }[k];
        const iconName = { morning: "sunrise", noon: "sun", night: "bed" }[k];
        return '<div style="padding:10px 0;border-bottom:1px solid rgba(148,163,199,.1)"><div class="row">' + ICON(iconName, 18) + '<strong class="small">' + label + "</strong>" +
          '<label class="switch" style="margin-left:auto"><input type="checkbox" id="meal_' + k + '"' + (c.enabled ? " checked" : "") + '><span class="track"></span></label></div>' +
          '<div class="grid cols-2 mt-sm" style="gap:0 12px">' + field("时间", "meal_at_" + k, c.at || "", { tip: "HH:MM" }) + field("自定义文案（留空=她自己写）", "meal_text_" + k, c.text || "") + field("过期跳过（分钟）", "meal_window_" + k, c.windowMinutes ?? 30, { type: "number", min: 1, max: 180, tip: "超过有效期不再补发，也不会跨到下一个问候时段" }) + "</div></div>";
      }).join("") + '<button class="btn primary mt" id="btnSaveMeals">' + ICON("save", 16) + "保存问候设置</button>",
    }) +
    card({
      title: "节日与生日", icon: "cake", hint: "同一年的同一个节日/生日最多发一次",
      body: switchRow("holiday_on", "启用节日祝福", (s.holidays || {}).enabled !== false) +
        '<div class="small muted mt-sm">今天是：' + esc((s.todayHolidays || []).join("、") || "普通的一天") + "</div>" +
        '<div class="mt"><div class="small soft mb">生日名单</div>' + birthdays +
        '<div class="row mt-sm"><input type="text" id="bd_name" placeholder="名字" style="flex:1"><input type="text" id="bd_md" placeholder="MM-DD" style="width:110px"><input type="text" id="bd_qq" placeholder="QQ（可留空）" style="width:140px"><button class="btn sm primary" id="btnAddBd">添加</button></div></div>' +
        '<button class="btn primary mt" id="btnSaveHoliday">' + ICON("save", 16) + "保存节日设置</button>",
    }) +
    card({
      title: "事件提醒", icon: "clock", hint: "她用自己的话提醒你，不是闹钟播报",
      body: '<div class="row mb"><input type="datetime-local" id="rem_at" style="flex:1"><input type="text" id="rem_text" placeholder="提醒什么，例如「下午三点面试」" style="flex:2">' +
        '<select id="rem_repeat" style="width:120px"><option value="none">一次性</option><option value="daily">每天</option><option value="weekly">每周</option></select>' +
        '<button class="btn primary" id="btnAddRem">' + ICON("plus", 16) + "添加</button></div>" +
        selectField("离线错过的提醒怎么办", "rem_offline", (s.reminders || {}).offlinePolicy || "skip", [{ value: "skip", label: "跳过（默认，不打扰）" }, { value: "send", label: "补发一次" }]) +
        (reminders ? '<div class="table-wrap"><table><thead><tr><th>内容</th><th>发给</th><th>时间</th><th>重复</th><th>状态</th><th>操作</th></tr></thead><tbody>' + reminders + "</tbody></table></div>" : emptyState("还没有提醒", "加一条试试，到点她会用自己的话说给你听", "clock")),
    }) +
    "</div>";
}

/* ------------------------------- QQ 空间 ------------------------------- */

async function pageQzone() {
  await loadQzone();
  const q = S.qzone || {};
  const caps = q.capabilities || [];
  const cfgQ = q.config || {};
  const ap = cfgQ.autoPost || {};
  const ar = cfgQ.autoReact || {};
  const drafts = ((q.scheduler || {}).drafts || []).map((d) =>
    '<div class="card" style="background:rgba(255,255,255,.03);box-shadow:none;padding:14px 16px;margin-top:10px"><div class="pre-wrap">' + esc(d.text) + '</div><div class="row mt-sm"><span class="tiny muted">' + t(d.at) + " · " + esc(d.status) + '</span><span class="spacer"></span>' +
    '<button class="btn sm ok" data-draft-approve="' + d.id + '">' + ICON("check", 15) + '发布</button><button class="btn sm ghost" data-draft-reject="' + d.id + '">不发了</button></div></div>'
  ).join("");
  const capRows = caps.map((c) =>
    "<tr><td>" + esc(c.label) + "</td><td>" + pill({ unknown: "未验证", discovered: "发现接口", api_verified: "接口可用", end_to_end_verified: "端到端已验证", degraded: "降级", disabled: "已禁用" }[c.status] || c.status, c.status === "end_to_end_verified" ? "ok" : c.status === "api_verified" ? "info" : c.status === "degraded" ? "warn" : "") + "</td>" +
    '<td class="small muted">' + esc(c.note || "—") + '</td><td class="tiny muted">' + (c.checkedAt ? ago(c.checkedAt) : "—") + "</td></tr>"
  ).join("");
  const actions = ((q.actions || []) || []).slice(0, 20).map((a) =>
    "<tr><td>" + esc(a.action) + '</td><td class="mono tiny truncate">' + esc(a.target_post || "—") + "</td><td>" + pill(a.statusLabel || a.status, a.status === "verified" ? "ok" : a.status === "failed" ? "danger" : a.status === "sent_unverified" ? "warn" : "info") + '</td><td class="tiny muted">' + t(a.at) + "</td></tr>"
  ).join("");
  const check = q.lastCheck;
  const checkHtml = check ? '<div class="mt"><div class="small soft mb">上次自检：' + t(check.at) + '</div>' +
    (check.steps || []).map((st) => '<div class="row small" style="padding:3px 0">' + ICON(st.ok ? "check" : "x", 15) + '<span style="color:var(--' + (st.ok ? "ok" : "danger") + ')">' + esc(st.name) + '</span><span class="muted" style="flex:1">' + esc(st.detail) + "</span></div>").join("") +
    '<div class="notice ' + (check.hint ? "warn" : "ok") + ' mt-sm">' + ICON(check.hint ? "alert" : "check", 18) + '<div><div class="nt">' + esc(check.conclusion) + "</div>" + (check.hint ? '<div class="nd">' + esc(check.hint) + "</div>" : "") + "</div></div></div>" : '<div class="muted small mt">还没做过自检。</div>';

  const intro = '<div class="notice warn mb">' + ICON("shield", 18) + '<div><div class="nt">关于 QQ 空间的实话</div><div class="nd">空间接口受 QQ 版本与账号影响很大。这里的每个能力都要单独通过「真实账号端到端验证」才算可用；没验证过的能力不会自动执行，也不会被宣称支持。</div></div></div>';
  const capCard = card({
    title: "能力门控", icon: "shield", hint: "只有「端到端已验证」的能力才会被自动执行",
    body: '<div class="table-wrap"><table><thead><tr><th>能力</th><th>状态</th><th>说明</th><th>检查时间</th></tr></thead><tbody>' + capRows + "</tbody></table></div>" +
      '<div class="row mt"><button class="btn primary" id="btnQzCheck">' + ICON("activity", 16) + "空间自检</button>" +
      '<button class="btn" id="btnQzMy">' + ICON("list", 16) + "读我自己的说说</button>" +
      '<button class="btn" id="btnQzFeeds">' + ICON("users", 16) + "读好友动态</button></div>" + checkHtml,
  });
  const postCard = card({
    title: "发说说", icon: "feather", hint: "默认只生成草稿，要你点发布才真的发",
    body: field("写作提示（留空就随她自己想）", "qz_topic", ap.hint || "", { rows: 2 }) +
      '<div class="row"><button class="btn" id="btnQzDraft">' + ICON("wand", 16) + "AI 写一条草稿</button>" +
      '<button class="btn" id="btnQzPost">' + ICON("upload", 16) + "直接发布（会真的发出去）</button>" +
      '<button class="btn ghost" id="btnQzDry">' + ICON("eye", 16) + "只演练不发</button></div>" +
      '<div class="mt"><textarea id="qz_content" rows="3" placeholder="也可以自己写一条说说，然后点「直接发布」"></textarea></div>' +
      (drafts ? '<div class="mt"><div class="small soft mb">待审核草稿</div>' + drafts + "</div>" : ""),
  });
  const autoPostCard = card({
    title: "自动发动态", icon: "clock", hint: "在间隔范围内随机挑时间；默认先出草稿等你确认",
    body: switchRow("qz_enabled", "启用空间功能", cfgQ.enabled === true, "总开关，关掉后一切空间操作都不执行") +
      switchRow("qz_autopost", "启用自动发动态", ap.enabled === true) +
      switchRow("qz_postapprove", "自动发之前要我先确认", ap.requireApproval !== false) +
      '<div class="grid cols-2 mt" style="gap:0 16px">' + field("最短间隔（分钟）", "qz_post_min", ap.minIntervalMinutes || 180, { type: "number" }) + field("最长间隔（分钟）", "qz_post_max", ap.maxIntervalMinutes || 420, { type: "number" }) + "</div>" +
      '<button class="btn primary" id="btnSaveQzPost">' + ICON("save", 16) + "保存</button>",
  });
  const autoReactCard = card({
    title: "自动点赞与评论", icon: "heart", hint: "每条动态只处理一次，不会重复刷屏",
    body: switchRow("qz_autoreact", "启用自动互动", ar.enabled === true) +
      switchRow("qz_like", "点赞", ar.like !== false) +
      switchRow("qz_comment", "评论", ar.comment !== false) +
      switchRow("qz_selfspace", "也扫对方自己空间的说说", ar.selfSpace !== false, "好友动态流里翻不到时会用到") +
      field("扫描间隔（分钟）", "qz_scan", ar.scanIntervalMinutes || 10, { type: "number", min: 2 }) +
      field("评论概率", "qz_chance", ar.commentChance ?? 0.7, { type: "number", min: 0, max: 1, step: 0.05 }) +
      '<div class="row"><button class="btn primary" id="btnSaveQzReact">' + ICON("save", 16) + "保存</button>" +
      '<button class="btn" id="btnQzReactDry">' + ICON("eye", 16) + "先演练一次</button></div>",
  });
  const actionCard = card({
    title: "操作记录", icon: "list", hint: "「已发出，待核验」表示接口返回成功，但还没能确认页面上真的生效",
    body: actions
      ? '<div class="table-wrap"><table><thead><tr><th>动作</th><th>目标</th><th>状态</th><th>时间</th></tr></thead><tbody>' + actions + "</tbody></table></div>"
      : emptyState("还没有操作记录", "空间功能默认关闭，做过的每一步都会记在这里", "list"),
  });
  return intro + '<div class="grid cols-2">' + capCard + postCard + autoPostCard + autoReactCard + actionCard + "</div>";
}

async function loadQzone() { S.qzone = await api("/api/qzone"); }

/* ------------------------------ 模型与资费 ------------------------------ */

/**
 * 模型选择器。
 *
 * 为什么不只是一个输入框：各家的模型名经常变（Kimi 的 moonshot-v1-8k 已经下线，
 * 调用会 404 resource_not_found_error）。所以这里是：
 *   ① 把「这家 API 实际返回的模型」列成下拉，选就行；
 *   ② 还没拉过就先按预设列出来；
 *   ③ 「拉取可用模型」按钮直接问 /models，拿真实列表；
 *   ④ 想填别的名字也能手动输入（不在列表里会提示自己去确认价格）。
 */
function modelPickerHtml(profile) {
  const available = Array.isArray(profile.availableModels) ? profile.availableModels : [];
  const preset = ((providerPreset(profile.provider) || {}).models || []).map((item) => item.id);
  const known = available.length ? available : preset;
  const current = profile.model || "";
  const options = known.slice();
  if (current && !options.includes(current)) options.unshift(current);
  const optionHtml = options
    .map((id) => '<option value="' + esc(id) + '"' + (id === current ? " selected" : "") + ">" + esc(id) + "</option>")
    .join("");
  const fetched = profile.modelsFetchedAt
    ? "上次拉取：" + t(profile.modelsFetchedAt) + "（" + available.length + " 个）"
    : "还没拉取过，下面是预设列表";
  return '<div class="field"><label for="llm_model">聊天用哪个模型</label>' +
    (known.length
      ? '<select id="llm_model">' + optionHtml + '<option value="__manual__">手动填写别名字…</option></select>'
      : '<input type="text" id="llm_model" value="' + esc(current) + '" placeholder="模型名，例如 kimi-k2.6">') +
    '<div class="row mt-sm" style="gap:8px;align-items:center">' +
    '<button class="btn sm ghost" id="btnFetchModels">' + ICON("download", 15) + "拉取可用模型</button>" +
    '<span class="tiny muted">' + esc(fetched) + "</span></div>" +
    (profile.modelsFetchError ? '<div class="tiny danger-text mt-sm">上次拉取失败：' + esc(profile.modelsFetchError) + "</div>" : "") +
    '<input type="text" id="llm_model_manual" class="mt-sm hidden" placeholder="手动填模型名">' +
    "</div>";
}

function providerPreset(providerId) {
  const list = (S.llm && S.llm.providers) || [];
  return list.find((item) => item.id === providerId) || null;
}

/** 读出当前选的模型：下拉选了「手动填写」就用输入框里的。 */
function currentModelValue() {
  const sel = $("#llm_model");
  if (sel && sel.tagName === "SELECT") {
    if (sel.value === "__manual__") return String(val("llm_model_manual") || "").trim();
    return String(sel.value || "").trim();
  }
  const manual = String(val("llm_model_manual") || "").trim();
  return manual || String(val("llm_model") || "").trim();
}

async function pageLlm() {
  if (!S.llm) S.llm = await api("/api/llm");
  if (!S.config) S.config = (await api("/api/config")).config;
  const l = S.llm;
  const st = l.status || {};
  const cfg = S.config;
  const profileId = cfg.llm.activeProfile;
  const profile = (cfg.llm.profiles || {})[profileId] || {};
  const budget = l.budget || { scopes: [] };
  const usage = l.usage || { totals: {}, rows: [], byDay: [] };
  const providers = l.providers || [];

  const providerCards = providers.map((p) =>
    '<button class="provider' + (p.id === profile.provider ? " active" : "") + '" data-provider="' + esc(p.id) + '">' +
    '<span class="pn">' + ICON(p.id === profile.provider ? "check" : "globe", 16) + esc(p.name) + "</span>" +
    '<span class="pd">' + esc(p.note || "") + "</span></button>"
  ).join("");

  const taskRows = (l.taskTypes || []).map((tk) =>
    '<tr><td>' + esc(tk.name) + '<div class="tiny muted">' + esc(tk.hint) + "</div></td>" +
    '<td><select data-route="' + esc(tk.id) + '">' + Object.entries(cfg.llm.profiles || {}).map(([id, pr]) => '<option value="' + esc(id) + '"' + (cfg.llm.taskRoutes[tk.id] === id ? " selected" : "") + ">" + esc(pr.name || id) + "</option>").join("") + "</select></td></tr>"
  ).join("");

  const budgetRows = budget.scopes.map((s) =>
    '<div style="margin-bottom:12px"><div class="row"><span class="small soft">' + esc(s.label) + '</span><span class="spacer"></span><span class="small mono">' + money(s.spent) + (s.reserved ? " (+" + money(s.reserved) + " 预留)" : "") + " / " + (s.limit ? money(s.limit) : "不限") + "</span></div>" + (s.limit ? bar(s.ratio) : '<div class="muted tiny">没有上限</div>') + "</div>"
  ).join("");

  const usageRows = (usage.rows || []).map((r) =>
    "<tr><td>" + esc(r.task) + '</td><td class="small">' + esc(r.model) + '</td><td class="mono small">' + num(r.calls) + '</td><td class="mono small">' + num(r.tokens_in) + " / " + num(r.tokens_out) + '</td><td class="mono small">' + money(r.cost) + "</td></tr>"
  ).join("") || '<tr><td colspan="5" class="muted small">最近 30 天还没有模型调用记录</td></tr>';

  return card({
    title: "连接模型", icon: "key", hint: "选一家 → 粘贴 Key → 点测试，就这么简单",
    body: '<div class="grid cols-4 mb">' + providerCards + "</div>" +
      '<div class="notice info mb">' + ICON("info", 18) + '<div><div class="nt">需要你自己的 API Key</div><div class="nd">选一家服务商 → 把它给你的 Key 粘到下面 → 点「测试连接」。Key 只保存在你自己的电脑上（<span class="mono">config.json</span>），不会上传到任何地方。</div></div></div>' +
      '<div class="grid cols-2" style="gap:0 16px">' +
      field("服务商", "llm_provider", profile.provider || "deepseek") +
      field("接口地址（Base URL）", "llm_base", profile.baseUrl || "", { tip: "一般不用改" }) +
      "</div>" +
      field("API Key", "llm_key", "", { type: "password", placeholder: profile.hasApiKey ? "已保存：" + (profile.apiKeyHint || "") + "（留空表示不修改）" : "sk-..." }) +
      '<div class="grid cols-2" style="gap:0 16px">' +
      modelPickerHtml(profile) +
      field("温度（越大越活泼）", "llm_temp", profile.temperature ?? 1.15, { type: "number", min: 0, max: 2, step: 0.05, tip: "有些模型只接受 1" }) +
      "</div>" +
      '<div class="grid cols-3" style="gap:0 16px">' +
      field("单次回复上限（token）", "llm_maxtok", profile.maxTokens || 700, { type: "number", min: 64, max: 65536, step: 256, tip: "带「思考」的模型会先把额度花在思考上；上限给足（如 65536）更不容易出现「正文为空」。实际按返回 token 计费，不会按上限扣钱。" }) +
      field("输入价格（元/百万 token）", "llm_pin", profile.priceIn ?? 1, { type: "number", min: 0, step: 0.1 }) +
      field("输出价格（元/百万 token）", "llm_pout", profile.priceOut ?? 2, { type: "number", min: 0, step: 0.1 }) +
      "</div>" +
      '<div class="row"><button class="btn primary" id="btnSaveLlm">' + ICON("save", 16) + "保存模型设置</button>" +
      '<button class="btn ok" id="btnTestLlm">' + ICON("plug", 16) + "测试连接</button>" +
      '<button class="btn ghost" id="btnMaxTokens" title="把上面的单次回复上限填成面板允许的最大值（65536），再点「保存模型设置」生效">' + ICON("wand", 16) + "单次回复上限调到最大</button>" +
      '<span class="spacer"></span>' + (st.ready ? pill("就绪 · " + esc(st.model || ""), "ok") : pill("还没配好", "warn")) + "</div>" +
      (st.lastTestMessage ? '<div class="notice ' + (st.lastTestOk ? "ok" : "danger") + ' mt">' + ICON(st.lastTestOk ? "check" : "alert", 18) + '<div><div class="nt">上次测试：' + t(st.lastTestAt) + '</div><div class="nd">' + esc(st.lastTestMessage) + "</div></div></div>" : "") +
      '<div class="mt"><div class="small soft mb">不同任务可以用不同的模型省钱</div><div class="table-wrap"><table><thead><tr><th>任务</th><th>用哪个模型配置</th></tr></thead><tbody>' + taskRows + '</tbody></table></div>' +
      '<button class="btn sm primary mt-sm" id="btnSaveRoutes">' + ICON("save", 15) + "保存路由</button></div>",
  }) +
    '<div class="grid cols-2 mt">' +
    card({
      title: "预算闸门", icon: "wallet", hint: "调用前原子预留额度，并发也不会突破上限",
      body: budgetRows +
        '<div class="grid cols-3" style="gap:0 16px">' +
        field("全局日预算", "bud_global", cfg.budget.globalDaily, { type: "number", min: 0, step: 0.5 }) +
        field("私聊日预算", "bud_private", cfg.budget.privateDaily, { type: "number", min: 0, step: 0.5 }) +
        field("群聊日预算", "bud_group", cfg.budget.groupDaily, { type: "number", min: 0, step: 0.5 }) +
        "</div>" +
        '<div class="row"><button class="btn primary" id="btnSaveBudget">' + ICON("save", 16) + "保存预算</button>" +
        '<button class="btn ghost" id="btnResetBudget">' + ICON("refresh", 16) + '重置今日统计</button></div>',
    }) +
    card({
      title: "账单", icon: "scroll", hint: "Actual 是模型返回的真实用量；估算是按价格推算的",
      body: '<div class="grid cols-3 mb">' + stat("近 30 天调用", num(usage.totals.calls)) + stat("总 token", num(usage.totals.tokensIn) + num(usage.totals.tokensOut)) + stat("估算费用", money(usage.totals.cost)) + "</div>" +
        '<div class="table-wrap" style="max-height:320px;overflow-y:auto"><table><thead><tr><th>任务</th><th>模型</th><th>次数</th><th>token 入/出</th><th>费用</th></tr></thead><tbody>' + usageRows + "</tbody></table></div>",
    }) +
    "</div>";
}

/* ------------------------------ 运行环境 ------------------------------ */

async function pageSystem() {
  if (!S.system) S.system = await api("/api/system");
  const sys = S.system;
  const cfg = S.config || (S.config = (await api("/api/config")).config);
  const proto = sys.protocol || {};
  const rt = sys.runtime || {};
  const st = sys.settings || {};
  const warn = (proto.warnings || []).map((w) => '<div class="notice warn mt-sm">' + ICON("alert", 18) + '<div class="nd">' + esc(w) + "</div></div>").join("");

  // 协议端实时状态（这一个卡片就是「连不上怎么办」的答案）
  if (!S.protocolLive) S.protocolLive = await api("/api/protocol").catch(() => null);
  const live = S.protocolLive || {};
  const protoState = live.running
    ? pill("账号端口可连接", "info", "pulse")
    : live.bridgeRunning
      ? pill("协议端可能运行 · 账号端口未连接", "warn", "pulse")
      : pill("未检测到协议端", "danger");
  const blockers = (live.blockers || []).map((item) =>
    '<div class="notice warn mt-sm">' + ICON("alert", 18) + '<div><div class="nt">' + esc(item.title) + '</div><div class="nd">' + esc(item.detail) +
    '</div><div class="tiny muted mt-sm">→ ' + esc(item.fix) + "</div></div></div>"
  ).join("");
  const protocolCard = card({
    title: "协议端（把 QQ 变成接口的那个程序）",
    icon: "plug",
    hint: live.running ? "端口连通不代表 QQ 已连接" : live.bridgeRunning ? "账号端口未连接" : "未检测到运行中的协议端",
    className: live.running ? "" : "repair-card",
    body:
      '<div class="grid cols-3 mb" style="gap:12px">' +
      stat("协议端", protoState, "") +
      stat("监听端口", String(live.port || "—")) +
      stat("部署方式", live.shared ? "多实例共用" : "独立") +
      "</div>" +
      '<div class="kv"><span class="k">协议端目录</span><span class="mono tiny" style="word-break:break-all">' + esc(live.dir || "—") + "</span>" +
      '<span class="k">入口文件</span><span class="mono tiny">' + esc(live.entry ? live.entry.split("\\").pop() : "—") + "</span>" +
      '<span class="k">账号配置</span><span>' + (live.configFound ? pill("已找到", "ok") : pill("没找到", "warn")) + "</span>" +
      '<span class="k">下一步建议</span><span class="small">' + esc(live.nextAction || "—") + "</span></div>" +
      blockers +
      '<div class="row mt">' +
      '<button class="btn primary" id="btnProtoEnsure">' + ICON("play", 16) + (live.running ? "检查并保持运行" : "启动协议端") + "</button>" +
      '<button class="btn" id="btnProtoRestart">' + ICON("refresh", 16) + "重启协议端</button>" +
      '<button class="btn" id="btnProtoRecheck">' + ICON("refresh", 16) + "重新诊断</button>" +
      '<button class="btn ghost" id="btnProtoLog2">' + ICON("terminal", 16) + "看日志</button>" +
      "</div>" +
      '<div id="protoOut" class="mt"></div>' +
      (live.shared
        ? '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nt">多实例共用同一份协议端</div><div class="nd">SnowLuma 靠往 QQ 客户端里注入 hook 才能收发消息，一个 QQ 进程只认一份 hook，所以这台机器上只能跑一份协议端。' +
          "所有实例都共用主实例目录下这份 <span class=\"mono\">protocol\\</span>，每个实例只把自己的 QQ 号写进它的 <span class=\"mono\">config\\onebot_&lt;QQ&gt;.json</span>（各自的端口/令牌），因此可以同时在线。" +
          "改了端口或者新登录了一个号之后，点上面的「重启协议端」让它重新读配置即可。</div></div></div>"
        : '<div class="notice info mt">' + ICON("info", 18) + '<div><div class="nt">自行准备协议端</div><div class="nd">心语不包含 SnowLuma。请从 <a href="https://github.com/SnowLuma/SnowLuma/releases" target="_blank" rel="noopener noreferrer">SnowLuma 官方发布页</a> 下载并解压，先自行运行其启动器，按协议端提示打开 WebUI、阅读并确认协议及隐私政策、修改初始密码。然后在下方填写协议端目录并保存、重启。QQ 客户端也需要自行安装并登录机器人账号。协议端日志可能包含敏感信息，请勿分享。</div></div></div>'),
  });

  return '<div class="grid cols-2">' + protocolCard +
    card({
      title: "QQ 与协议端", icon: "plug", hint: "机器人靠协议端（SnowLuma / NapCat）连上 QQ",
      body: '<div class="kv mb"><span class="k">机器人 QQ</span><span class="mono">' + esc(cfg.bot.selfId || "—") + '</span>' +
        '<span class="k">对方 QQ</span><span class="mono">' + esc(cfg.bot.masterId || "还没设置") + '</span>' +
        '<span class="k">对方的称呼</span><span>' + esc(cfg.bot.masterName || "—") + "</span></div>" +
        '<div class="row mb"><button class="btn sm" id="btnJumpAccount2">' + ICON("user", 15) + "去「QQ 账号」修改这两个号</button></div>" +
        '<div class="grid cols-2" style="gap:0 16px">' +
        field("面板端口", "bot_panelport", cfg.bot.panelPort, { type: "number", tip: "改完要重启" }) +
        field("协议端 WebSocket", "bot_ws", cfg.bot.onebotWsUrl, { tip: "默认 ws://127.0.0.1:3101/" }) +
        "</div>" +
        field("协议端 HTTP", "bot_http", cfg.bot.onebotHttpUrl) +
        field("访问令牌", "bot_token", "", { type: "password", placeholder: cfg.bot.accessToken ? "已保存（留空不修改）" : "没有令牌就留空" }) +
        '<div class="row"><button class="btn primary" id="btnSaveBot">' + ICON("save", 16) + "保存端口设置</button>" +
        '<button class="btn" id="btnPing">' + ICON("wifi", 16) + "测试 QQ 连接</button>" +
        '<button class="btn ghost" id="btnSyncProto">' + ICON("link", 16) + "把端口写进协议端配置</button></div>" +
        (proto.configFound ? '<div class="notice ok mt">' + ICON("check", 18) + '<div><div class="nt">已找到协议端配置</div><div class="nd mono tiny">' + esc(proto.configFile) + "</div></div></div>" : warn),
    }) +
    card({
      title: "数据目录", icon: "folder", hint: "把数据放在哪，程序就可以随便挪",
      body: '<div class="kv">' + Object.entries(sys.paths || {}).map(([k, v]) => '<span class="k">' + esc(k) + '</span><span class="mono tiny" style="word-break:break-all">' + esc(v) + "</span>").join("") + "</div>" +
        '<div class="grid cols-2 mt" style="gap:0 16px">' +
        field("数据目录（留空用默认）", "set_data", st.dataDir, { tip: "改完重启生效，老数据需要自己拷过去" }) +
        field("日志目录", "set_log", st.logDir) +
        "</div>" +
        field("协议端目录", "set_snow", st.snowlumaDir, { tip: "SnowLuma / NapCat 所在目录" }) +
        '<label class="switch mt-sm"><input type="checkbox" id="set_autoProto"' + (st.autoStartProtocol !== false ? " checked" : "") + '><span class="track"></span><span>启动心语时自动启动已配置的协议端 <span class="tiny muted">请先自行完成协议端许可确认</span></span></label>' +
        '<div class="row"><button class="btn primary" id="btnSaveSettings">' + ICON("save", 16) + "保存目录设置</button>" +
        '<button class="btn" id="btnBackup">' + ICON("download", 16) + "立即备份数据库</button>" +
        '<button class="btn danger" id="btnRestart">' + ICON("power", 16) + "重启机器人</button></div>" +
        '<div class="mt small muted">最近备份：' + ((sys.backups && sys.backups.length) ? esc(sys.backups[0].name) : "还没有") + "</div>",
    }) +
    card({
      title: "启动与托盘", icon: "power", hint: "双击图标启动，关掉窗口不会退出",
      body:
        '<div id="startupBox">' +
        '<label class="switch" style="margin:2px 0"><input type="checkbox" id="acc_autostart"' + (sys.autostart && sys.autostart.installed ? " checked" : "") + '><span class="track"></span><span>开机自动启动 <span class="tiny muted">登录 Windows 后在托盘里静默运行</span></span></label>' +
        '<label class="switch" style="margin:2px 0"><input type="checkbox" id="acc_openpanel"' + (st.openPanelOnStart !== false ? " checked" : "") + '><span class="track"></span><span>启动时打开控制面板窗口 <span class="tiny muted">关掉后只留托盘图标</span></span></label>' +
        '<div class="tiny muted mt-sm">' + (sys.autostart && sys.autostart.installed ? "当前已登记开机自启。" : "当前没有登记开机自启。") + "</div>" +
        "</div>" +
        '<div class="kv mt"><span class="k">运行方式</span><span class="small">' + (rt.isSea ? "单文件 exe（自带 Node，双击即用）" : rt.installed ? "安装版（自带 Node）" : "源码模式（node index.mjs）") + "</span>" +
        '<span class="k">启动项</span><span class="mono tiny" style="word-break:break-all">' + esc((sys.autostart && sys.autostart.file) || "—") + "</span></div>" +
        '<div class="row mt-sm"><button class="btn" id="btnOpenPanel">' + ICON("external", 16) + "再开一个面板窗口</button>" +
        '<button class="btn danger" id="btnQuit">' + ICON("power", 16) + "退出心语</button></div>" +
        '<div class="notice info mt">' + ICON("info", 18) + '<div class="nd">关掉控制面板窗口只是缩进托盘，机器人在后台继续跑。要彻底停下来：右键托盘图标 →「退出心语（完全停止）」，或者点这里。</div></div>',
    }) +
    card({
      title: "运行信息", icon: "cpu",
      body: '<div class="kv">' +
        '<span class="k">心语版本</span><span class="mono">' + esc(rt.version || "未知") + "</span>" +
        '<span class="k">Node</span><span class="mono">' + esc(rt.node) + "</span>" +
        '<span class="k">系统</span><span class="mono">' + esc(rt.platform) + "</span>" +
        '<span class="k">SQLite</span><span class="mono">' + esc(rt.sqlite) + "</span>" +
        '<span class="k">数据库完整性</span><span>' + (rt.integrity && rt.integrity.ok ? pill("正常", "ok") : pill("异常：" + esc(rt.integrity && rt.integrity.value), "danger")) + "</span>" +
        '<span class="k">进程号</span><span class="mono">' + esc(rt.pid) + "</span>" +
        "</div>",
    }) +
    card({
      title: "协议端支持的能力", icon: "list", hint: "连不上时先看这里，能快速判断是协议端的问题还是配置的问题",
      body: (function () {
        const caps = sys.capabilities || {};
        const entries = Object.entries(caps).filter(([k]) => k !== "checkedAt");
        if (!entries.length) return '<div class="muted small">还没探测过。点下面的按钮。</div>';
        return '<div class="table-wrap"><table><thead><tr><th>接口</th><th>状态</th></tr></thead><tbody>' + entries.map(([k, v]) => '<tr><td class="mono small">' + esc(k) + "</td><td>" + pill(v === "api_verified" ? "可用" : v === "unsupported" ? "不支持" : v === "error" ? "出错" : "未验证", v === "api_verified" ? "ok" : v === "unsupported" ? "" : "warn") + "</td></tr>").join("") + "</tbody></table></div>";
      })() + '<button class="btn mt-sm" id="btnProbeCaps">' + ICON("activity", 16) + "探测一次</button>",
    }) +
    "</div>";
}

/* --------------------------------- 日志 --------------------------------- */

/**
 * 面板上的日志缓冲区。
 *
 * 以前这里只有一个「进页面时拉一次 /api/logs 然后丢掉」的写法：
 * 拉回来的 400 条只用了里的 level 字段，内容根本没渲染，
 * 页面全靠 SSE 推送——而系统安静的时候几十秒才有一条 INFO，
 * 用户看到的就是「日志一直是空的」。
 * 现在改成：进入页面先用历史填满，之后 SSE 再往里追加。
 */
const LOG_BUFFER = [];
let LOG_LEVEL_FLOOR = "debug";

function logKey(entry) {
  // 注意：整个前端是包在模板字符串里的，这里不能用反引号
  return [entry.at, entry.level, entry.scope, entry.message].join("|");
}

function pushLogs(list) {
  const seen = new Set(LOG_BUFFER.map(logKey));
  for (const entry of list) {
    const key = logKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    LOG_BUFFER.push(entry);
  }
  if (LOG_BUFFER.length > 800) LOG_BUFFER.splice(0, LOG_BUFFER.length - 800);
}

function renderLogs(list) {
  const box = $("#logBox");
  if (!box) return;
  const order = ["debug", "info", "warn", "error"];
  const floor = order.indexOf(LOG_LEVEL_FLOOR);
  const shown = list.filter((e) => order.indexOf(e.level) >= floor);
  box.innerHTML = shown.length
    ? shown.map((e) => '<div class="log-line ' + esc(e.level) + '">' + esc(e.line || (e.message || "")) + "</div>").join("")
    : '<div class="muted small">这段时间还没有日志。她一收到消息就会出现在这里。</div>';
  if (checked("logFollow")) box.scrollTop = box.scrollHeight;
}

async function pageLogs() {
  const res = await api("/api/logs?limit=400");
  LOG_LEVEL_FLOOR = res.level || "info";
  // 关键：把历史日志真正塞进缓冲区（以前这一步漏了，页面只能是空的）
  pushLogs(res.logs || []);
  return card({
    title: "实时日志", icon: "terminal", hint: "出问题时把这里的内容发给 AI 最有用",
    body: '<div class="row mb"><select id="logLevel" style="width:130px">' + ["debug", "info", "warn", "error"].map((v) => '<option value="' + v + '"' + (res.level === v ? " selected" : "") + ">" + v.toUpperCase() + "</option>").join("") + "</select>" +
      '<span class="spacer"></span><label class="switch"><input type="checkbox" id="logFollow" checked><span class="track"></span><span>自动滚动</span></label>' +
      '<button class="btn ghost sm" id="btnClearLogs">' + ICON("trash", 15) + "清空显示</button></div>" +
      '<div class="logs" id="logBox"></div>' +
      '<div class="mt small muted">共 ' + (res.logs || []).length + ' 条 · 日志文件在：' + esc((S.status && S.status.paths && S.status.paths.logs) || "") + "</div>",
  });
}

/* -------------------------------- 引导向导 -------------------------------- */

async function maybeOnboarding() {
  const res = await api("/api/onboarding");
  S.onboarding = res;
  if (res.done || res.snoozed) return;
  showWizard(res);
}

function showWizard(ob) {
  const steps = ob.steps || {};
  // 注意用 ?? 而不是 ||：S.wizardStep 可能是 0（第 1 步 / 点了两次「上一步」），
  // 用 || 会被当成"没有值"，于是又跳回按完成度算出来的那一步。
  const guessed = steps.character ? (steps.model ? (steps.qq ? 3 : 2) : 1) : 0;
  const step = Number.isInteger(S.wizardStep) ? S.wizardStep : guessed;
  S.wizardStep = step;
  const providers = ob.providers || [];
  const cfg = S.config || {};
  const profile = (cfg.llm && cfg.llm.profiles && cfg.llm.profiles[cfg.llm.activeProfile]) || {};
  const titles = ["赋予她真正的心", "连上大模型", "连上 QQ", "对方是谁"];

  let body = "";
  if (step === 0) {
    body = field("角色名", "wz_name", (S.activeCharacter && S.activeCharacter.name) || "心语", { tip: "别人怎么称呼她" }) +
      field("她是谁（几句话就行）", "wz_persona", (S.activeCharacter && S.activeCharacter.persona) || "", { rows: 5, tip: "出身、身份、平时在做什么。写人话就行，不用写提示词。" }) +
      field("说话风格", "wz_style", (S.activeCharacter && S.activeCharacter.speechStyle) || "称呼对方为「你」，语气温柔自然，句尾偶尔带「呢」「哦」。", { rows: 3, tip: "最影响观感的一项" }) +
      '<div class="notice info">' + ICON("info", 18) + '<div class="nd">后面在「角色工作室」里可以随时改，还有更多细节字段可以填。</div></div>';
  } else if (step === 1) {
    body = '<div class="grid cols-3 mb">' + providers.map((p) => '<button class="provider' + (p.id === (profile.provider || "deepseek") ? " active" : "") + '" data-wz-provider="' + esc(p.id) + '"><span class="pn">' + esc(p.name) + '</span><span class="pd">' + esc(p.note || "") + "</span></button>").join("") + "</div>" +
      field("API Key", "wz_key", "", { type: "password", placeholder: profile.hasApiKey ? "已保存：" + (profile.apiKeyHint || "") + "（留空不修改）" : "sk-..." }) +
      field("模型", "wz_model", profile.model || "deepseek-flash") +
      '<div class="row"><button class="btn ok" id="wzTest">' + ICON("plug", 16) + '测试连接</button><div id="wzTestOut" class="small muted"></div></div>' +
      '<div class="notice info mt">' + ICON("key", 18) + '<div class="nd">把服务商给你的 API Key 粘到上面，然后点「测试连接」。Key 只保存在本机的 config.json 里，不会上传。</div></div>';
  } else if (step === 2) {
    const proto = ob.protocol || {};
    body = field("机器人 QQ 号", "wz_self", ob.suggestions && ob.suggestions.selfId, { tip: "必须在这个电脑的 QQ 客户端里处于登录状态" }) +
      field("协议端地址", "wz_ws", (cfg.bot && cfg.bot.onebotWsUrl) || "ws://127.0.0.1:3101/") +
      (proto.configFound
        ? '<div class="notice ok">' + ICON("check", 18) + '<div><div class="nt">已经找到协议端配置</div><div class="nd mono tiny">' + esc(proto.configFile) + "</div></div></div>"
        : '<div class="notice warn">' + ICON("alert", 18) + '<div><div class="nt">没找到协议端配置</div><div class="nd">' + esc((proto.warnings || [])[0] || "请先启动 SnowLuma / NapCat 并确认 QQ 已登录") + "</div></div></div>") +
      '<div class="row mt"><button class="btn ok" id="wzPing">' + ICON("wifi", 16) + '测试 QQ 连接</button><div id="wzPingOut" class="small muted"></div></div>'
  } else {
    body = field("对方 QQ 号", "wz_master", ob.suggestions && ob.suggestions.masterId, { tip: "你自己的号。她只会主动找这个人，记忆也以此隔离。" }) +
      field("她怎么称呼你", "wz_mastername", (cfg.bot && cfg.bot.masterName) || "指挥官") +
      '<div class="notice info">' + ICON("shield", 18) + '<div><div class="nt">隐私说明</div><div class="nd">所有聊天记录、记忆与费用数据都保存在你自己的电脑上（' + esc((S.status && S.status.paths && S.status.paths.data) || "数据目录") + '）。只有被选中的对话片段会发给你配置的模型服务商。</div></div></div>' +
      '<label class="switch mt"><input type="checkbox" id="wz_privacy" checked><span class="track"></span><span>我明白并同意上面的说明</span></label>';
  }

  const html = '<div class="modal-back" id="wizardBack"><div class="modal">' +
    '<h3>欢迎使用心语</h3><div class="modal-sub">四步就能让她开口说话，随时可以跳过，之后在面板里再配。</div>' +
    '<div class="wizard-steps">' + titles.map((tt, i) => '<div class="wstep ' + (i === step ? "active" : i < step ? "done" : "") + '"><span class="n">' + (i < step ? "✓" : i + 1) + "</span>" + esc(tt) + "</div>").join("") + "</div>" +
    body +
    '<div class="modal-actions"><button class="btn ghost" id="wzSkip">以后再说</button>' +
    (step > 0 ? '<button class="btn" id="wzPrev">上一步</button>' : "") +
    '<button class="btn primary" id="wzNext">' + (step === 3 ? "完成" : "下一步") + "</button></div></div></div>";
  const holder = $("#modal");
  holder.innerHTML = html;
  holder.classList.remove("hidden");

  bind("wzSkip", "click", async () => {
    // 「以后再说」要记住，否则下次打开面板它又弹一次，等于把人挡在面板外面
    await api("/api/onboarding/snooze", {}).catch(() => null);
    holder.classList.add("hidden");
    holder.innerHTML = "";
  });
  $$("[data-wz-provider]").forEach((el) => el.addEventListener("click", () => {
    const id = el.dataset.wzProvider;
    $$(".provider", holder).forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
    const p = providers.find((x) => x.id === id);
    if (p && p.models && p.models[0]) { const m = $("#wz_model"); if (m) m.value = p.models[0].id; }
    S.wizardProvider = id;
  }));
  bind("wzTest", "click", async () => {
    const out = $("#wzTestOut");
    const providerId = S.wizardProvider || ((cfg.llm && cfg.llm.profiles[cfg.llm.activeProfile] || {}).provider) || "deepseek";
    const p = providers.find((x) => x.id === providerId) || {};
    out.textContent = "测试中…";
    const res = await api("/api/llm/test", { profileId: cfg.llm.activeProfile, patch: { provider: providerId, baseUrl: p.baseUrl || "", apiKey: val("wz_key") || undefined, model: val("wz_model") } });
    out.innerHTML = res.ok ? '<span class="ok-text">' + esc(res.message) + "</span>" : '<span class="danger-text">' + esc(res.message) + "</span>";
  });
  bind("wzPing", "click", async () => {
    const out = $("#wzPingOut");
    out.textContent = "连接中…";
    await api("/api/config", { bot: { selfId: Number(val("wz_self")) || undefined, onebotWsUrl: val("wz_ws") } });
    const res = await api("/api/onebot/ping", {});
    out.innerHTML = res.ok ? '<span class="ok-text">连接正常（' + esc(res.info && res.info.nickname) + "）</span>" : '<span class="danger-text">' + esc(res.error || "没连上") + "</span>";
  });
  bind("wzPrev", "click", () => { S.wizardStep = Math.max(0, step - 1); showWizard(ob); });
  bind("wzNext", "click", async () => {
    try {
      if (step === 0) {
        const name = val("wz_name") || "心语";
        if (!S.activeCharacter || !S.activeCharacter.id) {
          const created = await api("/api/characters/new", { name, persona: val("wz_persona"), speechStyle: val("wz_style"), activate: true });
          if (!created.ok) throw new Error(created.message || "角色创建失败");
          S.activeCharacter = created.character;
        } else {
          const saved = await api("/api/characters/" + encodeURIComponent(S.activeCharacter.id), { name, persona: val("wz_persona"), speechStyle: val("wz_style") }, "PUT");
          if (!saved.ok) throw new Error(saved.message || "角色保存失败");
          // 顺带把角色名同步到默认文件名（不改 id）
        }
      } else if (step === 1) {
        const providerId = S.wizardProvider || ((cfg.llm.profiles[cfg.llm.activeProfile] || {}).provider) || "deepseek";
        const p = providers.find((x) => x.id === providerId) || {};
        const patch = { provider: providerId, baseUrl: p.baseUrl || (cfg.llm.profiles[cfg.llm.activeProfile] || {}).baseUrl, model: val("wz_model") };
        const key = val("wz_key").trim();
        if (key) patch.apiKey = key;
        const cur = cfg.llm.profiles[cfg.llm.activeProfile] || {};
        await api("/api/config", { llm: { profiles: { [cfg.llm.activeProfile]: { ...cur, apiKey: "", ...patch } } } });
        S.config = null;
      } else if (step === 2) {
        const patch = { selfId: Number(val("wz_self")) || undefined, onebotWsUrl: val("wz_ws") };
        const token = (cfg.bot && cfg.bot.accessToken) || "";
        await api("/api/config", { bot: patch });
        if (patch.selfId && String(patch.selfId) !== String(cfg.bot.selfId)) S.wizardRestartNeeded = true;
        S.config = null;
      } else {
        if (!$("#wz_privacy").checked) { toast("请先勾选同意隐私说明", "warn"); return; }
        await api("/api/config", { bot: { masterId: Number(val("wz_master")) || 0, masterName: val("wz_mastername") || "指挥官" } });
        await api("/api/onboarding/done", { done: true, steps: { character: true, model: true, qq: true, privacy: true } });
        S.config = null; S.status = null;
        holder.classList.add("hidden"); holder.innerHTML = "";
        toast(S.wizardRestartNeeded ? "配置已保存，请在运行环境中重启心语以连接 QQ" : "配置已保存，请检查 QQ 连接状态", "ok");
        go("overview");
        return;
      }
      S.wizardStep = step + 1;
      await maybeOnboardingRefresh();
    } catch (error) {
      toast("保存失败：" + (error && error.message || error), "error");
    }
  });
}

async function maybeOnboardingRefresh() {
  const res = await api("/api/onboarding");
  S.onboarding = res;
  showWizard(res);
}

async function pageInteraction() {
  const config = await api("/api/config");
  const status = await api("/api/next");
  if (!config.ok || !status.ok) throw new Error("记忆与互动设置加载失败");
  S.nextConfig = config.config;
  S.nextStatus = status;
  const cfg = config.config, memory = cfg.nextMemory, tb = cfg.tb;
  const character = (await api("/api/characters/" + encodeURIComponent(cfg.activeCharacter))).character || {};
  S.nextCharacter = character;
  const groupId = S.nextGroup || "", peerId = S.nextPeer || "";
  const poke = { ...cfg.interaction.poke, ...(character.poke || {}), ...((character.poke || {}).groups || {})[groupId] };
  const pairText = (pairs) => (pairs || []).map((pair) => pair.join(",")).join("\n");
  const serviceFields = ["llm", "embedding", "reranker"].map((kind) => {
    const item = memory[kind], label = { llm: "归档模型", embedding: "Embedding", reranker: "Reranker" }[kind];
    return '<details><summary>' + label + '</summary>' + (kind !== "llm" ? selectField("运行方式", "nx_" + kind + "_provider", item.provider, [{ value: "local", label: "本地（首次下载模型）" }, { value: "external", label: "外部服务" }]) : "") +
      field("服务地址", "nx_" + kind + "_url", item.baseUrl) + field("模型名称", "nx_" + kind + "_model", item.model) + field("API Key（留空保留）", "nx_" + kind + "_key", "", { type: "password" }) + '</details>';
  }).join("");
  const memoryRows = status.memories.map((row) => '<option value="' + esc(row.id) + '">' + esc(row.day + " · " + row.character_id + " · " + row.scope_key) + '</option>').join("");
  let quota = "";
  const quotaValues = {};
  const quotaLabels = { globalPerDay: "全局 / 天", perUserPerMinute: "个人 / 分钟", perUserPerHour: "个人 / 小时", perUserPerDay: "个人 / 天", perGroupPerMinute: "群 / 分钟", perGroupPerHour: "群 / 小时", perGroupPerDay: "群 / 天" };
  if (groupId) {
    const result = await api("/api/next/quota?" + new URLSearchParams({ groupId, peerId: peerId || "0" }));
    if (result.ok) {
      result.checks.forEach((item) => { quotaValues[item.limitKey] = item.limit; });
      quota = '<div class="table-wrap"><table><thead><tr><th>范围 / 周期</th><th>已用</th><th>额度</th><th>剩余</th></tr></thead><tbody>' + result.checks.map((item) => '<tr><td>' + esc(quotaLabels[item.limitKey] || "额度") + '</td><td>' + item.count + '</td><td>' + (item.limit || "不限") + '</td><td>' + (item.remaining === null ? "不限" : item.remaining) + '</td></tr>').join("") + '</tbody></table></div>' + (result.exempt ? '<p>此成员已豁免普通额度，仍受事件冷却约束。</p>' : "");
    }
  }
  const rules = tb.groups[groupId] || {};
  const pending = rules.pendingRules;
  return '<div class="grid" style="gap:16px">' +
    card({ title: "长期记忆", icon: "layers", hint: "明确说回忆一下时才召回；每天整理前一天的对话，历史记录不会自动上传", body:
      switchRow("nx_memory", "启用 Hindsight", memory.enabled) + field("Hindsight 地址", "nx_memory_url", memory.baseUrl) +
      field("Hindsight API Key（留空保留）", "nx_memory_key", "", { type: "password" }) + serviceFields +
      field("共享角色（每行两个角色 ID，用英文逗号分隔）", "nx_character_links", pairText(memory.characterLinks), { rows: 3, tip: "默认隔离；仅开启列出的角色对" }) +
      field("共享群（每行两个群号，用英文逗号分隔）", "nx_group_links", pairText(memory.groupLinks), { rows: 3, tip: "跨群仅明确回忆时使用该用户自己的已授权内容。私人内容进入群聊需本人私聊发送：授权记忆到群 群号；可发送撤销记忆到群 群号。" }) +
      '<button class="btn primary" id="nxSaveMemory">保存记忆设置</button>' +
      '<p class="small pre-wrap">' + esc(status.disclosure.data) + '\n接收服务：\n' + esc(status.disclosure.destinations.map((item) => item.kind + "：" + (item.baseUrl || (item.kind === "llm" ? "未配置" : "本地")) + (item.model ? " / " + item.model : "")).join("\n")) + '</p>' +
      '<div class="row"><button class="btn" id="nxConsent">' + (status.consentValid ? "已同意当前服务，再次确认" : "我同意向以上服务发送所述数据") + '</button><button class="btn" id="nxStartMemory">一键启动本机记忆服务</button><button class="btn" id="nxRefresh">刷新状态</button></div>' +
      '<p class="small">状态：' + esc(({disabled:"未启用",ready:"正常",unavailable:"暂不可用","consent-required":"等待授权"})[status.memoryHealth.state] || "等待使用") + '；' + esc(status.runtimeStatus.message) + '</p>' +
      '<p class="small">QQ 输入状态：' + esc(status.typing.observed ? "已收到协议端事件" : "尚未收到事件；当前使用静默等待") + '</p>' }) +
    card({ title: "查看和维护每日记忆", icon: "layers", body: '<select id="nxMemoryId"><option value="">选择摘要</option>' + memoryRows + '</select>' +
      field("摘要内容", "nxMemoryContent", "", { rows: 5 }) + '<div class="row"><button class="btn" id="nxEditMemory">保存修改</button><button class="btn danger" id="nxDeleteMemory">删除</button><button class="btn" id="nxArchive">整理已结束日期的对话</button></div><p class="small">' + esc(status.erasureNote) + '</p>' }) +
    card({ title: "当前角色的戳一戳", icon: "user", hint: character.name || cfg.activeCharacter, body:
      field("指定群号（留空修改角色默认设置）", "nxPokeGroup", groupId) + '<button class="btn sm" id="nxLoadPokeGroup">读取该群设置</button>' + switchRow("nxPokePrivate", "允许私聊戳一戳", poke.privateEnabled) + switchRow("nxPokeGroupEnabled", "允许群聊戳一戳", poke.groupEnabled) +
      selectField("回复方式", "nxPokeMode", poke.mode, [{ value: "fixed", label: "固定文案" }, { value: "persona", label: "按当前人设生成" }]) + field("固定文案", "nxPokeText", poke.text, { rows: 2 }) + field("冷却（秒）", "nxPokeCooldown", poke.cooldownSec, { type: "number", min: 3, max: 3600 }) +
      '<div class="row"><button class="btn primary" id="nxSavePoke">保存</button><button class="btn" id="nxInheritPoke">指定群恢复继承</button></div>' }) +
    card({ title: "群与成员额度", icon: "users", hint: "各周期同时生效；0 表示不限制。@、戳一戳和欢迎不扣普通额度，但仍受冷却与预算约束", body:
      field("群号", "nxQuotaGroup", groupId) + field("成员 QQ（留空设置本群总额度）", "nxQuotaPeer", peerId) +
      '<button class="btn" id="nxLoadQuota">查看 / 选择对象</button>' + quota +
      '<div class="grid cols-3">' + field("每分钟", "nxQuotaMinute", quotaValues[(peerId ? "perUser" : "perGroup") + "PerMinute"] || 0, { type: "number", min: 0 }) + field("每小时", "nxQuotaHour", quotaValues[(peerId ? "perUser" : "perGroup") + "PerHour"] || 0, { type: "number", min: 0 }) + field("每天", "nxQuotaDay", quotaValues[(peerId ? "perUser" : "perGroup") + "PerDay"] || 0, { type: "number", min: 0 }) + '</div>' +
      '<div class="row"><button class="btn primary" id="nxSaveQuota">保存额度</button><button class="btn" id="nxResetQuota">重置已用额度</button><button class="btn" id="nxExemptQuota">豁免此成员</button><button class="btn" id="nxUnexemptQuota">取消豁免</button></div>' +
      switchRow("nxAdminReset", "允许 QQ 群管理员重置个人额度", cfg.interaction.adminReset, "群内 @机器人后发送：重置额度 QQ号") +
      switchRow("nxAdminExempt", "允许 QQ 群管理员管理豁免", cfg.interaction.adminExempt, "群内 @机器人后发送：豁免额度 QQ号 / 取消豁免 QQ号") + '<button class="btn" id="nxSaveAdmin">保存管理员权限</button>' }) +
    (tb.enabled ? card({ title: "TB 搜索与群规", icon: "settings", body:
      switchRow("nxSearchEnabled", "启用碧蓝资料搜索", tb.search.enabled) + selectField("搜索方式", "nxSearchMode", tb.search.mode, [{ value: "wiki", label: "碧蓝 Wiki（无需 Key）" }, { value: "api", label: "自定义搜索 API" }]) +
      field("搜索 API 地址", "nxSearchUrl", tb.search.baseUrl) + field("搜索 API Key（留空保留）", "nxSearchKey", "", { type: "password" }) + '<button class="btn" id="nxSaveSearch">保存搜索设置</button>' +
      '<hr><p>群规对象：' + esc(groupId || "先在上方选择群号") + '</p>' + switchRow("nxWelcome", "新成员入群时合并发送群规", rules.enabled) +
      selectField("群规来源", "nxRulesSource", rules.source || "notice", [{ value: "notice", label: "群公告（变化后确认）" }, { value: "custom", label: "自定义文字" }]) +
      field("指定公告 ID（留空使用最新公告）", "nxNoticeId", rules.noticeId || "") + field("已确认的群规 / 自定义群规", "nxRulesText", rules.rules || "", { rows: 5 }) +
      '<div class="row"><button class="btn" id="nxSaveRules">保存群规设置</button><button class="btn" id="nxFetchRules">检查群公告</button></div>' +
      (pending ? '<div class="notice warn pre-wrap">有公告更新等待软件管理者确认：\n' + esc(pending.text) + '</div><button class="btn primary" id="nxConfirmRules">确认使用这份群规</button>' : '<p>没有待确认的公告更新。</p>') }) : "") + '</div>';
}

function wireExtensions() {
  const finish = async (result) => { toast(result.ok ? "已保存" : result.message || "操作失败", result.ok ? "ok" : "error"); if (result.ok) await render(); };
  const pairs = (id) => val(id).split(/\n/).map((line) => line.split(",").map((part) => part.trim())).filter((pair) => pair.some(Boolean));
  bind("nxRefresh", "click", () => render());
  bind("nxSaveMemory", "click", async () => {
    const body = { enabled: checked("nx_memory"), baseUrl: val("nx_memory_url"), characterLinks: pairs("nx_character_links"), groupLinks: pairs("nx_group_links") };
    if (val("nx_memory_key")) body.apiKey = val("nx_memory_key");
    ["llm", "embedding", "reranker"].forEach((kind) => { body[kind] = { provider: val("nx_" + kind + "_provider"), baseUrl: val("nx_" + kind + "_url"), model: val("nx_" + kind + "_model"), apiKey: val("nx_" + kind + "_key") }; });
    await finish(await api("/api/next/memory/settings", body));
  });
  bind("nxConsent", "click", async () => { if (confirm("同意将页面说明的数据发给列出的服务？请先保存设置，再核对接收方。")) await finish(await api("/api/next/consent", { fingerprint: S.nextStatus.disclosure.fingerprint, agreed: true })); });
  bind("nxStartMemory", "click", async () => { const result = await api("/api/next/memory/start", {}); toast(result.ok ? "已请求启动，请稍后刷新状态" : result.message, result.ok ? "info" : "error"); });
  bind("nxMemoryId", "change", () => { const row = S.nextStatus.memories.find((item) => item.id === val("nxMemoryId")); $("#nxMemoryContent").value = row ? row.content : ""; });
  bind("nxEditMemory", "click", async () => finish(await api("/api/next/memory/edit", { id: val("nxMemoryId"), content: val("nxMemoryContent") })));
  bind("nxDeleteMemory", "click", async () => { if (confirm("删除这份摘要？旧版本将立即停止召回。")) await finish(await api("/api/next/memory/edit", { id: val("nxMemoryId"), content: "" })); });
  bind("nxArchive", "click", async () => finish(await api("/api/next/memory/archive", {})));
  const savePoke = (inherit) => api("/api/next/poke", { characterId: S.nextCharacter.id, groupId: val("nxPokeGroup"), inherit, privateEnabled: checked("nxPokePrivate"), groupEnabled: checked("nxPokeGroupEnabled"), mode: val("nxPokeMode"), text: val("nxPokeText"), cooldownSec: Number(val("nxPokeCooldown")) });
  bind("nxSavePoke", "click", async () => finish(await savePoke(false)));
  bind("nxLoadPokeGroup", "click", () => { S.nextGroup = val("nxPokeGroup"); render(); });
  bind("nxInheritPoke", "click", async () => finish(await savePoke(true)));
  bind("nxLoadQuota", "click", () => { S.nextGroup = val("nxQuotaGroup"); S.nextPeer = val("nxQuotaPeer"); render(); });
  const quotaAction = (action) => api("/api/next/quota", { action, groupId: val("nxQuotaGroup"), peerId: val("nxQuotaPeer"), minute: val("nxQuotaMinute"), hour: val("nxQuotaHour"), day: val("nxQuotaDay") });
  bind("nxSaveQuota", "click", async () => finish(await quotaAction("save")));
  bind("nxResetQuota", "click", async () => finish(await quotaAction("reset")));
  bind("nxExemptQuota", "click", async () => finish(await quotaAction("exempt")));
  bind("nxUnexemptQuota", "click", async () => finish(await quotaAction("unexempt")));
  bind("nxSaveAdmin", "click", async () => finish(await api("/api/next/admin", { adminReset: checked("nxAdminReset"), adminExempt: checked("nxAdminExempt") })));
  bind("nxSaveSearch", "click", async () => {
    const result = await api("/api/next/tb/search", { enabled: checked("nxSearchEnabled"), mode: val("nxSearchMode"), baseUrl: val("nxSearchUrl"), apiKey: val("nxSearchKey") });
    if (result.ok && val("nxSearchMode") === "api" && confirm(result.disclosure + "\n接收地址：" + val("nxSearchUrl") + "\n是否同意？")) await api("/api/next/tb/search/consent", { fingerprint: result.fingerprint, agreed: true });
    await finish(result);
  });
  const rulesAction = (action) => api("/api/next/tb/rules", { action, groupId: S.nextGroup, enabled: checked("nxWelcome"), source: val("nxRulesSource"), noticeId: val("nxNoticeId"), rules: val("nxRulesText"), fingerprint: (((S.nextConfig.tb.groups || {})[S.nextGroup] || {}).pendingRules || {}).fingerprint });
  bind("nxSaveRules", "click", async () => finish(await rulesAction("save")));
  bind("nxFetchRules", "click", async () => finish(await rulesAction("fetch")));
  bind("nxConfirmRules", "click", async () => finish(await rulesAction("confirm")));
}

/* -------------------------------- 渲染主循环 -------------------------------- */

/* ------------------------------- 插件与技能 ------------------------------- */

function extSafeId(kind, id, key) {
  return ("ext_" + kind + "_" + id + "_" + key).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extSettingField(kind, id, key, rule, value) {
  const fieldId = extSafeId(kind, id, key);
  const label = String(rule.label || key);
  const tip = String(rule.description || "");
  const type = String(rule.type || "string");
  let input;
  if (type === "boolean") {
    input = switchRow(fieldId, label, value !== false, tip);
  } else if (type === "enum") {
    const values = Array.isArray(rule.values) ? rule.values.map(String) : [];
    const options = (Array.isArray(rule.options) ? rule.options : values.map((item) => ({ value: item, label: item })))
      .map((item) => ({ value: String(item.value), label: String(item.label || item.value) }));
    input = selectField(label, fieldId, value, options, tip);
  } else if (type === "number" || type === "integer") {
    input = field(label, fieldId, value, { type: "number", min: rule.min, max: rule.max, tip: tip });
  } else {
    input = field(label, fieldId, value, { tip: tip, rows: tip.length > 80 ? 3 : undefined });
  }
  return '<div data-ext-setting="' + esc(key) + '" data-ext-type="' + esc(type) + '">' + input + "</div>";
}

function extCollectSettings(root) {
  const out = {};
  if (!root) return out;
  $$("[data-ext-setting]", root).forEach((wrap) => {
    const key = String(wrap.dataset.extSetting || "");
    const type = String(wrap.dataset.extType || "");
    const input = wrap.querySelector("input,select,textarea");
    if (!key || !input) return;
    if (type === "boolean") out[key] = Boolean(input.checked);
    else if (type === "number" || type === "integer") out[key] = Number(input.value) || 0;
    else out[key] = String(input.value ?? "");
  });
  return out;
}

function extCard(kind, item) {
  const cardKey = String(kind) + "/" + String(item.id);
  const status = !item.enabled
    ? pill("已停用", "muted")
    : item.loaded && item.available && item.available.ok
      ? pill("运行中", "ok", "pulse")
      : pill("不可用", "danger");
  const tools = Array.isArray(item.tools) ? item.tools : [];
  const schema = item.configSchema && typeof item.configSchema === "object" ? item.configSchema : {};
  const settings = item.settings && typeof item.settings === "object" ? item.settings : {};
  const schemaKeys = Object.keys(schema);
  const settingsHtml = schemaKeys.length
    ? '<details class="mt-sm"><summary class="small" style="cursor:pointer">设置（' + schemaKeys.length + ' 项）</summary>' +
      '<div class="grid cols-2 mt-sm">' + schemaKeys.map((key) => extSettingField(kind, item.id, key, schema[key] || {}, settings[key])).join("") + "</div>" +
      '<div class="row mt-sm"><button class="btn sm" data-ext-save="' + esc(cardKey) + '">' + ICON("save", 14) + "保存设置</button></div></details>"
    : '<div class="tiny muted mt-sm">这个扩展没有可调设置。</div>';
  const problems = [];
  if (item.error) problems.push("加载失败：" + item.error);
  if (item.enabled && item.available && item.available.ok === false) problems.push("不可用：" + (item.available.reason || "原因未知"));
  const problemHtml = problems.length
    ? '<div class="notice warn mt-sm">' + ICON("alert", 16) + '<div><div class="nd">' + esc(problems.join("；")) + "</div></div></div>"
    : "";
  const caps = [].concat(item.capabilities || [], item.providers || [], (item.permissions || []).map((p) => "权限:" + p));
  return '<div data-ext-card="' + esc(cardKey) + '" style="padding:14px 0;border-bottom:1px solid rgba(148,163,199,.12)">' +
    '<div class="row" style="gap:10px;align-items:flex-start">' +
    '<div style="flex:1;min-width:0"><div class="row wrap" style="gap:8px"><strong>' + esc(item.name || item.id) + "</strong>" +
    (item.version ? pill("v" + item.version, "info") : "") + status +
    (item.author ? '<span class="tiny muted">by ' + esc(item.author) + "</span>" : "") + "</div>" +
    '<div class="small soft mt-sm">' + esc(item.description || "") + "</div>" +
    (caps.length ? '<div class="row wrap mt-sm">' + caps.map((cap) => pill(String(cap), "info")).join(" ") + "</div>" : "") +
    (tools.length ? '<div class="row wrap mt-sm">' + tools.map((tool) => '<span class="pill" title="' + esc(tool.description || "") + '">' + ICON("terminal", 12) + esc(tool.name || tool.id) + "</span>").join(" ") + "</div>" : "") +
    problemHtml + settingsHtml + "</div>" +
    '<label class="switch" style="margin-top:2px"><input type="checkbox" data-ext-toggle="' + esc(cardKey) + '"' + (item.enabled ? " checked" : "") + "><span class=\"track\"></span></label>" +
    "</div></div>";
}

async function pageExtensions() {
  const data = await api("/api/extensions");
  S.extensions = data;
  const cfg = S.config || (S.config = (await api("/api/config")).config);
  const chatCfg = (cfg && cfg.chat) || {};
  const list = Array.isArray(data.extensions) ? data.extensions : [];
  const counts = data.counts || {};
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const head = card({
    title: "扩展总览",
    icon: "layers",
    hint: "插件（确定性规则 / 钩子 / 能力）与技能（给模型的工具 + 提示词片段）都放在项目 extensions/ 目录里，启停与设置保存即时生效",
    body:
      '<div class="row wrap mb">' +
      pill("插件 " + num(counts.plugins), "info") + pill("技能 " + num(counts.skills), "info") +
      pill("已启用 " + num(counts.enabled), "ok") + (num(counts.failed) ? pill("加载失败 " + num(counts.failed), "danger") : "") +
      "</div>" +
      (errors.length
        ? '<div class="notice warn mb">' + ICON("alert", 18) + '<div><div class="nt">有 ' + errors.length + " 个扩展加载异常</div><div class=\"nd\">" +
          esc(errors.slice(0, 6).map((item) => String(item.id || item.kind || "?") + "：" + String(item.message || "")).join("；")) + "</div></div></div>"
        : "") +
      '<div class="grid cols-2 mb">' +
      switchRow("ext_toolsEnabled", "允许模型调用扩展工具（function calling）", chatCfg.toolsEnabled !== false, "关掉后扩展的提示词片段与钩子仍然生效，只是模型不能再自己动手") +
      field("一轮最多几轮工具调用", "ext_toolRounds", chatCfg.toolRounds ?? 6, { type: "number", min: 1, max: 12, tip: "防止模型来回刷工具烧钱" }) +
      "</div>" +
      '<div class="row"><button class="btn primary" id="extSaveMaster">' + ICON("save", 15) + "保存工具设置</button>" +
      '<span class="tiny muted">扩展目录：' + esc(data.root || "extensions/") + " · 数据目录：" + esc(data.dataDir || "") + "</span></div>",
  });
  const groupDefs = [
    { kind: "plugins", title: "插件（确定性规则）", icon: "plug", empty: "还没有插件包" },
    { kind: "skills", title: "技能（模型工具）", icon: "sparkle", empty: "还没有技能包" },
  ];
  const groups = groupDefs.map((def) => {
    const items = list.filter((item) => item.kind === def.kind);
    return card({
      title: def.title,
      icon: def.icon,
      body: items.length ? items.map((item) => extCard(def.kind, item)).join("") : emptyState(def.empty, "扩展包放在 extensions/" + def.kind + "/ 下，然后重启心语"),
    });
  });
  return head + groups.join("");
}

const RENDERERS = { overview: pageOverview, account: pageAccount, dialog: pageDialog, weather: pageWeather, interaction: pageInteraction, extensions: pageExtensions, studio: pageStudio, chat: pageChat, groups: pageGroups, memory: pageMemory, life: pageLife, schedule: pageSchedule, qzone: pageQzone, llm: pageLlm, system: pageSystem, logs: pageLogs };
const TITLES = { overview: "总览", account: "QQ 账号", dialog: "对话设置", weather: "天气与位置", interaction: "记忆与互动", extensions: "插件与技能", studio: "角色工作室", chat: "试聊与对话", groups: "群聊与审核", memory: "记忆", life: "数字生命", schedule: "主动与日程", qzone: "QQ 空间", llm: "模型与资费", system: "运行环境", logs: "日志" };

let renderRevision = 0;
async function render() {
  const revision = ++renderRevision;
  const page = S.page;
  const nav = $("#content");
  $("#pageTitle").textContent = TITLES[S.page] || "心语";
  nav.innerHTML = '<div class="grid" style="gap:16px"><div class="skeleton" style="width:180px"></div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:200px"></div></div>';
  try {
    const html = await RENDERERS[page]();
    if (revision !== renderRevision || page !== S.page) return;
    nav.innerHTML = html;
    wire();
  } catch (error) {
    if (revision !== renderRevision || page !== S.page) return;
    nav.innerHTML = '<div class="notice danger">' + ICON("alert", 18) + '<div><div class="nt">这个页面出错了</div><div class="nd">' + esc(error && error.message || error) + "</div></div></div>";
  }
}

function wire() {
  wireExtensions();
   $$("[data-quota]").forEach((el) => el.addEventListener("click", () => { S.nextGroup = String(S.groupSel); S.nextPeer = el.dataset.quota; go("interaction"); }));
  bind("btnRefresh", "click", async () => { S.status = null; S.life = null; S.memory = null; render(); });

  /* ------------------------------ 插件与技能 ------------------------------ */

  bind("extSaveMaster", "click", async () => {
    const rounds = Math.max(1, Math.min(12, Number(val("ext_toolRounds")) || 6));
    await api("/api/config", { chat: { toolsEnabled: checked("ext_toolsEnabled"), toolRounds: rounds } });
    S.config = null;
    toast("工具设置已保存", "ok");
    render();
  });

  $$("[data-ext-toggle]").forEach((el) => {
    el.addEventListener("change", async () => {
      const parts = String(el.dataset.extToggle || "").split("/");
      el.disabled = true;
      const res = await api("/api/extensions/toggle", { kind: parts[0], id: parts[1], enabled: el.checked });
      el.disabled = false;
      if (res && res.ok) {
        S.extensions = res;
        toast((el.checked ? "已启用 " : "已停用 ") + (parts[1] || ""), "ok");
        render();
      } else {
        el.checked = !el.checked;
        toast((res && (res.message || res.error)) || "操作失败", "error");
      }
    });
  });

  $$("[data-ext-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const parts = String(btn.dataset.extSave || "").split("/");
      const cardEl = btn.closest("[data-ext-card]");
      const settings = extCollectSettings(cardEl);
      btn.disabled = true;
      const res = await api("/api/extensions/settings", { kind: parts[0], id: parts[1], settings: settings });
      btn.disabled = false;
      if (res && res.ok) {
        S.extensions = res;
        toast("设置已保存", "ok");
        render();
      } else {
        toast((res && (res.message || res.error)) || "保存失败", "error");
      }
    });
  });

  // 「去处理」跳转
  $$("[data-goto]").forEach((el) => el.addEventListener("click", () => go(el.dataset.goto)));

  // 修复协议端：先自动判断，能起就起，起完自动重连 QQ
  bind("btnFixProtocol", "click", async () => {
    const out = $("#fixOut");
    const btn = $("#btnFixProtocol");
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nt">正在处理…</div><div class="nd">心语会先诊断，需要的话在后台把协议端拉起来（最多等 25 秒）</div></div></div>';
    const res = await api("/api/protocol/ensure", {});
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "warn") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.ok ? "协议端已就绪" : "还没成功") + '</div><div class="nd pre-wrap">' + esc(res.message || "") + "</div></div></div>";
    }
    if (res.ok) {
      await api("/api/onebot/reconnect", {});
      toast("协议端已启动，正在重新连接 QQ…", "ok");
      await sleep(4000);
      S.status = null;
      render();
      return;
    }
    if (btn) btn.disabled = false;
    S.status = null;
  });

  bind("btnReconnectQq", "click", async () => {
    const res = await api("/api/onebot/reconnect", {});
    toast("已请求重连，几秒后自动刷新", "info");
    await sleep(4000);
    S.status = null;
    render();
  });

  bind("btnProtocolLog", "click", async () => {
    const res = await api("/api/protocol/log?lines=40");
    showModal(
      "协议端日志（最后 40 行）",
      res.tail
        ? '<div class="pre-wrap mono tiny" style="max-height:420px;overflow:auto;background:rgba(6,9,16,.72);padding:12px;border-radius:12px">' + esc(res.tail) + "</div>"
        : '<div class="muted small">还没有日志。协议端可能一次都没启动过。</div>' + '<div class="small muted mt">日志文件：' + esc(res.file || "") + "</div>",
    );
  });
  bind("btnPause", "click", async () => {
    const paused = S.status && S.status.paused && S.status.paused.paused;
    await api("/api/policy/pause", { paused: !paused, reason: "面板操作" });
    S.status = null; render();
  });
  bind("btnSandboxJump", "click", () => go("chat"));
  bind("btnRerunWizard", "click", async () => {
    await api("/api/onboarding/reset", {});
    S.wizardStep = 0;
    S.onboarding = null;
    await maybeOnboarding();
  });
  bind("btnJumpAccount", "click", () => go("account"));
  bind("btnJumpAccount2", "click", () => go("account"));
  bind("btnJumpTray", "click", () => go("system"));

  /* ------------------------------ QQ 账号 ------------------------------ */

  bind("btnSaveAccount", "click", async () => {
    const res = await api("/api/account", {
      selfId: val("acc_self"),
      masterId: val("acc_master"),
      masterName: val("acc_mastername"),
    });
    const out = $("#accountOut");
    if (!res.ok) {
      toast(res.message || "保存失败", "error");
      if (out) out.innerHTML = '<div class="notice danger">' + ICON("alert", 18) + '<div><div class="nd">' + esc(res.message || "保存失败") + "</div></div></div>";
      return;
    }
    if (out) {
      const steps = res.restartNeeded
        ? "<div class=\"tiny muted mt-sm\">下一步：在 QQ 里登录新号 → 「运行环境」点「重启协议端」→ 回来点「用协议端当前登录的号」复核。</div>"
        : "";
      out.innerHTML = '<div class="notice ' + (res.changed ? "ok" : "info") + '">' + ICON(res.changed ? "check" : "info", 18) +
        '<div><div class="nt">' + esc(res.message || "已保存") + "</div>" +
        (res.notes && res.notes.length ? '<div class="nd">' + res.notes.map((n) => esc(n)).join("<br>") + "</div>" : "") +
        (res.protocol && res.protocol.created ? '<div class="nd mono tiny">已生成协议端账号配置：' + esc(res.protocol.file) + "</div>" : "") +
        steps + "</div></div>";
    }
    toast(res.message || "已保存", res.changed ? "ok" : "info");
    S.status = null;
    if (res.changed) render();
  });

  bind("btnAdoptAccount", "click", async () => {
    const btn = $("#btnAdoptAccount");
    if (btn) btn.disabled = true;
    const res = await api("/api/account/adopt", {});
    if (btn) btn.disabled = false;
    if (!res.ok) {
      toast(res.message || "没能读到当前登录的号", "error");
      return;
    }
    toast(res.message, "ok");
    S.status = null;
    render();
  });

  /* ------------------------------ 多实例 ------------------------------ */

  bind("btnShowNewInstance", "click", () => {
    const box = $("#newInstanceBox");
    if (box) box.classList.toggle("hidden");
  });

  bind("btnCreateInstance", "click", async () => {
    const out = $("#niOut");
    const btn = $("#btnCreateInstance");
    const name = val("ni_name");
    const accountId = val("ni_account");
    if (!accountId) { toast("先填新实例的机器人 QQ 号", "warn"); return; }
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nt">正在创建…</div><div class="nd">正在准备实例目录、端口和协议端账号配置</div></div></div>';
    const res = await api("/api/instances", {
      name, accountId,
      masterId: val("ni_master"),
      characterId: val("ni_character"),
    });
    if (btn) btn.disabled = false;
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "danger") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.ok ? "实例已创建" : "没能创建") + '</div>' +
        '<div class="nd pre-wrap">' + esc(res.message || res.reason || "") + "</div>" +
        (res.ok ? '<div class="nd mono tiny mt-sm">面板端口 ' + res.panelPort + " · OneBot " + res.wsPort + " · 协议端 WebUI " + res.webuiPort + (res.protocolShared ? "（与主实例共用）" : "") + "</div>" : "") +
        (res.ok && !res.protocolOk ? '<div class="nd mt-sm">协议端尚未就绪：' + esc(res.protocolReason || "请在新实例里设置协议端目录") + "。创建实例不等于 QQ 已登录。</div>" : "") +
        "</div></div>";
    }
    toast(res.ok ? "实例已创建，点「启动」就能开始扫码登录" : (res.message || "创建失败"), res.ok ? "ok" : "error");
    if (res.ok) { S.account = null; render(); }
  });

  $$("[data-inst-start]").forEach((el) => el.addEventListener("click", async () => {
    el.disabled = true;
    const res = await api("/api/instances/start", { dir: el.dataset.instStart });
    toast(res.ok ? "已启动，等它连上 QQ 后这里会显示在线" : (res.message || "启动失败"), res.ok ? "ok" : "error");
    await sleep(2500);
    render();
  }));

  $$("[data-inst-open]").forEach((el) => el.addEventListener("click", async () => {
    const res = await api("/api/instances/open", { dir: el.dataset.instOpen });
    if (!res.ok) toast(res.message || "打不开", "error");
  }));

  $$("[data-inst-forget]").forEach((el) => el.addEventListener("click", async () => {
    const res = await api("/api/instances/delete", { id: el.dataset.instForget, deleteFiles: false });
    toast(res.ok ? "已从列表移除（文件还在）" : (res.message || "失败"), res.ok ? "ok" : "warn");
    if (res.ok) render();
  }));

  bind("btnTestAccount", "click", async () => {
    const res = await api("/api/onebot/ping", {});
    toast(res.ok ? "连接正常：" + ((res.info && res.info.nickname) || "") + "（" + ((res.info && res.info.user_id) || "") + "）" : "没连上：" + (res.error || ""), res.ok ? "ok" : "error");
  });

  /* ------------------------------ 启动与托盘 ------------------------------ */

  bind("acc_autostart", "change", async (e) => {
    const want = e.target.checked;
    const res = await api("/api/system/autostart", { enabled: want });
    if (!res.ok) {
      e.target.checked = !want;
      toast(res.message || "设置失败", "error");
      return;
    }
    toast(res.message, "ok");
    S.system = null;
  });

  bind("acc_openpanel", "change", async (e) => {
    await api("/api/system/settings", { settings: { openPanelOnStart: e.target.checked } });
    toast(e.target.checked ? "下次启动会打开面板窗口" : "下次启动只留托盘图标", "ok");
  });

  bind("btnOpenPanel", "click", async () => {
    const res = await api("/api/system/open-panel", {});
    toast(res.ok ? "已打开一个新的面板窗口" : "没能打开窗口，请手动访问控制面板地址", res.ok ? "ok" : "error");
  });

  bind("btnQuit", "click", async () => {
    if (!confirm("完全退出心语？（后台的 QQ 机器人也会停）")) return;
    await api("/api/system/quit", {});
    toast("已退出。要再启动就双击心语图标", "info");
  });

  /* ------------------------------ 对话设置 ------------------------------ */

  const dialogValues = () => ({
    maxReplyChars: Number(val("dlg_chars")) || 120,
    maxBubbles: Number(val("dlg_bubbles")) || 3,
    activity: Number(val("dlg_activity")),
    followUp: {
      enabled: checked("dlg_follow"),
      chance: Math.max(0, Math.min(100, Number(val("dlg_chance")) || 0)) / 100,
      delaySec: Number(val("dlg_delay")) || 9,
      maxPerTurn: 1,
    },
  });

  const refreshDialogPreview = () => {
    const num = $("#dlgActNum");
    const label = $("#dlgActLabel");
    const effect = $("#dlgActEffect");
    const preview = $("#dlgPreview");
    if (!num) return;
    const v = dialogValues();
    const maxBubbles = Math.max(1, Math.min(8, v.maxBubbles));
    const activity = Math.max(0, Math.min(100, v.activity || 0));
    const wantBubbles = Math.max(1, Math.min(maxBubbles, 1 + Math.round((maxBubbles - 1) * activity / 100)));
    const chance = v.followUp.enabled ? Math.min(0.95, v.followUp.chance * (activity / 100)) : 0;
    num.textContent = String(activity);
    if (label) label.textContent = activity <= 25 ? "很安静：一句就完" : activity <= 60 ? "正常：1~2 条" : activity <= 85 ? "活泼：常常分几条" : "黏人：几乎每条都追话";
    if (effect) {
      effect.textContent = "现在她最多想要 " + wantBubbles + " 条（硬上限 " + maxBubbles + " 条），单条不超过 " + v.maxReplyChars + " 字；" +
        (chance > 0 ? "回完有 " + Math.round(chance * 100) + "% 的概率在 " + v.followUp.delaySec + " 秒后再补一句。" : "回完不会主动再补话。");
    }
    if (preview) {
      preview.textContent = activity <= 25
        ? "一次只回一句，" + v.maxReplyChars + " 字以内，别啰嗦，别追问太多。"
        : activity <= 60
          ? "一次回 1~" + wantBubbles + " 句，总共不超过 " + v.maxReplyChars + " 字；想说的多就分成几行。"
          : "这次可以回 " + wantBubbles + " 条短消息（最多 " + maxBubbles + " 条），每条都是一两句口语，像真人一边想一边打字；如果没什么可说的，一条也完全可以。";
    }
  };

  bind("dlg_activity", "input", refreshDialogPreview);
  ["dlg_chars", "dlg_bubbles", "dlg_chance", "dlg_delay", "dlg_follow"].forEach((id) => bind(id, "change", refreshDialogPreview));
  $$("[data-activity]").forEach((el) => el.addEventListener("click", () => {
    $$("[data-activity]").forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
    const slider = $("#dlg_activity");
    if (slider) slider.value = el.dataset.activity;
    refreshDialogPreview();
  }));
  refreshDialogPreview();

  bind("btnSaveDialog", "click", async () => {
    const v = dialogValues();
    const res = await api("/api/style", v);
    if (!res.ok) { toast(res.message || "保存失败", "error"); return; }
    const out = $("#dlgOut");
    if (out) out.innerHTML = '<div class="notice ok">' + ICON("check", 18) + '<div><div class="nt">已保存</div><div class="nd">' + esc(res.message || "") + "</div></div></div>";
    toast("对话设置已保存", "ok");
    S.style = res.style;
  });

  bind("btnSaveMisc", "click", async () => {
    const res = await api("/api/style", {
      splitBubbles: checked("dlg_split"),
      antiStall: checked("dlg_antistall"),
      useEmoji: checked("dlg_emoji"),
      firstDelayMs: Number(val("dlg_first")),
      privateMergeWindowSec: Math.max(1, Math.min(15, Number(val("dlg_merge")) || 3)),
      privateMaxWaitSec: Math.max(1, Math.min(15, Number(val("dlg_deadline")) || 15)),
      waitForTyping: checked("dlg_typing_status"),
      typingDelayMs: Number(val("dlg_typing")),
    });
    toast(res.ok ? "已保存" : (res.message || "保存失败"), res.ok ? "ok" : "error");
  });

  bind("btnSaveFiles", "click", async () => {
    const res = await api("/api/style", {
      files: {
        enabled: checked("dlg_files"),
        maxBytes: Math.round(Number(val("dlg_file_kb")) || 2048) * 1024,
        maxChars: Number(val("dlg_file_chars")) || 12000,
        keepTurns: Number(val("dlg_file_turns")) || 0,
      },
    });
    toast(res.ok ? "文件设置已保存" : (res.message || "保存失败"), res.ok ? "ok" : "error");
  });

  /* 对话设置里直接换聊天模型 */
  bind("btnDlgSetModel", "click", async () => {
    const model = val("dlg_model");
    if (!model) { toast("先选一个模型", "warn"); return; }
    const res = await api("/api/llm/model", { model });
    toast(res.message || "已切换", res.ok ? "ok" : "error");
    if (res.ok) { S.status = null; render(); }
  });
  bind("btnDlgFetchModels", "click", async () => {
    toast("正在向服务商要模型列表…", "info");
    const res = await api("/api/llm/models", {});
    if (!res.ok) { toast(res.message || "拉取失败", "error"); return; }
    toast("可用模型：" + (res.ids || []).join("、"), "ok");
    render();
  });

  /* ------------------------------ 天气与位置 ------------------------------ */

  bind("btnWxRefresh", "click", async () => {
    toast("正在获取天气…", "info");
    const res = await api("/api/weather/refresh", {});
    S.weatherLive = null;
    toast(res.ok ? "天气已更新" : (res.error || "没取到天气"), res.ok ? "ok" : "error");
    render();
  });

  bind("btnWxSave", "click", async () => {
    const city = val("wx_city").trim();
    await api("/api/weather/settings", { city, proactive: { ...(S.weatherLive && S.weatherLive.proactive ? S.weatherLive.proactive : {}), at: val("wx_at") || "07:30" } });
    const res = await api("/api/weather/refresh", { city });
    S.weatherLive = null;
    toast(res.ok ? "已保存，天气也刷新了" : ("已保存，但没取到天气：" + (res.error || "")), res.ok ? "ok" : "warn");
    render();
  });

  bind("btnWxSavePro", "click", async () => {
    const kinds = ["rain", "snow", "thunder", "temp_drop", "heat", "cold", "wind", "uv"].filter((id) => checked("wkind_" + id));
    const base = (S.weatherLive && S.weatherLive.proactive) || {};
    const res = await api("/api/weather/settings", {
      proactive: { ...base, enabled: checked("wx_enabled"), onlyOnAlert: checked("wx_onlyalert"), minLevel: val("wx_minlevel") || "warn", kinds, at: val("wx_at") || base.at || "07:30" },
    });
    toast(res.ok ? "提醒设置已保存" : "保存失败", res.ok ? "ok" : "error");
    S.weatherLive = null;
    render();
  });

  bind("btnWxMute", "click", async () => {
    const res = await api("/api/weather/mute", { hours: 12 });
    toast(res.message || "好，今天不说了", "ok");
    S.weatherLive = null;
    S.status = null;
    render();
  });

  bind("btnWxRestore", "click", async () => {
    const res = await api("/api/weather/mute", { restore: true });
    toast(res.message || "已恢复", "ok");
    S.weatherLive = null;
    S.status = null;
    render();
  });

  bind("btnWxTest", "click", async () => {
    const out = $("#wxOut");
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nd">正在让她按今天的真实天气写一句并发送…</div></div></div>';
    const res = await api("/api/weather/greet", {});
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "warn") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.ok ? "已发出" : "没有发出去") + '</div><div class="nd">' + esc(res.message || "") + "</div></div></div>";
    }
    toast(res.ok ? "已发出，去 QQ 里看看" : (res.message || "没发出去"), res.ok ? "ok" : "error");
  });

  // 角色工作室
  $$("[data-char]").forEach((el) => el.addEventListener("click", async () => {
    await loadCharacters(el.dataset.char);
    render();
  }));
  bind("btnActivateChar", "click", async () => {
    const res = await api("/api/characters/" + encodeURIComponent(S.editingCharacter.id) + "/activate", {}, "POST");
    if (!res.ok) { toast(res.message || "启用失败", "error"); return; }
    await loadCharacters();
    S.status = null;
    toast("本账号已切换到「" + S.activeCharacter.name + "」", "ok");
    render();
  });
  const saveCharacterCard = async () => {
    const id = S.editingCharacter.id;
    const patch = {
      name: val("ch_name"),
      title: val("ch_title"),
      greeting: val("ch_greeting"),
      locked: ["name", "worldview", "persona", "personality", "speechStyle", "boundaries"].filter((k) => checked("lk_" + k)),
    };
    CHAR_KEYS.forEach((k) => { patch[k] = val("ch_" + k); });
    const user = {};
    USER_LABELS.forEach(([key]) => { user[key] = val("ch_user_" + key); });
    patch.user = user;
    patch.userOwnerId = val("ch_userOwnerId");
    patch.userAccountId = val("ch_userAccountId");
    const res = await api("/api/characters/" + encodeURIComponent(id), patch, "PUT");
    if (!res.ok) { toast(res.message || "保存失败", "error"); return null; }
    S.editingCharacter = res.character;
    S.characterLoadRevision = (S.characterLoadRevision || 0) + 1;
    const index = S.characters.findIndex((item) => item.id === id);
    if (index >= 0) S.characters[index] = { ...S.characters[index], ...res.character };
    else S.characters.push(res.character);
    if (S.activeCharacter && S.activeCharacter.id === id) S.activeCharacter = res.character;
    toast("角色卡已保存" + (S.activeCharacter && S.activeCharacter.id === id ? "，立刻生效" : "，未切换本账号角色"), "ok");
    render();
    return res.character;
  };
  bind("btnSaveChar", "click", saveCharacterCard);
  bind("btnSaveChar2", "click", saveCharacterCard);
  bind("btnSyncUserCity", "click", async () => {
    const city = val("ch_user_city").trim();
    if (!city) { toast("先在「所在城市」里填个城市", "warn"); return; }
    await saveCharacterCard();
    const res = await api("/api/weather/refresh", { city });
    S.weatherLive = null;
    toast(res.ok ? "天气城市已同步为「" + city + "」" : "同步了城市，但这次没取到天气：" + (res.error || ""), res.ok ? "ok" : "warn");
  });
  bind("btnReloadChar", "click", async () => { await loadCharacters(); render(); });
  bind("btnNewChar", "click", async () => {
    const name = prompt("新角色叫什么名字？", "新角色");
    if (!name) return;
    const res = await api("/api/characters/new", { name, activate: false });
    if (!res.ok) { toast(res.message || "创建失败", "error"); return; }
    S.characterLoadRevision = (S.characterLoadRevision || 0) + 1;
    const existing = S.characters.findIndex((item) => item.id === res.character.id);
    if (existing < 0) S.characters.push(res.character);
    else S.characters[existing] = res.character;
    S.editingCharacter = res.character;
    await loadCharacters(res.character.id); toast(S.activeCharacter && S.activeCharacter.id === res.character.id ? "首个角色已创建并启用" : "角色已创建，未切换本账号角色", "ok"); render();
  });
  bind("btnCloneChar", "click", async () => {
    const res = await api("/api/characters/clone", { source: S.editingCharacter.id });
    if (!res.ok) { toast(res.message || "复制失败", "error"); return; }
    await loadCharacters(res.character.id); toast("已复制：" + res.character.name, "ok"); render();
  });
  bind("btnPreviewPrompt", "click", () => previewPrompt());

  // 试聊
  bind("btnSandbox", "click", () => sandboxSend());
  const si = $("#sandboxInput");
  if (si) si.addEventListener("keydown", (e) => { if (e.key === "Enter") sandboxSend(); });
  bind("btnSandboxClear", "click", () => { $("#sandboxLog").innerHTML = '<div class="muted small">清空了，重新开始。</div>'; });
  bind("btnConvRefresh", "click", () => loadConversation(S.chatScope));
  bind("btnConvRecover", "click", async () => {
    const out = $("#recoverOut");
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nd">正在向协议端要最近的私聊记录…</div></div></div>';
    const peerId = String(S.chatScope || "").replace(/^private_/, "");
    const res = await api("/api/chat/recover", { peerId });
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "warn") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.message || "") + "</div>" +
        ((res.detail || []).length ? '<div class="nd small">' + res.detail.map((line) => esc(line)).join("<br>") + "</div>" : "") + "</div></div>";
    }
    toast(res.message || "补完了", res.added ? "ok" : "info");
    if (res.added) { S.convs = []; await loadConversation(S.chatScope); }
  });
  bind("chatScope", "change", (e) => { S.chatScope = e.target.value; loadConversation(S.chatScope); });
  bind("btnConvClear", "click", async () => {
    if (!confirm("确定要清空这段对话和它的记忆吗？这个操作不可撤销。")) return;
    await api("/api/conversation/clear", { key: S.chatScope, alsoMemory: true });
    toast("已清空", "ok"); S.convs = []; render();
  });
  if (S.page === "chat" && S.chatScope) loadConversation(S.chatScope);

  // 群聊
  bind("btnSyncGroups", "click", async () => {
    toast("正在读取群列表与成员…", "info");
    const res = await api("/api/groups/sync", {});
    S.groups = null; toast("同步完成：" + ((res.groups || []).map((g) => (g.error ? "群 " + g.groupId + " 失败" : "群 " + g.groupId + " " + g.members + " 人")).join("，") || "没有群"), "ok");
    render();
  });
  bind("groupSel", "change", (e) => { S.groupSel = e.target.value; const view = groupMemberView(S.groupSel); view.page = 1; view.q = ""; view.searchText = ""; render(); });
  const memberView = groupMemberView(S.groupSel);
  bind("groupMembers", "toggle", (e) => {
    const open = e.target.open;
    if (memberView.open === open) return;
    memberView.open = open; render();
  });
  bind("groupMemberQuery", "input", (e) => { memberView.searchText = e.target.value; });
  const searchMembers = () => { memberView.q = val("groupMemberQuery").trim(); memberView.searchText = memberView.q; memberView.page = 1; render(); };
  bind("btnSearchMembers", "click", searchMembers);
  bind("groupMemberQuery", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchMembers(); } });
  bind("btnMembersPrev", "click", () => { memberView.page = Math.max(1, memberView.page - 1); render(); });
  bind("btnMembersNext", "click", () => { memberView.page += 1; render(); });
  [["att", "attitude"], ["note", "note"], ["trigger", "trigger"]].forEach(([attr, key]) => {
    $$("[data-" + attr + "]").forEach((el) => el.addEventListener(key === "trigger" ? "change" : "input", () => {
      const id = String(el.dataset[attr]);
      memberView.drafts.set(id, { ...(memberView.drafts.get(id) || {}), [key]: el.value });
    }));
  });
  $$("[data-save]").forEach((el) => el.addEventListener("click", async () => {
    const peerId = el.dataset.save;
    const patch = {
      attitude: ($('[data-att="' + peerId + '"]') || {}).value || "",
      note: ($('[data-note="' + peerId + '"]') || {}).value || "",
      trigger: ($('[data-trigger="' + peerId + '"]') || {}).value || "at",
    };
    const submittedDraft = JSON.stringify(memberView.drafts.get(String(peerId)));
    const res = await api("/api/groups/member", { groupId: S.groupSel, peerId, patch });
    if (!res.ok) { toast(res.message || "保存失败，修改已保留", "error"); return; }
    if (JSON.stringify(memberView.drafts.get(String(peerId))) === submittedDraft) memberView.drafts.delete(String(peerId));
    toast("已保存这个人对她的设定", "ok");
    render();
  }));
  $$("[data-block]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/groups/action", { action: "block", groupId: S.groupSel, peerId: el.dataset.block, reason: "面板手动拉黑" });
    S.groups = null; toast("已拉黑，她不会再理这个人（也不会产生费用）", "ok"); render();
  }));
  $$("[data-unblock]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/groups/action", { action: "unblock", groupId: S.groupSel, peerId: el.dataset.unblock });
    S.groups = null; toast("已解除", "ok"); render();
  }));
  bind("btnSaveFilter", "click", async () => {
    await api("/api/config", { group: { filter: {
      action: val("fl_action"), maxWarnings: Number(val("fl_max")) || 0,
      words: val("fl_words").split("\n").map((s) => s.trim()).filter(Boolean),
      regex: val("fl_regex").split("\n").map((s) => s.trim()).filter(Boolean),
      warnSource: val("fl_src"), warnText: val("fl_text"),
    } } });
    S.config = null; S.groups = null; toast("审核设置已保存", "ok"); render();
  });
  bind("btnFilterTest", "click", async () => {
    const res = await api("/api/policy/test-filter", { text: val("filterTest") });
    $("#filterTestOut").innerHTML = res.hit ? '<div class="notice warn">' + ICON("alert", 18) + '<div class="nd">命中规则「' + esc(res.hit.word) + "」（" + esc(res.hit.ruleType) + "）</div></div>" : '<div class="notice ok">' + ICON("check", 18) + '<div class="nd">没有命中任何屏蔽词</div></div>';
  });
  bind("btnSaveRate", "click", async () => {
    await api("/api/config", { group: { rate: {
      enabled: checked("rate_enabled"), applyToPrivate: checked("rate_private"),
      perUserPerHour: Number(val("rate_uh")) || 0, perUserPerDay: Number(val("rate_ud")) || 0,
      perGroupPerHour: Number(val("rate_gh")) || 0, perGroupPerDay: Number(val("rate_gd")) || 0,
      globalPerDay: Number(val("rate_all")) || 0, minGapSeconds: Number(val("rate_gap")) || 0,
      maxConsecutive: Number(val("rate_cons")) || 0, silentMinutes: Number(val("rate_silent")) || 20,
    } } });
    S.config = null; S.groups = null; toast("频率设置已保存", "ok"); render();
  });
  bind("btnSimulate", "click", async () => {
    const key = val("simScope");
    const res = await api("/api/policy/simulate", { scopeKey: key, text: val("simText"), isMention: checked("simAt"), senderId: key.startsWith("private") ? (S.status && S.status.bots.masterId) : key.split("_")[2] });
    const kind = res.decision === "reply" ? "ok" : res.decision === "warn" ? "warn" : "info";
    $("#simOut").innerHTML = '<div class="notice ' + kind + '">' + ICON(res.decision === "reply" ? "check" : "alert", 18) + '<div><div class="nt">判定结果：' + esc({ reply: "会回复", warn: "会触发警告/拉黑", silent: "不会回复", skip: "跳过（已计过数）" }[res.decision] || res.decision) + '</div><div class="nd">' + esc(res.reason || "通过全部检查") + "</div></div></div>" +
      '<div class="table-wrap mt-sm"><table><thead><tr><th>检查步骤</th><th>结果</th><th>说明</th></tr></thead><tbody>' + (res.trace || []).map((s) => "<tr><td>" + esc(s.step) + "</td><td>" + (s.ok ? pill("通过", "ok") : pill("拦截", "danger")) + '</td><td class="small muted">' + esc(s.reason || "—") + "</td></tr>").join("") + "</tbody></table></div>";
  });

  // 记忆
  bind("btnRecall", "click", async () => {
    const res = await api("/api/memory/recall", { scopeKey: val("memScope"), query: val("memQuery"), subjectId: val("memScope").startsWith("private_") ? val("memScope").slice(8) : "" });
    const items = res.items || [];
    $("#recallOut").innerHTML = items.length
      ? '<div class="small muted mb">命中 ' + items.length + ' 条（只会检索这个会话范围内的记忆）</div>' + items.map((x) => '<div class="row" style="padding:6px 0;border-bottom:1px solid rgba(148,163,199,.1)"><span class="small" style="flex:1">' + esc(x.content) + '</span><span class="mono tiny muted">score ' + esc(x.score) + " · 相关 " + esc(x.breakdown.relevance) + " · 时效 " + esc(x.breakdown.recency) + "</span></div>").join("")
      : '<div class="notice info">' + ICON("search", 18) + '<div class="nd">这个会话里没有匹配的记忆。换个关键词，或者先聊几句让她记住点什么。</div></div>';
  });
  bind("btnAddMem", "click", async () => {
    const content = val("addContent");
    if (!content.trim()) { toast("先写点内容", "warn"); return; }
    await api("/api/memory/add", { scopeKey: val("addScope"), content, category: val("addCat") });
    S.memory = null; toast("记住了", "ok"); render();
  });
  $$("[data-mem-del]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("删除这条记忆？删除后她就再也检索不到它了。")) return;
    await api("/api/memory/delete", { id: Number(el.dataset.memDel) });
    S.memory = null; toast("已删除", "ok"); render();
  }));
  $$("[data-mem-pin]").forEach((el) => el.addEventListener("click", async () => {
    const id = Number(el.dataset.memPin);
    const item = (S.memory.items || []).find((x) => x.id === id);
    await api("/api/memory/update", { id, patch: { pinned: !item.pinned } });
    S.memory = null; render();
  }));

  // 数字生命：点一下只是「发起」，进度靠轮询画在卡片里，不再让按钮等几十秒
  bind("btnArchive", "click", () => startLifeJob("archive", "/api/life/archive", { limit: 3 }, "开始归档了，进度在下面"));
  bind("btnDiary", "click", () => startLifeJob("diary", "/api/life/diary", { force: true }, "开始写日记了，进度在下面"));
  bind("btnReflect", "click", () => startLifeJob("reflect", "/api/life/reflect", {}, "开始反思了，进度在下面"));
  // 进页面时如果还有任务在跑，接着盯着（比如用户中途刷新了页面）
  if (S.page === "life" && S.life && S.life.running && Object.keys(S.life.running).length) {
    startJobPolling();
  }
  /*
   * 经历时间线：点日期切换。
   * 用事件委托绑在外层容器上——里面的日期列表会被重画很多次，
   * 一个个绑监听会在每次重画后失效，或者叠出一堆重复的。
   */
  bind("lifeTimelineBody", "click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-tl-day]") : null;
    if (!btn) return;
    TL.day = btn.getAttribute("data-tl-day") || "";
    const box = $("#lifeTimelineBody");
    if (box) box.innerHTML = timelineBodyHtml();
  });
  // 搜索框在容器外面，所以输入时重画列表不会掉焦点
  bind("tlSearch", "input", () => {
    TL.q = val("tlSearch");
    const box = $("#lifeTimelineBody");
    if (box) box.innerHTML = timelineBodyHtml();
  });
  // 日记：点日期行展开 / 收起（同样用事件委托，列表重画多少次都不会丢监听）
  bind("lifeDiaryBody", "click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-diary-toggle]") : null;
    if (!btn) return;
    const key = String(btn.getAttribute("data-diary-toggle") || "");
    if (!key) return;
    DL.open[key] = btn.getAttribute("data-diary-open") !== "1";
    const box = $("#lifeDiaryBody");
    if (box) box.innerHTML = diaryBodyHtml();
  });
  bind("diarySearch", "input", () => {
    DL.q = val("diarySearch");
    const box = $("#lifeDiaryBody");
    if (box) box.innerHTML = diaryBodyHtml();
  });
  $$("[data-goal-done]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/life/goal", { action: "close", id: Number(el.dataset.goalDone) });
    S.life = null; render();
  }));

  // 日程
  bind("btnSaveGreet", "click", async () => {
    await api("/api/config", { greet: { proactive: {
      enabled: checked("greet_on"),
      quietHours: { enabled: checked("greet_quiet"), from: val("greet_qf"), to: val("greet_qt") },
      maxUnanswered: Number(val("greet_unans")) || 3,
      targets: [{ userId: Number((S.status && S.status.bots.masterId) || 0), minMinutes: Number(val("greet_min")) || 180, maxMinutes: Number(val("greet_max")) || 480, dailyMax: Number(val("greet_daily")) || 3 }],
    } } });
    S.config = null; S.schedule = null; toast("已保存", "ok"); render();
  });
  bind("btnGreetNow", "click", async () => {
    toast("正在让她发一条…", "info");
    const res = await api("/api/schedule/greet", { kind: "proactive" });
    S.schedule = null;
    toast(res.sent ? "已发出：" + res.sent.text : "没有发出去（看日志原因）", res.sent ? "ok" : "warn");
    render();
  });
  bind("btnSaveMeals", "click", async () => {
    const patch = {};
    ["morning", "noon", "night"].forEach((k) => { patch[k] = { enabled: checked("meal_" + k), at: val("meal_at_" + k), text: val("meal_text_" + k), windowMinutes: Math.max(1, Math.min(180, Number(val("meal_window_" + k)) || 30)) }; });
    await api("/api/config", { greet: patch });
    S.config = null; S.schedule = null; toast("问候设置已保存", "ok"); render();
  });
  bind("btnSaveHoliday", "click", async () => {
    await api("/api/config", { greet: { holidays: { enabled: checked("holiday_on"), builtin: true } } });
    S.config = null; S.schedule = null; toast("已保存", "ok"); render();
  });
  bind("btnAddBd", "click", async () => {
    const res = await api("/api/schedule/birthday", { name: val("bd_name"), monthDay: val("bd_md"), peerId: val("bd_qq") });
    if (!res.ok) { toast(res.message || "格式不对，生日要写成 MM-DD", "error"); return; }
    S.schedule = null; toast("生日已添加", "ok"); render();
  });
  $$("[data-bd-del]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/schedule/birthday", { action: "delete", id: Number(el.dataset.bdDel) });
    S.schedule = null; render();
  }));
  bind("btnAddRem", "click", async () => {
    const at = val("rem_at");
    if (!at) { toast("先选个时间", "warn"); return; }
    const res = await api("/api/schedule/reminder", { action: "add", at: at.replace("T", " "), text: val("rem_text"), repeatRule: val("rem_repeat"), targetId: (S.status && S.status.bots.masterId) || "" });
    if (!res.ok) { toast(res.message || "添加失败", "error"); return; }
    S.schedule = null; toast("提醒已添加", "ok"); render();
  });
  $$("[data-rem-del]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/schedule/reminder", { action: "delete", id: Number(el.dataset.remDel) });
    S.schedule = null; render();
  }));
  $$("[data-rem-toggle]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/schedule/reminder", { action: "update", id: Number(el.dataset.remToggle), patch: { enabled: el.dataset.en === "1" } });
    S.schedule = null; render();
  }));

  // 空间
  bind("btnQzCheck", "click", async () => {
    toast("正在自检（会一步步告诉你哪坏了）…", "info");
    const res = await api("/api/qzone/check", {});
    S.qzone = await api("/api/qzone");
    toast(res.report && res.report.conclusion || "自检完成", "info");
    render();
  });
  bind("btnQzMy", "click", async () => {
    const res = await api("/api/qzone/my-list", { num: 10 });
    if (!res.ok) { toast(res.message, "error", res.hint); return; }
    showModal("我自己的说说", (res.items || []).map((i) => '<div class="row" style="padding:8px 0;border-bottom:1px solid rgba(148,163,199,.1)"><span class="small" style="flex:1">' + esc(i.content || "（无文字）") + '</span><span class="tiny muted">' + t(num(i.created_time) * 1000) + "</span></div>").join("") || "没有读到说说");
  });
  bind("btnQzFeeds", "click", async () => {
    const res = await api("/api/qzone/feeds", {});
    if (!res.ok) { toast(res.message, "error", res.hint); return; }
    showModal("好友动态", (res.items || []).map((i) => '<div style="padding:8px 0;border-bottom:1px solid rgba(148,163,199,.1)"><div class="small">' + esc(i.nickname || i.uin) + '</div><div class="small muted pre-wrap">' + esc(String(i.text || "").slice(0, 200)) + "</div></div>").join("") || "没有读到动态");
  });
  bind("btnQzDraft", "click", async () => {
    toast("正在写…", "info");
    await api("/api/qzone/draft", { topic: val("qz_topic") });
    S.qzone = await api("/api/qzone");
    toast("草稿写好了，确认后再发布", "ok");
    render();
  });
  bind("btnQzPost", "click", async () => {
    if (!confirm("会真的发到 QQ 空间，确定吗？")) return;
    const res = await api("/api/qzone/post", { content: val("qz_content") });
    S.qzone = await api("/api/qzone");
    toast(res.ok ? (res.verified ? "已发出并确认可见" : "已发出，但还没能确认页面可见") : res.message, res.ok ? "ok" : "error", res.hint);
    render();
  });
  bind("btnQzDry", "click", async () => {
    const res = await api("/api/qzone/post", { content: val("qz_content"), dryRun: true });
    showModal("演练：将要发出的内容", '<div class="pre-wrap">' + esc(res.content || "（空）") + '</div><div class="small muted mt">这只是演练，没有真的发出去。</div>');
  });
  bind("btnQzReactDry", "click", async () => {
    const res = await api("/api/qzone/react", { dryRun: true });
    showModal("演练：会处理这些动态", (res.candidates || []).map((c) => '<div style="padding:8px 0;border-bottom:1px solid rgba(148,163,199,.1)"><div class="small">' + esc(c.nickname || c.uin) + " · " + esc(c.from) + '</div><div class="small muted pre-wrap">' + esc(c.text) + "</div></div>").join("") || "没有可处理的动态" + ((res.skipped || []).length ? '<div class="small muted mt">' + (res.skipped || []).map((s) => esc(s.reason)).join("<br>") + "</div>" : ""));
  });
  $$("[data-draft-approve]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("确定要发布这条说说吗？")) return;
    const res = await api("/api/qzone/approve", { id: el.dataset.draftApprove });
    S.qzone = await api("/api/qzone");
    toast(res.ok ? (res.verified ? "已发出并确认可见" : "已发出（待核验）") : res.message, res.ok ? "ok" : "error", res.hint);
    render();
  }));
  $$("[data-draft-reject]").forEach((el) => el.addEventListener("click", async () => {
    await api("/api/qzone/reject", { id: el.dataset.draftReject });
    S.qzone = await api("/api/qzone"); render();
  }));
  bind("btnSaveQzPost", "click", async () => {
    await api("/api/config", { qzone: { enabled: checked("qz_enabled"), autoPost: { enabled: checked("qz_autopost"), requireApproval: checked("qz_postapprove"), minIntervalMinutes: Number(val("qz_post_min")) || 180, maxIntervalMinutes: Number(val("qz_post_max")) || 420, hint: val("qz_topic") } } });
    S.config = null; S.qzone = null; toast("已保存", "ok"); render();
  });
  bind("btnSaveQzReact", "click", async () => {
    await api("/api/config", { qzone: { autoReact: { enabled: checked("qz_autoreact"), like: checked("qz_like"), comment: checked("qz_comment"), selfSpace: checked("qz_selfspace"), scanIntervalMinutes: Number(val("qz_scan")) || 10, commentChance: Number(val("qz_chance")) || 0 } } });
    S.config = null; S.qzone = null; toast("已保存", "ok"); render();
  });

  // 模型
  $$("[data-provider]").forEach((el) => el.addEventListener("click", () => {
    // 换服务商：把 Base URL 与模型下拉一起换过去（模型名各家不一样，别留着上一家的）
    const id = el.dataset.provider;
    const p = (S.llm.providers || []).find((x) => x.id === id);
    $$("[data-provider]").forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
    const base = $("#llm_base"), sel = $("#llm_provider");
    if (p && p.baseUrl) base.value = p.baseUrl;
    if (sel) sel.value = id;
    const modelSel = $("#llm_model");
    if (modelSel && modelSel.tagName === "SELECT" && p && p.models) {
      modelSel.innerHTML = p.models.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.id) + "</option>").join("") + '<option value="__manual__">手动填写别名字…</option>';
    }
    // 价格也跟着服务商走：换成贵的服务商却还按以前的价格估，预算等于没设
    const firstModel = (p && p.models && p.models[0]) || null;
    if (firstModel) {
      if ($("#llm_pin")) $("#llm_pin").value = firstModel.priceIn ?? 0;
      if ($("#llm_pout")) $("#llm_pout").value = firstModel.priceOut ?? 0;
      if ($("#llm_maxtok") && !Number(val("llm_maxtok"))) $("#llm_maxtok").value = 700;
    }
  }));
  bind("btnSaveLlm", "click", async () => {
    if (!S.config) S.config = (await api("/api/config")).config;
    const id = S.config.llm.activeProfile;
    const cur = S.config.llm.profiles[id] || {};
    const patch = { provider: val("llm_provider"), baseUrl: val("llm_base"), model: currentModelValue(), temperature: Number(val("llm_temp")), maxTokens: Number(val("llm_maxtok")), priceIn: Number(val("llm_pin")), priceOut: Number(val("llm_pout")) };
    const key = val("llm_key").trim();
    await api("/api/config", { llm: { profiles: { [id]: { ...cur, apiKey: "", ...patch, ...(key ? { apiKey: key } : {}) } } } });
    S.config = null; S.llm = null; toast("模型设置已保存", "ok"); render();
  });

  /* 思考型模型专用：一键把「单次回复上限」拉到面板允许的最大值 */
  bind("btnMaxTokens", "click", () => {
    const input = document.getElementById("llm_maxtok");
    if (!input) return;
    input.value = input.max || "65536";
    toast("已填成最大上限，点「保存模型设置」生效", "info");
  });

  /* 手动填写模式：下拉选了「手动填写」就把输入框露出来 */
  const manual = $("#llm_model_manual");
  bind("llm_model", "change", () => {
    if (!manual) return;
    if (val("llm_model") === "__manual__") { manual.classList.remove("hidden"); manual.focus(); }
    else manual.classList.add("hidden");
  });

  /* 拉取这家 API 真实可用的模型 */
  bind("btnFetchModels", "click", async () => {
    const btn = $("#btnFetchModels");
    if (btn) btn.disabled = true;
    toast("正在向服务商要模型列表…", "info");
    const key = val("llm_key").trim();
    const res = await api("/api/llm/models", { baseUrl: val("llm_base"), ...(key ? { apiKey: key } : {}) });
    if (btn) btn.disabled = false;
    if (!res.ok) { toast(res.message || "拉取失败", "error", "检查 Base URL 和 API Key"); return; }
    const ids = res.ids || [];
    const cur = currentModelValue();
    S.config = null; S.llm = null;
    if (ids.length && cur && !ids.includes(cur)) {
      // 当前模型不在可用列表里 —— 直接问要不要换
      const first = ids.find((x) => !/code|vision|audio|embed|tts|whisper/i.test(x)) || ids[0];
      if (confirm("你配置的「" + cur + "」不在可用列表里（可能已下线）。\\n\\n可用的有：" + ids.join("、") + "\\n\\n现在切换到「" + first + "」吗？")) {
        const switched = await api("/api/llm/model", { model: first });
        toast(switched.message || ("已切换到 " + first), "ok");
      }
    } else {
      toast("拿到 " + ids.length + " 个可用模型：" + ids.join("、"), "ok");
    }
    render();
  });
  bind("btnTestLlm", "click", async () => {
    const out = $("#btnTestLlm");
    out.disabled = true;
    const key = val("llm_key").trim();
    const res = await api("/api/llm/test", { patch: { provider: val("llm_provider"), baseUrl: val("llm_base"), model: currentModelValue(), ...(key ? { apiKey: key } : {}) } });
    out.disabled = false;
    toast(res.message, res.ok ? "ok" : "error");
    if (res.ok) { S.llm = null; render(); }
    else if (res.modelInvalid) {
      // 模型用不了：直接把可用列表摆出来，给个一键换的按钮
      const ids = res.availableModels || [];
      if (ids.length && confirm("这个模型你的 Key 用不了。\\n\\n可用模型：" + ids.join("、") + "\\n\\n自动换成一个能用的吗？")) {
        const first = ids.find((x) => !/code|vision|audio|embed|tts|whisper/i.test(x)) || ids[0];
        const switched = await api("/api/llm/model", { model: first });
        toast(switched.message || ("已切换到 " + first), "ok");
        S.llm = null; render();
      }
    }
  });
  bind("btnSaveRoutes", "click", async () => {
    const routes = {};
    $$("[data-route]").forEach((el) => { routes[el.dataset.route] = el.value; });
    await api("/api/config", { llm: { taskRoutes: routes } });
    S.config = null; S.llm = null; toast("任务路由已保存", "ok"); render();
  });
  bind("btnSaveBudget", "click", async () => {
    await api("/api/config", { budget: { enabled: true, globalDaily: Number(val("bud_global")) || 0, privateDaily: Number(val("bud_private")) || 0, groupDaily: Number(val("bud_group")) || 0 } });
    S.config = null; S.llm = null; toast("预算已保存", "ok"); render();
  });
  bind("btnResetBudget", "click", async () => {
    await api("/api/budget/reset", {});
    S.llm = null; toast("统计已重置", "ok"); render();
  });

  // 系统：协议端
  const protoAction = async (label) => {
    const out = $("#protoOut");
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nt">' + esc(label) + "…</div></div></div>";
    const res = await api("/api/protocol/ensure", {});
    S.protocolLive = null;
    S.system = null;
    S.status = null;
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "warn") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.ok ? "协议端已就绪" : "还没成功") + '</div><div class="nd pre-wrap">' + esc(res.message || "") + "</div></div></div>";
    }
    if (res.ok) {
      await api("/api/onebot/reconnect", {});
      toast("协议端已就绪，正在重连 QQ", "ok");
      await sleep(4000);
    } else {
      toast("没能自动修好，请看下面的说明", "warn");
    }
    render();
  };
  bind("btnProtoEnsure", "click", () => protoAction("正在检查并启动协议端"));
  bind("btnProtoRestart", "click", async () => {
    const out = $("#protoOut");
    const btn = $("#btnProtoRestart");
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = '<div class="notice info">' + ICON("refresh", 18) + '<div><div class="nt">正在重启协议端…</div><div class="nd">重启期间所有实例会短暂掉线几秒，OneBot 会自动重连</div></div></div>';
    const res = await api("/api/protocol/restart", {});
    if (btn) btn.disabled = false;
    S.protocolLive = null;
    S.system = null;
    S.status = null;
    if (out) {
      out.innerHTML = '<div class="notice ' + (res.ok ? "ok" : "warn") + '">' + ICON(res.ok ? "check" : "alert", 18) +
        '<div><div class="nt">' + esc(res.ok ? "协议端已重启" : "重启后还没就绪") + '</div><div class="nd pre-wrap">' + esc(res.message || "") + "</div></div></div>";
    }
    if (res.ok) {
      await api("/api/onebot/reconnect", {});
      await sleep(4000);
    }
    render();
  });
  bind("btnProtoRecheck", "click", async () => {
    S.protocolLive = null;
    S.system = null;
    toast("重新诊断中…", "info");
    render();
  });
  bind("btnProtoLog2", "click", async () => {
    const res = await api("/api/protocol/log?lines=40");
    showModal(
      "协议端日志（最后 40 行）",
      res.tail
        ? '<div class="pre-wrap mono tiny" style="max-height:420px;overflow:auto;background:rgba(6,9,16,.72);padding:12px;border-radius:12px">' + esc(res.tail) + "</div>"
        : '<div class="muted small">还没有日志。</div>' + '<div class="small muted mt">文件：' + esc(res.file || "") + "</div>",
    );
  });

  // 系统：连接与端口（QQ 号在「QQ 账号」页改，这里只管端口与令牌）
  bind("btnSaveBot", "click", async () => {
    const patch = { panelPort: Number(val("bot_panelport")) || undefined, onebotWsUrl: val("bot_ws"), onebotHttpUrl: val("bot_http") };
    const token = val("bot_token").trim();
    if (token) patch.accessToken = token;
    await api("/api/config", { bot: patch });
    S.config = null; S.status = null; S.system = null;
    toast("端口设置已保存（改完要重启）", "ok"); render();
  });
  bind("btnPing", "click", async () => {
    const res = await api("/api/onebot/ping", {});
    toast(res.ok ? "QQ 连接正常：" + (res.info && res.info.nickname) : "没连上：" + (res.error || ""), res.ok ? "ok" : "error");
  });
  bind("btnSyncProto", "click", async () => {
    const res = await api("/api/system/sync-protocol", {});
    toast(res.ok ? (res.changed ? "已把端口与令牌写进协议端配置，重启协议端后生效" : "协议端配置已经一致，不用改") : res.reason, res.ok ? "ok" : "error");
  });
  bind("btnSaveSettings", "click", async () => {
    const res = await api("/api/system/settings", { settings: { dataDir: val("set_data"), logDir: val("set_log"), snowlumaDir: val("set_snow"), autoStartProtocol: checked("set_autoProto") } });
    toast(res.message || "已保存", "ok");
  });
  bind("btnBackup", "click", async () => {
    const res = await api("/api/system/backup", {});
    S.system = null; toast(res.ok ? "备份完成：" + res.file : "备份失败：" + res.error, res.ok ? "ok" : "error");
  });
  bind("btnRestart", "click", async () => {
    if (!confirm("现在重启机器人？（几秒后刷新页面即可）")) return;
    await api("/api/system/restart", {});
    toast("正在重启，5 秒后刷新页面", "info");
  });
  bind("btnProbeCaps", "click", async () => {
    toast("正在探测协议端能力…", "info");
    await api("/api/onebot/capabilities", {});
    S.system = null; render();
  });

  // 日志
  bind("logLevel", "change", async (e) => {
    await api("/api/logs/level", { level: e.target.value });
    LOG_LEVEL_FLOOR = e.target.value;
    renderLogs(LOG_BUFFER);
    toast("日志级别已切到 " + e.target.value, "ok");
  });
  bind("btnClearLogs", "click", () => {
    LOG_BUFFER.length = 0;
    renderLogs(LOG_BUFFER);
  });

  /*
   * 进「日志」页时立刻把已有的日志画出来。
   * 只靠 SSE 推送的话，系统安静时页面会一直是空的——
   * 用户就会以为「日志功能坏了」。
   */
  if (S.page === "logs") renderLogs(LOG_BUFFER);
}

const CHAR_KEYS = ["worldview", "persona", "appearance", "personality", "speechStyle", "habits", "relations", "boundaries", "exampleDialogue", "extras"];

async function sandboxSend() {
  const input = $("#sandboxInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const log = $("#sandboxLog");
  log.insertAdjacentHTML("beforeend", '<div class="bubble in"><div class="avatar">你</div><div><div class="body">' + esc(text) + "</div></div></div>");
  log.insertAdjacentHTML("beforeend", '<div class="bubble out" id="sandboxPending"><div class="avatar">…</div><div><div class="body">正在想…</div></div></div>');
  log.scrollTop = log.scrollHeight;
  const res = await api("/api/chat/sandbox", { text });
  const pending = $("#sandboxPending");
  if (pending) pending.remove();
  const avatar = (S.activeCharacter && S.activeCharacter.name || "心").slice(0, 1);
  if (res.ok && res.bubbles && res.bubbles.length) {
    res.bubbles.forEach((b) => log.insertAdjacentHTML("beforeend", '<div class="bubble out"><div class="avatar">' + esc(avatar) + '</div><div><div class="body">' + esc(b) + '</div></div></div>'));
  } else {
    log.insertAdjacentHTML("beforeend", '<div class="notice danger">' + ICON("alert", 18) + '<div><div class="nt">没生成出来</div><div class="nd">' + esc(res.message || res.reason || "未知错误，看看日志页") + "</div></div></div>");
  }
  log.scrollTop = log.scrollHeight;
}

async function previewPrompt() {
  const res = await api("/api/prompt/preview", {}, "POST");
  if (!res.ok) { toast(res.message || "拼不出提示词", "error"); return; }
  const layers = res.layers || {};
  const chips = [
    layers.worldview ? pill("世界观", "ok") : pill("没有世界观", "warn"),
    layers.userFields ? pill("关于你 " + layers.userFields + " 项", "ok") : pill("没填关于你", "warn"),
    layers.weather ? pill("今天天气已注入", "ok") : pill("没有天气数据", "info"),
    layers.memory ? pill("带记忆", "ok") : pill("这次没检索到记忆", "info"),
  ].join(" ");
  showModal(
    "她这次真正收到的提示词",
    '<div class="row mb">' + chips + "</div>" +
      '<div class="tiny muted mb-sm">长度与条数指令：' + esc(res.style ? res.style.instruction : "") + "</div>" +
      '<div class="pre-wrap mono tiny" style="max-height:520px;overflow:auto;background:rgba(6,9,16,.72);padding:14px;border-radius:12px">' + esc(res.prompt) + "</div>",
  );
}
function showModal(title, bodyHtml) {
  const holder = $("#modal");
  holder.innerHTML = '<div class="modal-back"><div class="modal"><h3>' + esc(title) + '</h3><div class="modal-sub">' + bodyHtml + '</div><div class="modal-actions"><button class="btn primary" id="modalClose">知道了</button></div></div></div>';
  holder.classList.remove("hidden");
  bind("modalClose", "click", () => { holder.classList.add("hidden"); holder.innerHTML = ""; });
}

/* --------------------------------- 启动 --------------------------------- */

async function boot() {
  const authorization = await api("/api/panel/session", {});
  if (!authorization.ok) throw new Error(authorization.message || "请从托盘重新打开面板");
  renderNav();
  const hash = (location.hash || "").replace("#", "");
  if (RENDERERS[hash]) S.page = hash;
  renderNav();
  await render();

  try { S.config = (await api("/api/config")).config; } catch (e) { /* 后面各页面会各自兜底 */ }
  await loadCharacters().catch(() => {});
  await maybeOnboarding().catch(() => {});

  // 实时日志
  try {
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (ev) => {
      let entry;
      try { entry = JSON.parse(ev.data); } catch { return; }
      pushLogs([entry]);
      if (S.page === "logs") renderLogs(LOG_BUFFER);
    };
    es.onerror = () => { /* 断线浏览器会自己重连 */ };
  } catch (e) { /* ignore */ }

  // 顶部状态条定时刷新
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const st = await api("/api/status");
      S.status = st;
      const ruleVersion = JSON.stringify(st.ruleUpdates || []);
      if (st.ruleUpdates && st.ruleUpdates.length && S.rulesNoticeVersion !== ruleVersion) {
        S.rulesNoticeVersion = ruleVersion;
        toast("群 " + st.ruleUpdates.map((item) => item.groupId).join("、") + " 的公告有更新，请到记忆与互动页确认是否更新群规。", "warn");
      }
      const ob = st.onebot || {};
      const box = $("#navStatus");
      if (box) box.innerHTML = (ob.online ? pill("在线", "ok", "pulse") : pill("离线", "danger", "pulse")) + " " + (st.paused && st.paused.paused ? pill("已暂停", "warn") : "");
    } catch (e) { /* ignore */ }
  }, 15000);
}

/** 前端出错时，把错误直接画到页面上——总比白屏强，也便于截图排查。 */
function reportError(where, error) {
  const text = (error && (error.stack || error.message)) || String(error);
  console.error("[" + where + "]", error);
  try {
    const box = document.getElementById("fatal");
    if (box) {
      box.classList.remove("hidden");
      box.innerHTML = '<div class="notice danger" style="margin:12px 24px">' + ICON("alert", 18) + '<div><div class="nt">前端出错了（' + where + '）</div><div class="nd mono tiny pre-wrap">' + esc(text) + "</div></div></div>";
    }
  } catch (e) { /* ignore */ }
}

window.addEventListener("error", (e) => reportError("window", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

window.addEventListener("hashchange", () => { const h = location.hash.replace("#", ""); if (RENDERERS[h] && h !== S.page) { S.page = h; renderNav(); render(); } });
document.addEventListener("DOMContentLoaded", () => { boot().catch((error) => reportError("boot", error)); });
`;

/** 把图标表与主色 JSON 注入前端。 */
export function appScript({ iconsJson }) {
  return `const ICONS = ${iconsJson};\n` + APP_JS;
}


