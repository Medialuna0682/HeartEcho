/**
 * 面板样式：简洁美观、图标圆润的设计系统。
 *
 * 设计基调（取自角色本身的气质）：
 *   夜空底色 + 月光蓝主色 + 一点朱红强调色；大圆角、柔和投影、克制的动效。
 *   图标全部是线性 SVG，统一 stroke-linecap:round，所以视觉上都是圆头的。
 */
export const CSS = `
:root {
  color-scheme: dark;

  /* 底色：深夜蓝 */
  --bg: #0b0e17;
  --bg-soft: #0f1320;
  --surface: rgba(24, 29, 46, 0.72);
  --surface-strong: rgba(30, 36, 56, 0.94);
  --surface-hover: rgba(255, 255, 255, 0.06);
  --border: rgba(148, 163, 199, 0.16);
  --border-strong: rgba(148, 163, 199, 0.3);

  /* 文字 */
  --text: #eaeefb;
  --text-soft: #b6bed6;
  --text-dim: #7d87a3;

  /* 主色：月光蓝紫 */
  --accent: #8b7cf8;
  --accent-soft: rgba(139, 124, 248, 0.16);
  --accent-strong: #a99cff;
  --accent-2: #f472b6;
  --accent-2-soft: rgba(244, 114, 182, 0.14);

  /* 语义色 */
  --ok: #4ade80;
  --ok-soft: rgba(74, 222, 128, 0.14);
  --warn: #fbbf24;
  --warn-soft: rgba(251, 191, 36, 0.14);
  --danger: #fb7185;
  --danger-soft: rgba(251, 113, 133, 0.14);
  --info: #60a5fa;
  --info-soft: rgba(96, 165, 250, 0.14);

  /* 圆角：整体偏圆润 */
  --r-xs: 8px;
  --r-sm: 12px;
  --r-md: 16px;
  --r-lg: 20px;
  --r-xl: 26px;
  --r-pill: 999px;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow: 0 8px 24px -12px rgba(6, 9, 20, 0.9);
  --shadow-lg: 0 24px 60px -28px rgba(6, 9, 20, 1);
  --glow: 0 0 0 1px var(--accent-soft), 0 12px 40px -20px var(--accent);

  --font: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Noto Sans SC", system-ui, -apple-system, sans-serif;
  --mono: "JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace;
}

* { box-sizing: border-box; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: rgba(148, 163, 199, 0.22); border-radius: var(--r-pill); border: 3px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 199, 0.36); background-clip: content-box; }
*::-webkit-scrollbar-track { background: transparent; }

html, body { height: 100%; }
body {
  margin: 0;
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  background:
    radial-gradient(1100px 620px at 12% -8%, rgba(139, 124, 248, 0.18), transparent 62%),
    radial-gradient(900px 520px at 108% 6%, rgba(244, 114, 182, 0.12), transparent 58%),
    radial-gradient(800px 700px at 50% 120%, rgba(96, 165, 250, 0.08), transparent 60%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}

/* 背景里那颗月亮 */
body::before {
  content: "";
  position: fixed;
  top: -120px; right: -80px;
  width: 420px; height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02) 46%, transparent 70%);
  filter: blur(2px);
  pointer-events: none;
  z-index: 0;
}

#app { position: relative; z-index: 1; display: flex; height: 100vh; }

/* ------------------------------- 侧边导航 ------------------------------- */

.sidebar {
  width: 232px;
  flex: 0 0 232px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 14px;
  background: linear-gradient(180deg, rgba(18, 22, 36, 0.9), rgba(12, 15, 25, 0.82));
  border-right: 1px solid var(--border);
  backdrop-filter: blur(18px);
  overflow-y: auto;
  transition: width .22s cubic-bezier(.4,0,.2,1), flex-basis .22s cubic-bezier(.4,0,.2,1);
}
.sidebar.collapsed { width: 76px; flex-basis: 76px; }
.sidebar.collapsed .brand-text,
.sidebar.collapsed .nav-label,
.sidebar.collapsed .nav-group-title,
.sidebar.collapsed .side-foot-text { display: none; }
.sidebar.collapsed .nav-item { justify-content: center; padding: 11px 0; }
.sidebar.collapsed .brand { justify-content: center; }

.brand { display: flex; align-items: center; gap: 12px; padding: 4px 8px 14px; }
.brand-logo {
  width: 40px; height: 40px; flex: 0 0 40px;
  border-radius: 14px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 10px 26px -12px var(--accent);
  color: #fff;
}
.brand-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: .3px; }
.brand-sub { font-size: 11px; color: var(--text-dim); letter-spacing: .4px; }

.nav-group-title {
  font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-dim); padding: 14px 10px 6px; font-weight: 600;
}
.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  color: var(--text-soft);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background .16s, color .16s, transform .16s;
  font-size: 13.5px;
  white-space: nowrap;
}
.nav-item svg { flex: 0 0 20px; }
.nav-item:hover { background: var(--surface-hover); color: var(--text); }
.nav-item.active {
  background: linear-gradient(90deg, var(--accent-soft), rgba(139, 124, 248, 0.04));
  color: #fff;
  border-color: rgba(139, 124, 248, 0.28);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
}
.nav-item .badge-dot { margin-left: auto; }
.side-foot { margin-top: auto; padding: 10px 6px 4px; display: flex; flex-direction: column; gap: 8px; }
.side-foot-text { font-size: 11px; color: var(--text-dim); padding: 0 4px; }

/* --------------------------------- 主区 --------------------------------- */

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  background: rgba(11, 14, 23, 0.66);
  backdrop-filter: blur(16px);
  position: sticky; top: 0; z-index: 20;
}
.topbar h1 { font-size: 17px; margin: 0; font-weight: 620; letter-spacing: .2px; }
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }

.content { flex: 1; overflow-y: auto; padding: 22px 24px 60px; }
.page { display: none; animation: fade .22s ease; }
.page.active { display: block; }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* --------------------------------- 组件 --------------------------------- */

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 18px 20px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
}
.card + .card { margin-top: 16px; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 14.5px; margin: 0; font-weight: 620; }
.card-head .hint { font-size: 12px; color: var(--text-dim); margin-left: auto; text-align: right; }
.card-icon {
  width: 32px; height: 32px; flex: 0 0 32px; border-radius: 11px;
  display: grid; place-items: center;
  background: var(--accent-soft); color: var(--accent-strong);
}

.grid { display: grid; gap: 16px; }
.grid.cols-2 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.grid.cols-4 { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.tight { gap: 6px; }
.spacer { flex: 1; }

/* 按钮：圆角药丸 */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 9px 16px;
  border-radius: var(--r-pill);
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 13px; font-family: inherit; font-weight: 520;
  cursor: pointer;
  transition: transform .14s, background .16s, border-color .16s, box-shadow .16s, opacity .16s;
  white-space: nowrap;
}
.btn:hover { background: rgba(255, 255, 255, 0.09); transform: translateY(-1px); }
.btn:active { transform: translateY(0) scale(.985); }
.btn[disabled] { opacity: .45; cursor: not-allowed; transform: none; }
.btn svg { flex: 0 0 17px; }
.btn.primary {
  background: linear-gradient(135deg, var(--accent), #9d7cf8);
  border-color: transparent; color: #fff;
  box-shadow: 0 12px 30px -16px var(--accent);
}
.btn.primary:hover { box-shadow: 0 16px 34px -14px var(--accent); }
.btn.pink { background: linear-gradient(135deg, var(--accent-2), #f0739f); border-color: transparent; color: #fff; box-shadow: 0 12px 30px -16px var(--accent-2); }
.btn.ghost { background: transparent; border-color: var(--border); color: var(--text-soft); }
.btn.ghost:hover { color: var(--text); }
.btn.danger { border-color: rgba(251, 113, 133, 0.4); color: #ffd7dd; background: var(--danger-soft); }
.btn.ok { border-color: rgba(74, 222, 128, 0.36); color: #d6ffe4; background: var(--ok-soft); }
.btn.sm { padding: 6px 12px; font-size: 12px; }
.btn.sm svg { flex: 0 0 15px; }
.btn.icon { padding: 9px; width: 38px; height: 38px; }
.btn.block { width: 100%; }

/* 状态胶囊 */
.pill {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 12px;
  border-radius: var(--r-pill);
  font-size: 12px; font-weight: 520;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-soft);
  white-space: nowrap;
}
.pill.ok { background: var(--ok-soft); border-color: rgba(74,222,128,.3); color: #c8f7d8; }
.pill.warn { background: var(--warn-soft); border-color: rgba(251,191,36,.3); color: #ffe8b0; }
.pill.danger { background: var(--danger-soft); border-color: rgba(251,113,133,.3); color: #ffd2da; }
.pill.info { background: var(--info-soft); border-color: rgba(96,165,250,.3); color: #cfe4ff; }
.pill.accent { background: var(--accent-soft); border-color: rgba(139,124,248,.32); color: #ded8ff; }
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px rgba(255,255,255,.05); }
.pill .dot.pulse { animation: pulse 2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

/* 表单 */
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.field > label { font-size: 12.5px; color: var(--text-soft); font-weight: 520; display: flex; align-items: center; gap: 6px; }
.field .tip { font-size: 11.5px; color: var(--text-dim); }
input[type=text], input[type=password], input[type=number], input[type=search], input[type=datetime-local], textarea, select {
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: rgba(9, 12, 20, 0.6);
  color: var(--text);
  font-family: inherit;
  font-size: 13.5px;
  transition: border-color .16s, box-shadow .16s, background .16s;
}
textarea { min-height: 88px; resize: vertical; line-height: 1.65; }
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: rgba(139, 124, 248, 0.6);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: rgba(9, 12, 20, 0.85);
}
input::placeholder, textarea::placeholder { color: #5b6479; }
select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--text-dim) 50%), linear-gradient(135deg, var(--text-dim) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 34px; }
input[type=range] { width: 100%; accent-color: var(--accent); }

/* 开关 */
.switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; font-size: 13px; color: var(--text-soft); user-select: none; }
.switch input { display: none; }
.switch .track {
  width: 44px; height: 25px; border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid var(--border);
  position: relative; transition: background .2s, border-color .2s;
  flex: 0 0 44px;
}
.switch .track::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 19px; height: 19px; border-radius: 50%;
  background: #fff; box-shadow: var(--shadow-sm);
  transition: transform .2s cubic-bezier(.4,0,.2,1);
}
.switch input:checked + .track { background: linear-gradient(135deg, var(--accent), #a68cf9); border-color: transparent; }
.switch input:checked + .track::after { transform: translateX(19px); }

/* 表格 */
.table-wrap { overflow-x: auto; border-radius: var(--r-md); border: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid rgba(148, 163, 199, 0.1); vertical-align: middle; }
th { font-size: 11.5px; letter-spacing: .5px; text-transform: uppercase; color: var(--text-dim); font-weight: 600; background: rgba(255,255,255,.02); position: sticky; top: 0; backdrop-filter: blur(8px); }
tbody tr:hover { background: rgba(255, 255, 255, 0.025); }
tbody tr:last-child td { border-bottom: none; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; }
.truncate { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 统计块 */
.stat { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: var(--r-md); background: rgba(255,255,255,.028); border: 1px solid var(--border); }
.stat .k { font-size: 11.5px; color: var(--text-dim); letter-spacing: .3px; }
.stat .v { font-size: 22px; font-weight: 650; letter-spacing: .3px; }
.stat .v small { font-size: 12px; color: var(--text-dim); font-weight: 400; margin-left: 4px; }

/* 进度条 */
.bar { height: 8px; border-radius: var(--r-pill); background: rgba(255,255,255,.07); overflow: hidden; }
.bar > i { display: block; height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .4s cubic-bezier(.4,0,.2,1); }
.bar.ok > i { background: linear-gradient(90deg, #34d399, #4ade80); }
.bar.warn > i { background: linear-gradient(90deg, #fbbf24, #fb923c); }
.bar.danger > i { background: linear-gradient(90deg, #fb7185, #ef4444); }

/* 聊天气泡 */
.chat { display: flex; flex-direction: column; gap: 12px; max-height: 460px; overflow-y: auto; padding: 6px 4px; }
.bubble { display: flex; gap: 10px; align-items: flex-end; max-width: 82%; }
.bubble.out { align-self: flex-end; flex-direction: row-reverse; }
.bubble .avatar {
  width: 34px; height: 34px; flex: 0 0 34px; border-radius: 13px;
  display: grid; place-items: center; font-size: 13px; font-weight: 600;
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff;
}
.bubble.in .avatar { background: rgba(255,255,255,.08); color: var(--text-soft); }
.bubble .body {
  padding: 10px 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid var(--border);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.in .body { border-bottom-left-radius: 7px; }
.bubble.out .body {
  background: linear-gradient(135deg, rgba(139,124,248,.92), rgba(244,114,182,.86));
  border-color: transparent; color: #fff;
  border-bottom-right-radius: 7px;
}
.bubble .meta { font-size: 10.5px; color: var(--text-dim); margin-top: 4px; }

/* 时间线 */
.timeline { display: flex; flex-direction: column; gap: 2px; }
.tl-item { display: flex; gap: 14px; padding: 10px 0; }
.tl-rail { display: flex; flex-direction: column; align-items: center; flex: 0 0 26px; }
.tl-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); margin-top: 5px; }
.tl-dot.sim { background: var(--warn); box-shadow: 0 0 0 4px var(--warn-soft); }
.tl-dot.inferred { background: var(--info); box-shadow: 0 0 0 4px var(--info-soft); }
.tl-line { flex: 1; width: 1px; background: var(--border); margin: 4px 0; }
.tl-body { flex: 1; min-width: 0; }
.tl-body .txt { line-height: 1.65; }
.tl-body .sub { font-size: 11.5px; color: var(--text-dim); margin-top: 3px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 空态 */
.empty { text-align: center; padding: 40px 20px; color: var(--text-dim); }
.empty svg { opacity: .4; margin-bottom: 10px; }
.empty .t { font-size: 13.5px; color: var(--text-soft); margin-bottom: 4px; }
.empty .d { font-size: 12px; }

/* 标签页 */
.tabs { display: flex; gap: 6px; padding: 4px; background: rgba(255,255,255,.035); border-radius: var(--r-pill); border: 1px solid var(--border); overflow-x: auto; }
.tab {
  padding: 7px 15px; border-radius: var(--r-pill);
  font-size: 12.5px; color: var(--text-soft); cursor: pointer;
  border: none; background: transparent; font-family: inherit;
  transition: background .16s, color .16s; white-space: nowrap;
}
.tab:hover { color: var(--text); background: rgba(255,255,255,.05); }
.tab.active { background: var(--accent-soft); color: #fff; box-shadow: inset 0 0 0 1px rgba(139,124,248,.35); }

/* 提示条 */
.notice { display: flex; gap: 12px; padding: 13px 16px; border-radius: var(--r-md); border: 1px solid var(--border); background: rgba(255,255,255,.03); font-size: 13px; align-items: flex-start; }
.notice svg { flex: 0 0 18px; margin-top: 1px; }
.notice.ok { background: var(--ok-soft); border-color: rgba(74,222,128,.3); }
.notice.warn { background: var(--warn-soft); border-color: rgba(251,191,36,.3); }
.notice.danger { background: var(--danger-soft); border-color: rgba(251,113,133,.3); }
.notice.info { background: var(--info-soft); border-color: rgba(96,165,250,.3); }
.notice .nt { font-weight: 600; margin-bottom: 2px; }
.notice .nd { color: var(--text-soft); font-size: 12.5px; }

/* 日志 */
.logs { font-family: var(--mono); font-size: 12px; line-height: 1.75; background: rgba(6, 9, 16, .72); border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 14px; height: 460px; overflow-y: auto; }
.log-line { white-space: pre-wrap; word-break: break-word; border-bottom: 1px solid rgba(255,255,255,.03); padding: 2px 0; }
.log-line.warn { color: #ffe0a3; }
.log-line.error { color: #ffb3c0; }
.log-line.debug { color: var(--text-dim); }

/* 弹窗 */
.modal-back { position: fixed; inset: 0; background: rgba(4, 6, 12, .7); backdrop-filter: blur(6px); display: grid; place-items: center; z-index: 100; padding: 20px; animation: fade .18s ease; }
.modal { width: min(760px, 100%); max-height: 86vh; overflow-y: auto; background: var(--surface-strong); border: 1px solid var(--border-strong); border-radius: var(--r-xl); box-shadow: var(--shadow-lg); padding: 22px 24px; }
.modal h3 { margin: 0 0 6px; font-size: 16px; }
.modal .modal-sub { color: var(--text-dim); font-size: 12.5px; margin-bottom: 18px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

/* 引导向导 */
.wizard-steps { display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; }
.wstep { display: flex; align-items: center; gap: 9px; padding: 8px 14px; border-radius: var(--r-pill); border: 1px solid var(--border); font-size: 12.5px; color: var(--text-dim); background: rgba(255,255,255,.02); }
.wstep.done { border-color: rgba(74,222,128,.4); color: #c9f7d9; background: var(--ok-soft); }
.wstep.active { border-color: rgba(139,124,248,.5); color: #fff; background: var(--accent-soft); }
.wstep .n { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.08); font-size: 11px; }

/* 供应商卡片 */
.provider { display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: var(--r-md); border: 1px solid var(--border); background: rgba(255,255,255,.028); cursor: pointer; transition: border-color .16s, background .16s, transform .14s; text-align: left; font-family: inherit; color: var(--text); }
.provider:hover { transform: translateY(-2px); border-color: var(--border-strong); }
.provider.active { border-color: rgba(139,124,248,.6); background: var(--accent-soft); box-shadow: var(--glow); }
.provider .pn { font-weight: 600; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.provider .pd { font-size: 11.5px; color: var(--text-dim); line-height: 1.6; }

/* 小工具 */
.muted { color: var(--text-dim); }
.soft { color: var(--text-soft); }
.small { font-size: 12px; }
.tiny { font-size: 11px; }
.center { text-align: center; }
.right { text-align: right; }
.mt { margin-top: 14px; }
.mt-sm { margin-top: 8px; }
.mb { margin-bottom: 14px; }
.nowrap { white-space: nowrap; }
.pre-wrap { white-space: pre-wrap; word-break: break-word; }
.hidden { display: none !important; }
.avatar-lg { width: 56px; height: 56px; border-radius: 20px; display: grid; place-items: center; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; font-size: 22px; font-weight: 600; flex: 0 0 56px; }
.kv { display: grid; grid-template-columns: 132px 1fr; gap: 8px 14px; font-size: 13px; align-items: baseline; }
.kv .k { color: var(--text-dim); font-size: 12.5px; }
.danger-text { color: #ffb3c0; }
.ok-text { color: #9ff0bb; }
.warn-text { color: #ffdf9e; }

/* 对话设置：活跃度滑杆与效果预览 */
.chip { border: 1px solid var(--border); background: transparent; color: var(--text-soft); font-size: 12.5px; padding: 7px 14px; border-radius: 999px; cursor: pointer; transition: all .16s ease; font-family: inherit; }
.chip:hover { border-color: var(--border-strong); color: var(--text); }
.chip.active { background: var(--accent-soft); border-color: rgba(167,139,250,.5); color: #fff; }
.activity-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.activity-head .big-num { font-size: 30px; font-weight: 700; letter-spacing: .5px; line-height: 1; }
input[type="range"] { -webkit-appearance: none; appearance: none; height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--accent) 0%, var(--accent-2) 100%); outline: none; margin: 10px 0; }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,.35); cursor: pointer; }
.preview-box { padding: 14px 16px; border-radius: var(--r-md); background: rgba(6,9,16,.5); border: 1px dashed var(--border-strong); font-size: 13px; line-height: 1.7; color: var(--text-soft); }

/* 天气 */
.wx-hero { display: flex; align-items: center; gap: 18px; }
.wx-icon { color: #9ecbff; display: flex; }
.wx-temp { font-size: 26px; font-weight: 680; letter-spacing: .5px; }

/* Toast */
.toasts { position: fixed; right: 22px; bottom: 22px; display: flex; flex-direction: column; gap: 10px; z-index: 200; }
.toast { display: flex; gap: 10px; align-items: flex-start; padding: 12px 16px; border-radius: var(--r-md); background: var(--surface-strong); border: 1px solid var(--border-strong); box-shadow: var(--shadow-lg); max-width: 380px; animation: slideIn .24s cubic-bezier(.4,0,.2,1); font-size: 13px; }
.toast.ok { border-color: rgba(74,222,128,.4); }
.toast.error { border-color: rgba(251,113,133,.45); }
@keyframes slideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }

/* 骨架 */
.skeleton { background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: shimmer 1.3s infinite; border-radius: var(--r-sm); height: 14px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* 修复卡：QQ 连不上时置顶显示，视觉上最醒目 */
.repair-card {
  border-color: rgba(251, 113, 133, 0.45) !important;
  background: linear-gradient(180deg, rgba(251, 113, 133, 0.1), rgba(24, 29, 46, 0.9)) !important;
  box-shadow: 0 18px 48px -28px rgba(251, 113, 133, 0.9);
}
.repair-card .card-icon { background: var(--danger-soft); color: #ffb3c0; }
.repair-card + .grid, .repair-card + .card { margin-top: 16px; }

/* 步骤清单 */
.steps .row:last-child { border-bottom: none !important; }

@media (max-width: 820px) {
  .sidebar { position: fixed; z-index: 60; height: 100%; }
  .sidebar:not(.open) { transform: translateX(-100%); }
  .content { padding: 16px 14px 60px; }
  .topbar { padding: 12px 14px; }
}
`;
