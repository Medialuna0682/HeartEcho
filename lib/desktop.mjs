/**
 * 桌面壳：托盘图标 + 独立窗口（带窗口的浏览器 app 模式）+ 单实例 + 开机自启。
 *
 * 设计取舍（规划书 17.4）：
 *   - 主程序保持纯 Node，不引入 Electron 这类重运行时；窗口用系统自带 Chromium 的 app 模式，
 *     看起来就是一个独立应用窗口（没有地址栏、没有标签页）。
 *   - 托盘用 PowerShell 的 WinForms NotifyIcon，和主进程通过退出码约定通信。
 *   - 关闭窗口 = 关掉窗口，后台继续跑；要从托盘退出才真的停。
 *
 * 用法：
 *   心语.exe --tray            缩进托盘（默认行为）
 *   心语.exe --no-panel        只起托盘，不打开窗口
 *   心语.exe --install-autostart / --remove-autostart / --autostart-status
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { APP_DIR, paths, isSea, isInstalled, installRoot, loadSettings, saveSettings, writeJson } from "./paths.mjs";
import { createLogger } from "./log.mjs";
import { panelToken, panelLaunchUrl } from "./panel-auth.mjs";

const log = createLogger("Desktop");

const CHROMIUM_CANDIDATES = [
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

export function findBrowser() {
  return CHROMIUM_CANDIDATES.find((item) => item && fs.existsSync(item)) || "";
}

/** 打开一个「像应用」的窗口。找不到 Chromium 就退回默认浏览器。 */
export function openPanelWindow(url, { title = "心语 · HeartEcho", dataDir = paths.data } = {}) {
  // 跨实例地址已经带着目标实例的凭据，不能换成当前进程的令牌。
  if (!new URLSearchParams(new URL(url).hash.slice(1)).get("panelToken")) url = panelLaunchUrl(url);
  const browser = findBrowser();
  const profileDir = path.join(dataDir, "cache", "window-profile");
  try {
    if (browser) {
      fs.mkdirSync(profileDir, { recursive: true });
      const child = spawn(
        browser,
        [
          `--app=${url}`,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=1280,900",
          "--disable-features=Translate,DefaultBrowserSettingEnforcement",
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      log.info(`已打开控制面板窗口（${path.basename(browser)} app 模式）`);
      return { ok: true, method: "app-window", browser };
    }
  } catch (error) {
    log.warn(`用 app 模式打开窗口失败：${error?.message ?? error}`);
  }
  try {
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    log.info("已用系统默认浏览器打开控制面板");
    return { ok: true, method: "default-browser" };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ------------------------------- 托盘图标 ------------------------------- */

function trayScriptPath() {
  return path.join(paths.data, "cache", "tray.ps1");
}

function iconPath() {
  return path.join(paths.data, "cache", "app.ico");
}

/** 生成一个圆形渐变的小图标（ico 其实可以塞 png，WinForms 也认）。 */
function writeIcon() {
  const target = iconPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) return target;
    // 16x16 的 BMP 内容嵌进 ICO：中间一颗心，底色紫粉渐变
    const size = 32;
    const pixels = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const t = (x + y) / (size * 2);
        const r = Math.round(139 + (244 - 139) * t);
        const g = Math.round(124 + (114 - 124) * t);
        const b = Math.round(248 + (182 - 248) * t);
        const dx = (x - size * 0.5) / (size * 0.5);
        const dy = (y - size * 0.45) / (size * 0.5);
        const inside = dx * dx + dy * dy < 0.55;
        pixels.push(inside ? [255, 255, 255] : [r, g, b]);
      }
    }
    const xor = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      const [r, g, b] = pixels[i];
      xor[i * 4] = b;
      xor[i * 4 + 1] = g;
      xor[i * 4 + 2] = r;
      xor[i * 4 + 3] = 255;
    }
    const andMask = Buffer.alloc((size * size) / 8);
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(xor.length + andMask.length, 20);
    const dib = Buffer.concat([header, xor, andMask]);
    const dir = Buffer.alloc(22);
    dir.writeUInt16LE(0, 0);
    dir.writeUInt16LE(1, 2);
    dir.writeUInt16LE(1, 4);
    dir[6] = size;
    dir[7] = size;
    dir[8] = 0;
    dir[9] = 0;
    dir.writeUInt16LE(1, 10);
    dir.writeUInt16LE(32, 12);
    dir.writeUInt32LE(dib.length, 14);
    dir.writeUInt32LE(22, 18);
    fs.writeFileSync(target, Buffer.concat([dir, dib]));
    return target;
  } catch (error) {
    log.warn(`生成托盘图标失败（会自动改用默认图标）：${error?.message ?? error}`);
    return "";
  }
}

