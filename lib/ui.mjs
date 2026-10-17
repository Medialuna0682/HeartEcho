/**
 * 控制面板的单文件前端：HTML 外壳 + 设计系统 + 应用逻辑。
 * 全部内联到一个响应里，没有外部依赖、没有构建步骤，双击就能用。
 */
import { CSS } from "./ui-css.mjs";
import { brandMark } from "./ui-icons.mjs";
import { appScript } from "./ui-app.mjs";
import { CLIENT_ICONS_JSON } from "./ui-icons-client.mjs";

export function ui() {
  const script = appScript({ iconsJson: CLIENT_ICONS_JSON });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>心语 · HeartEcho 控制面板</title>
<link rel="icon" href="/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main">
    <header class="topbar">
      <div>
        <h1 id="pageTitle">总览</h1>
      </div>
      <div class="topbar-right" id="navStatus"></div>
    </header>
    <div class="content" id="content"></div>
  </main>
</div>
<div id="modal" class="hidden"></div>
<div id="fatal" class="hidden"></div>
<div class="toasts" id="toasts"></div>
<noscript>这个控制面板需要 JavaScript 才能运行。</noscript>
<script>${script}</script>
</body>
</html>`;
}

export { brandMark };