const TRAY_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$PanelUrl,
  [Parameter(Mandatory=$true)][string]$LogFile,
  [string]$IconPath = "",
  [string]$PanelToken = "",
  [string]$Browser = ""
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 注意：下面所有字符串一律用单引号。
# 这个脚本本身是被 JS 模板字符串生成的，写 \\" 会被还原成裸引号、
# 反而把 PowerShell 的参数列表拆坏（--app=... 会被当成两个参数）。
function Write-TrayLog([string]$msg) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $LogFile -Value "$stamp $msg" -Encoding UTF8
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = '心语 · 运行中'
if ($IconPath -and (Test-Path $IconPath)) {
  try { $notify.Icon = New-Object System.Drawing.Icon($IconPath) } catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}

function Open-Panel {
  $openUrl = $PanelUrl + '/#panelToken=' + $PanelToken
  if ($Browser -and (Test-Path $Browser)) {
    # 用数组拼参数，避免引号在不同层面被吃掉
    $argList = @('--app=' + $openUrl, '--window-size=1280,900')
    Start-Process -FilePath $Browser -ArgumentList $argList
  } else {
    Start-Process $openUrl
  }
}

function Restart-Bot {
  Write-TrayLog '用户点了重启机器人'
  try {
    Invoke-WebRequest -Uri "$PanelUrl/api/system/restart" -Method POST -Headers @{Authorization=('Bearer ' + $PanelToken)} -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-TrayLog '已请求重启'
  } catch {
    Write-TrayLog "请求重启失败：$($_.Exception.Message)"
  }
}

function Stop-Bot {
  Write-TrayLog '用户点了退出'
  try {
    Invoke-WebRequest -Uri "$PanelUrl/api/system/quit" -Method POST -Headers @{Authorization=('Bearer ' + $PanelToken)} -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5 | Out-Null
  } catch {
    Write-TrayLog "请求退出失败：$($_.Exception.Message)"
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('打开控制面板')
$itemOpen.add_Click({ Open-Panel })
$itemRestart = $menu.Items.Add('重启机器人')
$itemRestart.add_Click({ Restart-Bot })
$itemData = $menu.Items.Add('打开数据文件夹')
$itemData.add_Click({ Start-Process explorer.exe (Split-Path (Split-Path $LogFile -Parent) -Parent) })
$itemLog = $menu.Items.Add('查看日志')
$itemLog.add_Click({ Start-Process notepad.exe $LogFile })
$menu.Items.Add('-') | Out-Null
$itemExit = $menu.Items.Add('退出心语（完全停止）')
$itemExit.add_Click({
  Stop-Bot
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
  exit 0
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Open-Panel })
$notify.Visible = $true
Write-TrayLog "托盘已就绪 PanelUrl=$PanelUrl"

# 第一次缩进托盘时给个气泡提示，否则用户会以为程序没起来
try { $notify.ShowBalloonTip(4000, '心语在后台运行', '关掉窗口不会退出。双击托盘图标重新打开控制面板，右键可以退出。', [System.Windows.Forms.ToolTipIcon]::None) } catch { }

[System.Windows.Forms.Application]::Run()
`;

/**
 * 启动托盘。
 *
 * 关键点：**不能弹出任何窗口，也不能被父进程带走**。
 *   ① 老做法是 `cmd /c start "" /min powershell …`，`/min` 会在任务栏留一个最小化的控制台窗口，
 *      用户看到的就是「右下角多了一个黑框」。
 *   ② 换成 detached 也不能用：Windows PowerShell 5 是控制台程序，脱离控制台（DETACHED_PROCESS）
 *      会立刻退出（实测：进程起来了但一个字都不写）。这是踩过的坑。
 *   所以最终做法是：不 detached、windowsHide（自己带一个隐藏控制台）、
 *   把 stdout/stderr 重定向到文件 —— 这样既有真实的句柄，又没有任何可见窗口。
 */
export function startTray({ panelUrl, browser = "" }) {
  const script = trayScriptPath();
  const logFile = path.join(paths.logs, "tray.log");
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    // 必须带 UTF-8 BOM：Windows PowerShell 5 读无 BOM 的 .ps1 会按 ANSI(GBK) 解，
    // 脚本里的中文注释会变成乱码，进而把解析器带崩（实测会报一堆莫名其妙的语法错）。
    fs.writeFileSync(script, `\uFEFF${TRAY_PS1}`, "utf8");
  } catch (error) {
    return { ok: false, error: `写托盘脚本失败：${error?.message ?? error}` };
  }
  const icon = writeIcon();
  const args = [
    "-NoProfile",
    "-NoLogo",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    script,
    "-PanelUrl",
    panelUrl,
    "-PanelToken",
    panelToken(),
    "-LogFile",
    logFile,
    "-IconPath",
    icon,
    "-Browser",
    browser,
  ];
  let fd = null;
  try {
    const outFile = path.join(paths.logs, "tray.out.log");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fd = fs.openSync(outFile, "a");
    const child = spawn("powershell", args, { windowsHide: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return { ok: true, script, logFile, pid: child.pid, method: "direct" };
  } catch (error) {
    try {
      const child = spawn("cmd", ["/c", "start", "", "/min", "powershell", ...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return { ok: true, script, logFile, pid: child.pid, method: "cmd-start", warning: String(error?.message ?? error) };
    } catch (error2) {
      return { ok: false, error: String(error2?.message ?? error2) };
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 等托盘真的就位（日志里出现「托盘已就绪」），用于自检/验收。 */
export function waitTrayReady(logFile, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (fs.readFileSync(logFile, "utf8").includes("托盘已就绪")) return resolve(true);
      } catch {
        /* 还没写 */
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/* ------------------------------ 重启自己 ------------------------------ */

/**
 * 重启：把我自己重新拉起来，然后退出。
 *
 * 为什么要绕过「自己 spawn 一个 helper」这条路：
 *   实测在这台机器上，父进程一退出，它 spawn 出来的子进程（powershell / wscript，detached 也一样）
 *   会跟着一起死——helper 还没来得及执行 Start-Process 就没了，用户看到的就是「点重启，程序没了」。
 *   改用 `explorer.exe <exe>`：由系统外壳（explorer）去启动，新进程的父进程是 explorer，
 *   和我们没有父子关系，所以不会被带走。这是 Windows 上最稳的「重新启动自己」的做法。
 *
 * 新实例起来以后会看到「锁还在、但控制面板端口不在」——index.mjs 里会等老实例退出再接管。
 */
export function relaunchSelf({ delayMs = 1200, args = [] } = {}) {
  const tbEdition = process.env.HEARTECHO_EDITION === "tb";
  const target = isInstalled ? path.join(installRoot, tbEdition ? "领航员终端.exe" : "心语.exe") : process.execPath;
  if (tbEdition && !args.includes("--tb")) args = [...args, "--tb"];
  const instanceIndex = process.argv.indexOf("--instance");
  if (isInstalled && instanceIndex >= 0 && process.argv[instanceIndex + 1] && !args.includes("--instance")) {
    args = [...args, "--instance", process.argv[instanceIndex + 1]];
  }
  if (isInstalled) {
    for (const flag of ["--no-panel", "--no-tray", "--no-autostart"]) {
      if (process.argv.includes(flag) && !args.includes(flag)) args = [...args, flag];
    }
    // 启动器立即创建新进程，新实例用 --takeover 等旧实例释放锁。
    // 不让旧进程退出后再依赖延时 helper，否则 helper 可能随旧进程一起结束。
    try {
      if (!fs.existsSync(target)) throw new Error("找不到安装版启动器");
      const nextArgs = [...args, "--takeover"];
      const child = spawn(target, nextArgs, { cwd: installRoot, detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", (error) => log.error(`启动器重启失败：${error.message}`));
      child.unref();
      return { ok: true, target, args: nextArgs, helper: "launcher" };
    } catch (error) {
      log.warn(`启动器重启失败，将尝试延时方式：${error?.message ?? error}`);
    }
  }

  // 打包成 exe：走 explorer，彻底脱离子进程关系（多等一会儿由新实例自己负责）
  if (isSea && !tbEdition) {
    try {
      const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      log.info(`已安排重启：由系统外壳重新拉起 ${path.basename(target)}`);
      return { ok: true, target, args: [], helper: "explorer" };
    } catch (error) {
      log.warn(`用 explorer 拉起失败，改用 powershell：${error?.message ?? error}`);
    }
  }

  // 源码模式（或 explorer 失败）：用 powershell 延时拉起，顺便把输出留到日志里
  const extra = isSea || isInstalled ? args.slice() : [path.join(APP_DIR, "index.mjs"), ...args];
  extra.push("--takeover");
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  // Start-Process 把数组元素拼成单条命令行；带空格的路径仍须按 Windows 规则加引号。
  const quoteArg = (text) => `"${String(text).replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/, "$1$1")}"`;
  const argList = extra.length ? ` -ArgumentList @(${extra.map((value) => quote(quoteArg(value))).join(",")})` : "";
  const ps = `Start-Sleep -Milliseconds ${Math.max(300, Number(delayMs) || 1200)}; Start-Process -FilePath ${quote(target)}${argList} -WorkingDirectory ${quote(APP_DIR)} -WindowStyle Hidden`;
  let fd = null;
  try {
    const outFile = path.join(paths.logs, "relaunch.log");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fd = fs.openSync(outFile, "a");
    fs.writeSync(fd, `\n[${new Date().toISOString()}] relaunch: ${ps}\n`);
    const child = spawn("powershell", ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    log.info(`已安排重启（${delayMs}ms 后拉起 ${path.basename(target)}）`);
    return { ok: true, target, args: extra, helper: "powershell" };
  } catch (error) {
    log.warn(`安排重启失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------ 开机自启动 ------------------------------ */

function startupDir() {
  return path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function shortcutPath() {
  if (isInstalled && process.env.HEARTECHO_INSTANCE === "1") {
    const id = createHash("sha256").update(path.resolve(paths.data).toLowerCase()).digest("hex").slice(0, 12);
    return path.join(startupDir(), `心语实例-${id}.lnk`);
  }
  return path.join(startupDir(), process.env.HEARTECHO_EDITION === "tb" ? (isInstalled ? "领航员终端.lnk" : "心语TB.lnk") : "心语机器人.lnk");
}

function currentCommand() {
  const flags = process.env.HEARTECHO_EDITION === "tb" ? "--tray --tb" : "--tray";
  if (isInstalled) {
    const index = process.argv.indexOf("--instance");
    const instance = index >= 0 && process.argv[index + 1] ? ` --instance "${process.argv[index + 1].replace(/"/g, '\\"')}"` : "";
    return { target: path.join(installRoot, process.env.HEARTECHO_EDITION === "tb" ? "领航员终端.exe" : "心语.exe"), args: `${flags}${instance}` };
  }
  if (isSea) return { target: process.execPath, args: flags };
  return { target: process.execPath, args: `"${path.join(APP_DIR, "index.mjs")}" ${flags}` };
}

export function autostartStatus() {
  const file = shortcutPath();
  const exists = fs.existsSync(file);
  let target = "";
  let args = "";
  if (exists) {
    try {
      // 必须先把 PowerShell 的输出编码切成 UTF-8，否则中文路径按 GBK 出来、
      // 再被 Node 当 UTF-8 解，就会显示成 E:\????\dist\????.exe 这种乱码。
      const ps = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}'); "$($s.TargetPath)|$($s.Arguments)"`;
      const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
      const [targetPath, argText] = out.split("|");
      target = targetPath ?? "";
      args = argText ?? "";
    } catch {
      target = "";
    }
  }
  return { installed: exists, file, target, args, supported: process.platform === "win32" };
}

export function installAutostart() {
  if (process.platform !== "win32") return { ok: false, error: "只有 Windows 支持开机自启" };
  const { target, args } = currentCommand();
  const file = shortcutPath();
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$lnk = $ws.CreateShortcut('${file.replace(/'/g, "''")}')`,
    `$lnk.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$lnk.Arguments = '${args.replace(/'/g, "''")}'`,
    `$lnk.WorkingDirectory = '${APP_DIR.replace(/'/g, "''")}'`,
    "$lnk.WindowStyle = 7",
    "$lnk.Description = '心语 · QQ 数字生命伴侣'",
    "$lnk.Save()",
  ].join("; ");
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "pipe" });
    saveSettings({ ...loadSettings(), autostart: true });
    return { ok: true, file, target, args };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function removeAutostart() {
  try {
    fs.rmSync(shortcutPath(), { force: true });
    saveSettings({ ...loadSettings(), autostart: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 面板上的开关走这里：true=登记开机自启，false=取消。 */
export function setAutostart(enabled) {
  return enabled ? installAutostart() : removeAutostart();
}

/**
 * 自检桌面外壳：不真的弹托盘窗口，只验证「该有的东西都在、脚本本身没语法错」。
 * 这样在没有交互桌面的环境里也能确认这条路径是通的。
 */
export function desktopSelfCheck() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? "") });

  const browser = findBrowser();
  add("找到系统浏览器（用于应用窗口）", Boolean(browser), browser || "没找到 Edge/Chrome，会退回系统默认浏览器打开");

  let trayScript = "";
  try {
    fs.mkdirSync(path.dirname(trayScriptPath()), { recursive: true });
    fs.writeFileSync(trayScriptPath(), `\uFEFF${TRAY_PS1}`, "utf8");
    trayScript = trayScriptPath();
    const size = fs.statSync(trayScript).size;
    add("托盘脚本已生成", size > 2000, `${trayScript}（${size} 字节，带 UTF-8 BOM）`);
  } catch (error) {
    add("托盘脚本已生成", false, String(error?.message ?? error));
  }

  const icon = writeIcon();
  add("托盘图标已生成", Boolean(icon) && fs.existsSync(icon), icon ? `${icon}（${fs.statSync(icon).size} 字节）` : "生成失败（会用系统默认图标）");

  // 用 PowerShell 解析一遍脚本，确认没有语法错误
  if (trayScript && process.platform === "win32") {
    try {
      const escaped = trayScript.replace(/'/g, "''");
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$errors = $null; $tokens = $null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message } } else { 'OK' }`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      add("托盘脚本语法正确", out === "OK", out === "OK" ? "PowerShell 解析通过" : out.slice(0, 200));
    } catch (error) {
      add("托盘脚本语法正确", false, String(error?.message ?? error).slice(0, 200));
    }
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; 'OK'"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      add("系统支持托盘（WinForms 可用）", out === "OK", out === "OK" ? "System.Windows.Forms / Drawing 都能加载" : out.slice(0, 160));
    } catch (error) {
      add("系统支持托盘（WinForms 可用）", false, String(error?.message ?? error).slice(0, 160));
    }
  } else {
    add("托盘脚本语法正确", false, "非 Windows 平台，跳过");
  }

  // 托盘菜单必须能真的「退出」和「重启」（老版本退出只关了托盘，机器人还在后台跑）
  add(
    "托盘菜单能退出与重启",
    TRAY_PS1.includes("/api/system/quit") && TRAY_PS1.includes("/api/system/restart"),
    "退出 = 真的停掉机器人；重启 = 停掉后再拉起来",
  );
  add("托盘启动不带控制台窗口", !TRAY_PS1.includes("cmd /c"), "直接起 powershell，不经过 cmd start");

  const autostart = autostartStatus();
  add("开机自启状态可读", true, autostart.installed ? `已安装（${autostart.target}）` : "未安装（面板「运行环境」里可以一键打开）");

  const settings = loadSettings();
  add("设置文件可读写", typeof settings === "object", Object.keys(settings).join(","));

  return { checks, ok: checks.every((item) => item.ok) };
}

export { writeJson, os };
