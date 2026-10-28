/**
 * HeartEcho（心语）· 主程序
 *
 * 启动顺序（规划书 17.3）：
 *   单实例锁 → 读入数据路径 → 校验/迁移数据库 → 启动业务服务 → 检测 QQ 适配器 →
 *   注册调度器 → 显示 GUI 或托盘
 *
 * 常用参数：
 *   node index.mjs                     正常启动
 *   node index.mjs --probe             只自检：配置、角色、模型、QQ 连通性，打印后退出
 *   node index.mjs --no-panel          不打开控制面板窗口（托盘模式）
 *   node index.mjs --archive-now       立刻做一轮归档
 *   node index.mjs --diary-now         立刻写今天的日记
 *   node index.mjs --greet-now [QQ]    立刻主动发一条消息
 *   node index.mjs --test-image <图>   图片识别自检（不发到 QQ）
 *   node index.mjs --selftest          跑离线自检（等价于 tools/selftest.mjs）
 *   node index.mjs --instance <目录>   运行 instances/<目录> 里的那份实例（多账号）
 */
// ⚠ 必须是第一个 import：它只解析 --instance 并把环境变量摆好，
// 而 paths.mjs 在加载时就把目录算死了，晚一步就来不及。
import "./lib/boot-env.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { ensureDirs, paths, isSea, isInstalled, loadSettings, saveSettings } from "./lib/paths.mjs";
import { createLogger, pruneLogs, setLogLevel, getLogLevel, redactText } from "./lib/log.mjs";
import {
  ensureConfigFile,
  ensureLocalToken,
  getConfig,
  saveConfig,
  loadConfig,
  activeCharacter,
  activeCharacterId,
  listCharacters,
  loadCharacter,
  saveCharacter,
} from "./lib/config.mjs";
import { InteractionService } from "./lib/interactions.mjs";
import { TbGroupService, TB_CHARACTER } from "./lib/tb.mjs";
import { archiveExtendedDaily, memoryConsentValid } from "./lib/extended-memory.mjs";
import { startManagedHindsight } from "./lib/hindsight-runtime.mjs";
import { getDb, closeDb, migrate, backup, integrityCheck, claimEventKey } from "./lib/db.mjs";
import { OneBot, normalizeEvent, dataUrlFromLocalFile } from "./lib/onebot.mjs";
import { LlmGateway } from "./lib/llm.mjs";
import { BudgetGate } from "./lib/budget.mjs";
import { ChatEngine } from "./lib/chat.mjs";
import { ExtensionHost } from "./lib/extensions.mjs";
import { gate, pauseState, audit } from "./lib/policy.mjs";
import { Scheduler } from "./lib/scheduler.mjs";
import { QZoneAdapter } from "./lib/qzone.mjs";
import { QZoneScheduler } from "./lib/qzone-job.mjs";
import { createApiServer } from "./lib/api.mjs";
import {
  openPanelWindow,
  startTray,
  autostartStatus,
  installAutostart,
  removeAutostart,
  findBrowser,
  desktopSelfCheck,
  relaunchSelf,
  waitTrayReady,
} from "./lib/desktop.mjs";
import { diagnoseProtocol, ensureProtocol, startProtocol, stopProtocol, isPortListening } from "./lib/protocol.mjs";
import { listSessions, scopeLabel } from "./lib/storage.mjs";
import { archiveOnce, writeDiary } from "./lib/life.mjs";
import { forecast as fetchWeather, summarize as summarizeWeather } from "./lib/weather.mjs";
import { recoverMissedMessages } from "./lib/recovery.mjs";
import { panelLaunchUrl } from "./lib/panel-auth.mjs";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] ?? "").trim() : "";
};

const PROBE = has("--probe");
const NO_PANEL = has("--no-panel");
const SELFTEST = has("--selftest");
const ARCHIVE_NOW = has("--archive-now");
const DIARY_NOW = has("--diary-now");
const GREET_NOW = has("--greet-now");
const TEST_IMAGE = valueOf("--test-image");
const TRAY = has("--tray");
const NO_TRAY = has("--no-tray");
const NO_AUTOSTART = has("--no-autostart");
/**
 * 「你是我重启拉起来的新实例，等一下老实例把锁和端口放开」。
 * 老实例退出前可能还在做退出备份，抢锁太早会失败——那就等一会儿，而不是直接退出。
 */
const TAKEOVER = has("--takeover");
const INSTALL_AUTOSTART = has("--install-autostart");
const REMOVE_AUTOSTART = has("--remove-autostart");
const AUTOSTART_STATUS = has("--autostart-status");
const DESKTOP_CHECK = has("--desktop-check");
const OPEN_PANEL = has("--open-panel");
const PANEL_URL = has("--panel-url");

const log = createLogger("Main");

/* ------------------------------ 单实例锁 ------------------------------ */

/**
 * 锁按「数据目录」区分：同一个数据目录只能跑一个实例（避免两边同时写库），
 * 但不同的数据目录可以各跑一个（比如正式数据 + 测试沙箱、或者两份角色各一份数据）。
 * 文件名里带上数据目录的哈希，就不会互相误伤。
 */
const LOCK_FILE = path.join(
  os.tmpdir(),
  `heartecho-${createHash("sha1").update(paths.data.toLowerCase()).digest("hex").slice(0, 12)}.lock`,
);

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf8");
      const info = JSON.parse(raw);
      if (info?.pid && info.pid !== process.pid) {
        try {
          process.kill(info.pid, 0);
          return {
            ok: false,
            pid: info.pid,
            message: `心语已经在运行了（同一个数据目录只能跑一个实例）\n  数据目录：${paths.data}\n  占用进程：${info.pid}`,
          };
        } catch {
          /* 进程已经不在了，接管锁 */
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now(), data: paths.data }), "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: true, warning: String(error?.message ?? error) };
  }
}

function releaseLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    if (JSON.parse(raw)?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 自检输出 ------------------------------ */

async function runProbe({ client, llm, qzone }) {
  const cfg = getConfig();
  const character = activeCharacter();
  console.log("=== 心语自检 ===");
  console.log(`角色：${character.name}（${character.title || "无头衔"}）｜共 ${listCharacters().length} 张角色卡`);
  console.log(`数据目录：${paths.data}`);
  console.log(`控制面板：http://${cfg.bot.panelHost}:${cfg.bot.panelPort}`);
  const profile = cfg.llm.profiles[cfg.llm.activeProfile];
  console.log(`模型：${profile?.model} @ ${profile?.baseUrl}${profile?.apiKey ? "" : "  ⚠ 还没有 API Key"}`);
  console.log(`账号：机器人 ${cfg.bot.selfId}｜对方 ${cfg.bot.masterId || "（未设置）"}`);

  const dbInfo = integrityCheck();
  console.log(`数据库：${dbInfo.ok ? "完整" : `⚠ ${dbInfo.value}`}`);

  if (client) {
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const ping = await client.ping();
    console.log(ping.ok ? `QQ 连接：正常（${ping.info?.nickname} / ${ping.info?.user_id}）` : `QQ 连接：失败——${ping.error}`);
    if (ping.ok) {
      const caps = await client.probeCapabilities({ refresh: true });
      const ok = Object.entries(caps).filter(([, value]) => value === "api_verified").map(([key]) => key);
      const unsupported = Object.entries(caps).filter(([, value]) => value === "unsupported").map(([key]) => key);
      console.log(`协议端能力：可用 ${ok.length} 项｜不支持 ${unsupported.length} 项`);
      client.stop();
    }
  }

  if (llm) {
    const status = llm.status();
    console.log(`模型配置：${status.ready ? "已就绪" : "未就绪"}`);
    const budget = status.budget;
    console.log(`预算：${budget.ok ? "充足" : "已达上限"}`);
  }
  console.log("（连不上 QQ 通常是：QQ 没登录 / 协议端没启动 / 端口或令牌不一致）");
}

/* -------------------------------- 主流程 -------------------------------- */

async function main() {
  ensureDirs();
  ensureConfigFile();
  if (has("--tb") && !getConfig().tb.initialized) {
    saveCharacter(TB_CHARACTER.id, TB_CHARACTER);
    saveConfig({ tb: { enabled: true, initialized: true }, activeCharacter: TB_CHARACTER.id,
      bot: { panelPort: 5321, onebotWsUrl: "ws://127.0.0.1:3103/", onebotHttpUrl: "http://127.0.0.1:3102/" },
      chat: { replyGroupAll: false, replyGroupAt: true, useEmoji: false } });
  }
  if (PANEL_URL) {
    const bot = getConfig().bot;
    console.log(panelLaunchUrl(`http://${bot.panelHost || "127.0.0.1"}:${Number(bot.panelPort) || 5311}`));
    return;
  }
  // 第一次启动生成一个本机专用的协议端访问令牌（不写死公共值，见 config.mjs 注释）
  const tokenInfo = ensureLocalToken();
  const cfg = getConfig();
  if (tokenInfo.created) log.info("已生成本机的协议端访问令牌（只保存在本地 config.json 里）");
  pruneLogs(14);
  getDb();
  migrate();
  /*
   * 修一次历史记忆的归属：
   * 早期归档把记忆挂在了「机器人自己的 QQ」名下，检索按对方 QQ 过滤就永远命中不到，
   * 表现为「她什么都记不住」。这里幂等地把私聊作用域里的这些行改回对方。
   */
  try {
    const { repairMemorySubjects } = await import("./lib/memory.mjs");
    repairMemorySubjects({ botId: cfg.bot.selfId });
  } catch (error) {
    log.warn(`修正记忆归属失败（不影响启动）：${error?.message ?? error}`);
  }

  const budgetGate = new BudgetGate();
  const llm = new LlmGateway({ budgetGate });
  const client = new OneBot({
    url: cfg.bot.onebotWsUrl,
    accessToken: cfg.bot.accessToken,
    httpUrl: cfg.bot.onebotHttpUrl,
    selfId: cfg.bot.selfId,
  });
  const life = { llm, character: activeCharacter };
  const qzone = new QZoneAdapter({ client, llm });
  const scheduler = new Scheduler({ client, llm, life });
  const chat = new ChatEngine({
    client,
    llm,
    life,
    scheduler,
    onReply: ({ event, bubbles }) => {
      log.info(`已回复 ${scopeLabel(event.scopeKey, { masterId: cfg.bot.masterId, masterName: cfg.bot.masterName })}：${bubbles.join(" / ")}`);
    },
  });
  const qzoneScheduler = new QZoneScheduler({ qzone, llm });
  const tb = new TbGroupService({ client, chat });
  const interactions = new InteractionService({ client, chat, tb });

  /*
   * 插件/技能扩展宿主。
   * 装载放在「面板启动之前、QQ 连接之前」：这样第一轮对话开始前工具和提示词片段就都齐了。
   * 自检模式只装载不激活（不能起定时器），别的模式正常激活。
   */
  const extensions = new ExtensionHost({ llm, client, engine: chat });
  chat.extensions = extensions;

  if (PROBE) {
    await runProbe({ client, llm, qzone });
    closeDb();
    return;
  }

  if (INSTALL_AUTOSTART || REMOVE_AUTOSTART || AUTOSTART_STATUS || DESKTOP_CHECK) {
    if (INSTALL_AUTOSTART) {
      const result = installAutostart();
      console.log(result.ok ? `已安装开机自启：${result.file}` : `安装失败：${result.error}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (REMOVE_AUTOSTART) {
      const result = removeAutostart();
      console.log(result.ok ? "已取消开机自启" : `取消失败：${result.error}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (DESKTOP_CHECK) {
      const report = desktopSelfCheck();
      console.log("=== 桌面外壳自检 ===");
      for (const item of report.checks) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}  · ${item.detail}`);
      console.log(report.ok ? "桌面外壳自检通过" : "桌面外壳自检有问题（见上面 ✗ 项）");
      process.exitCode = report.ok ? 0 : 1;
    } else {
      const status = autostartStatus();
      console.log(status.installed ? `已安装开机自启\n  快捷方式：${status.file}\n  目标：${status.target}` : "没有安装开机自启");
    }
    closeDb();
    return;
  }

  if (SELFTEST) {
    // boot-env 在加载任何业务模块前创建独立临时数据目录。
    const { runSelfTest } = await import("./tools/selftest.mjs");
    await extensions.init({ setup: true, activate: false });
    const result = await runSelfTest({ client, llm, chat, qzone, extensions });
    extensions.dispose();
    closeDb();
    process.exitCode = result.failed ? 1 : 0;
    return;
  }

  if (TEST_IMAGE) {
    const abs = path.resolve(TEST_IMAGE);
    console.log("=== 心语 · 图片识别自检 ===");
    if (!fs.existsSync(abs)) {
      console.log(`找不到这个文件：${abs}`);
      process.exitCode = 1;
      closeDb();
      return;
    }
    const character = activeCharacter();
    console.log(`角色：${character.name}｜模型：${cfg.llm.profiles[cfg.llm.activeProfile]?.model}`);
    const dataUrl = dataUrlFromLocalFile(abs, { maxBytes: Number(cfg.chat.imageMaxBytes) || 8388608 });
    const result = await chat.sandbox({ text: "（这张图）", images: [dataUrl], scopeKey: "image_test", peerId: cfg.bot.masterId });
    console.log("她的回应（只打印，不会发到 QQ）：");
    for (const bubble of result.bubbles) console.log(`  · ${bubble}`);
    if (!result.bubbles.length) process.exitCode = 1;
    closeDb();
    return;
  }

  if (ARCHIVE_NOW || DIARY_NOW || GREET_NOW) {
    try {
      const character = activeCharacter();
      if (ARCHIVE_NOW) {
        const result = await archiveOnce({ llm, character, masterId: cfg.bot.masterId, masterName: cfg.bot.masterName, force: true, limit: 5 });
        console.log(result.results.length ? `归档完成：${result.results.map((item) => `${item.label}（${item.experiences} 条经历 / ${item.facts} 条事实）`).join("、")}` : "没有需要归档的会话");
      }
      if (DIARY_NOW) {
        const result = await writeDiary({ llm, character, masterId: cfg.bot.masterId, masterName: cfg.bot.masterName, force: true });
        console.log(result.skipped ? `日记没写成：${result.reason}` : `日记写好了（${result.date}）：\n${result.text}`);
      }
      if (GREET_NOW) {
        client.start();
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const sent = await scheduler.greetNow({ kind: "proactive", userId: valueOf("--greet-now") });
        console.log(sent ? `已发出（${sent.peerId}）：${sent.text}` : "没有发出去（看日志里的原因）");
        client.stop();
      }
    } catch (error) {
      console.error(`执行失败：${error?.stack ?? error}`);
      process.exitCode = 1;
    }
    closeDb();
    return;
  }

  /* ---------------------------- 常驻模式 ---------------------------- */

  const bootCfg = getConfig();
  const accountConfigured = /^[1-9]\d{4,11}$/.test(String(bootCfg.bot.selfId ?? ""));
  const bootHost = bootCfg.bot.panelHost || "127.0.0.1";
  const bootPort = Number(bootCfg.bot.panelPort) || 5311;

  let lock = acquireLock();
  if (!lock.ok) {
    const otherAlive = await isPortListening(bootPort, bootHost);
    if (otherAlive && !TAKEOVER) {
      // 真的还有一个实例在正常工作（用户多半是又双击了一次）。
      // 这时候最合理的反应不是报错，而是把他已经在跑的那个面板打开。
      log.info("心语已经在运行，改为打开它的控制面板");
      openPanelWindow(`http://${bootHost}:${bootPort}`);
      console.log(`心语已经在运行中，已为你打开控制面板：http://${bootHost}:${bootPort}`);
      closeDb();
      return;
    }
    // 锁还在、面板却不在 —— 上一个实例正在退出（常见于点了「重启」）。
    // 这时候直接退出等于「重启之后程序没了」，所以等它把锁放开再接管。
    log.info("检测到上一个实例正在退出，等它把锁放开…");
    const deadline = Date.now() + (TAKEOVER ? 45000 : 15000);
    while (!lock.ok && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      lock = acquireLock();
    }
    if (lock.ok) log.info("上一个实例已退出，接管成功");
  }
  if (!lock.ok) {
    log.error(lock.message);
    console.error(lock.message);
    console.error("如果确认它已经不在运行了，删掉这个锁文件再启动：");
    console.error(`  ${LOCK_FILE}`);
    closeDb();
    process.exitCode = 1;
    return;
  }
  if (lock.warning) log.warn(`单实例锁没写成功（不影响使用）：${lock.warning}`);

  /* -------------------- 同一个 QQ 号只能有一个实例在跑 -------------------- */

  /*
   * 锁只管「同一个数据目录」，管不了「两个目录用同一个 QQ 号」。
   * 两个实例同时登录同一个号，会互相抢消息、互相顶下线，
   * 表现出来就是「她一会儿回一会儿不回」。所以这里再拦一道。
   *
   * 判断方式是去打对方的面板（比 pid 靠谱，还能顺便知道它在跑什么）。
   * 只看登记过的实例：手动复制出来的目录不在登记表里，这里看不到——
   * 那种情况留给 QQ 自己的顶号行为去暴露，错误信息里也会提示。
   */
  if (accountConfigured) try {
    const { findAccountHolder, claimAccount } = await import("./lib/instances.mjs");
    const holder = await findAccountHolder(bootCfg.bot.selfId, { excludeDir: paths.app, excludeDataDir: paths.data });
    if (holder) {
      const where = holder.panelPort ? `（面板端口 ${holder.panelPort}）` : "";
      const message = `QQ ${bootCfg.bot.selfId} 已经在另一个实例「${holder.name}」${where}里跑着了。\n同一个账号只能开一个实例：同时登录会被互相顶下线，消息也会串。\n要同时聊两个角色，请给另一个角色配另一个 QQ 号（面板「QQ 账号 → 新增实例」）。`;
      log.error(message);
      console.error(message);
      closeDb();
      process.exitCode = 1;
      return;
    }
    // 占住这个号：别的实例（哪怕目录是手动复制的）启动时就能看见
    const claimed = claimAccount(bootCfg.bot.selfId, { dir: paths.app, dataDir: paths.data, panelPort: bootPort });
    if (!claimed.ok) {
      log.error(claimed.reason);
      console.error(claimed.reason);
      closeDb();
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    log.warn(`检查账号占用失败（不影响启动）：${error?.message ?? error}`);
  } else log.warn("机器人 QQ 号还没设置，请在面板完成配置并重启");

  /* ---------------------- 开机自启：只在打包版自动登记 ---------------------- */

  // 只在「真正的安装位置」第一次运行时自动打开，避免测试沙箱把用户的启动项写脏
  const settingsNow = loadSettings();
  const isolated = Boolean(process.env.HEARTECHO_DATA_DIR || process.env.HEARTECHO_APP_DIR || process.env.HEARTECHO_SETTINGS);
  if (isSea && !isolated && !NO_AUTOSTART && settingsNow.autostart === undefined) {
    const status = autostartStatus();
    if (status.installed) {
      saveSettings({ ...loadSettings(), autostart: true });
    } else {
      const result = installAutostart();
      if (result.ok) log.info("已登记开机自启（面板「运行环境」页可以关掉）");
      else log.warn(`登记开机自启失败（不影响使用）：${result.error}`);
      saveSettings({ ...loadSettings(), autostart: Boolean(result.ok) });
    }
  }

  const character = activeCharacter();
  log.info(`角色：${character.name}（${character.title || "无头衔"}）`);
  log.info(`数据目录：${paths.data}`);
  log.info(`日志目录：${paths.logs}`);
  log.info(`控制面板：http://${cfg.bot.panelHost}:${cfg.bot.panelPort}`);
  if (cfg.bot.masterId) {
    log.info(`对方 QQ：${cfg.bot.masterId}（${cfg.bot.masterName}）`);
  } else {
    log.warn("还没有设置对方的 QQ 号——面板「运行环境」里填一下，主动消息和记忆隔离都依赖它");
  }

  client.on("connected", async () => {
    const info = await client.getLoginInfo().catch(() => null);
    if (info) {
      client.status.nickname = info.nickname;
      log.info(`已接管 QQ：${info.nickname}（${info.user_id}）`);
    }
    audit({ eventType: "qq_connected", detail: { selfId: client.selfId, nickname: client.status.nickname } });
    // 连上就补一遍历史：断线期间、重启期间对方发来的消息不至于凭空消失
    recoverMissedMessages({ client, extraPeers: [String(cfg.bot.masterId || "")] })
      .then((result) => {
        if (result.added) log.info(`补回了 ${result.added} 条之前没接到的消息（不会触发回复，只补记录）`);
        else log.debug("没有漏掉的消息");
      })
      .catch((error) => log.debug(`补历史消息失败（不影响正常收发）：${error?.message ?? error}`));
    await greetIfNeeded();
  });

  client.on("disconnected", () => {
    audit({ eventType: "qq_disconnected", reason: client.status.lastError });
  });

  /** 第一次连上时主动打一声招呼。 */
  async function greetIfNeeded() {
    try {
      const now = getConfig();
      if (!now.chat.greetOnFirstConnect) return;
      const master = String(now.bot.masterId || "");
      if (!master) return;
      const done = getDb().prepare("select value from meta where key = 'greeted_at'").get();
      if (done) return;
      const text = (character.greeting || `${now.bot.masterName}，我在的哦。`).trim();
      await client.sendPrivateMsg(master, text, { idempotencyKey: `first-greet:${master}` });
      const { insertMessage, ensureSession } = await import("./lib/storage.mjs");
      ensureSession(`private_${master}`, { characterId: character.id, accountId: String(client.selfId) });
      insertMessage({
        eventKey: `out:first-greet:${master}`,
        scopeKey: `private_${master}`,
        direction: "out",
        senderId: client.selfId,
        kind: "private",
        at: Date.now(),
        body: text,
        status: "sent",
      });
      getDb().prepare("insert or replace into meta(key, value) values('greeted_at', ?)").run(String(Date.now()));
      log.info(`已向 ${master} 发出第一声问候`);
    } catch (error) {
      log.warn(`打招呼失败（不影响使用）：${error?.message ?? error}`);
    }
  }

  client.on("event", async (event) => {
    try {
      if (event.post_type !== "message") {
        await interactions.receive(event);
        if (event.post_type === "notice" && event.notice_type === "friend_add") log.info(`新好友：${event.user_id}`);
        return;
      }
      const now = getConfig();
      const normalized = normalizeEvent(event, now.bot.selfId);
      if (!normalized) return;
      // 事件级幂等：同一条消息重复投递只处理一次
      if (!claimEventKey(normalized.eventId)) {
        log.debug(`重复事件已丢弃：${normalized.eventId}`);
        return;
      }
      if (String(normalized.senderId) === String(now.bot.selfId)) return;
      if (await interactions.adminCommand(normalized)) return;
      await chat.receive(normalized);
    } catch (error) {
      log.error(`事件处理失败：${error?.stack ?? error}`);
    }
  });

  const apiHost = cfg.bot.panelHost || "127.0.0.1";
  const apiPort = Number(cfg.bot.panelPort) || 5311;

  // 面板上的「重启 / 退出」按钮最终落到这两个函数上（server 先建、shutdown 后定义，用可变引用串起来）
  let shutdownFn = null;
  let shuttingDown = false;
  const control = {
    quit: () => shutdownFn?.("面板点了退出"),
    restart: () => {
      // 先把「等我退出后把我拉起来」安排好，再走正常退出流程（协议端留着，省一次登录）
      relaunchSelf({ delayMs: 1200 });
      shutdownFn?.("面板点了重启", { keepProtocol: true });
    },
  };

  // 扩展装载：单个扩展失败只影响它自己，绝不阻塞主程序启动
  try {
    await extensions.init({ setup: true, activate: true });
  } catch (error) {
    log.error(`扩展装载失败（不影响机器人本体）：${error?.message ?? error}`);
  }

  const server = createApiServer({
    client,
    llm,
    chat,
    life,
    scheduler,
    qzone,
    qzoneScheduler,
    budgetGate,
    extensions,
    paths,
    log,
    control,
    tb,
  });

  let listenError = null;
  // 重启拉起来的新实例：老实例可能还没把端口放开，等一会儿再绑，避免「重启后没有控制面板」
  if (TAKEOVER) {
    const portDeadline = Date.now() + 20000;
    while (Date.now() < portDeadline && (await isPortListening(apiPort, apiHost))) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  await server.listen(apiPort, apiHost).catch((error) => {
    listenError = String(error?.message ?? error);
  });
  if (listenError) {
    log.error(`控制面板启动失败（端口 ${apiPort} 可能被占用）：${listenError}`);
    log.error("可以改「心语设置.json」里的面板端口，或者直接让机器人继续跑（QQ 功能不受影响）");
  } else {
    log.info(`控制面板已就绪：http://${apiHost}:${apiPort}`);
  }

  // 先把协议端安排好，再连 QQ：否则用户只看到「未连接」，不知道是协议端没起
  if (!accountConfigured) {
    log.info("首次配置模式：暂不连接 QQ 或启动协议端");
  } else if (settingsNow.autoStartProtocol !== false) {
    try {
      const protocol = await ensureProtocol({ autoStart: true });
      if (protocol.ok) {
        log.info(protocol.action === "none" ? "协议端已在运行" : "已自动启动协议端");
      } else {
        log.warn(`协议端没准备好：${protocol.message}`);
        log.warn("面板「运行环境」页可以一键启动／诊断，不影响面板本身打开");
      }
    } catch (error) {
      log.warn(`检查协议端时出错：${error?.message ?? error}`);
    }
  } else {
    const quick = await diagnoseProtocol();
    if (!quick.running) log.warn(`协议端没在运行（${quick.nextAction}）；自动启动已关闭`);
  }

  if (accountConfigured) {
    client.start();
    scheduler.start();
    qzoneScheduler.start();
  }

  // 天气：启动时先把缓存预热一次，这样聊天里她随时能提到「今天下雨」（失败的代价只是没有天气，不影响别的）
  if (getConfig().weather?.enabled !== false) {
    fetchWeather()
      .then((data) => {
        if (data?.ok) log.info(`天气已就绪：${summarizeWeather(data)}`);
        else log.debug(`天气没取到（不影响聊天）：${data?.error ?? "未知原因"}`);
      })
      .catch((error) => log.debug(`天气预取出错（不影响聊天）：${error?.message ?? error}`));
  }
  const lifeTimer = setInterval(() => {
    if (pauseState.paused) return;
    const now = getConfig();
    if (now.life?.archive?.enabled === false) return;
    if (now.nextMemory.enabled) return;
    const hour = new Date().getHours();
    const from = Number(now.life?.archive?.fromHour ?? 7);
    const to = Number(now.life?.archive?.toHour ?? 23);
    if (hour < from || hour > to) return;
    archiveOnce({ llm, character: activeCharacter(), masterId: now.bot.masterId, masterName: now.bot.masterName, limit: 1 }).catch((error) =>
      log.warn(`定时归档失败：${error?.message ?? error}`),
    );
  }, Math.max(10, Number(cfg.life?.archive?.everyMinutes) || 120) * 60000);
  lifeTimer.unref?.();
  const extendedTimer = setInterval(() => {
    if (pauseState.paused) return;
    archiveExtendedDaily(llm).catch((error) => log.warn(`每日记忆归档失败：${error.message}`));
    for (const [gid, settings] of Object.entries(getConfig().tb.groups)) {
      if (getConfig().tb.enabled && settings.enabled && settings.source !== "custom") tb.refreshRules(gid).catch(() => {});
    }
  }, 300000);
  extendedTimer.unref?.();
  if (getConfig().nextMemory.enabled && memoryConsentValid() && getConfig().nextMemory.baseUrl.replace(/\/$/, "") === "http://127.0.0.1:8888") {
    startManagedHindsight().catch((error) => log.warn(`记忆服务未启动，继续使用本地能力：${error.message}`));
  }

  const diaryTimer = setInterval(() => {
    const now = getConfig();
    if (now.life?.diary?.enabled === false) return;
    if (now.nextMemory.enabled) return;
    const [hour, minute] = String(now.life?.diary?.at ?? "22:30").split(":").map(Number);
    const date = new Date();
    if (date.getHours() !== hour || date.getMinutes() < minute) return;
    const key = `diary:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (!claimEventKey(key)) return;
    writeDiary({ llm, character: activeCharacter(), masterId: now.bot.masterId, masterName: now.bot.masterName }).catch((error) =>
      log.warn(`定时写日记失败：${error?.message ?? error}`),
    );
  }, 60000);
  diaryTimer.unref?.();

  /*
   * 桌面形态：
   *   打包成 exe（双击启动）→ 默认「托盘 + 面板窗口」，关掉窗口只是缩进托盘，后台继续跑；
   *   跑源码 → 只打印地址（开发方便），加 --tray 才弹窗口 + 托盘。
   *   --no-panel 只起托盘，--no-tray 只弹窗口不进托盘。
   */
  const desktopMode = TRAY || isSea || isInstalled;
  const wantTray = !NO_TRAY && desktopMode;
  const wantWindow = !NO_PANEL && (OPEN_PANEL || (desktopMode && settingsNow.openPanelOnStart !== false));

  // 托盘先起来：这样即使窗口打不开，用户也有地方点「打开控制面板」和「退出心语」
  if (wantTray) {
    const tray = startTray({ panelUrl: `http://${apiHost}:${apiPort}`, browser: findBrowser() });
    if (tray.ok) {
      log.info("托盘图标已就位（双击打开控制面板，右键可以重启 / 退出）");
      const ready = await waitTrayReady(tray.logFile, 6000);
      if (ready) log.info("托盘已确认就位");
      else log.warn(`托盘可能没起来，看看 ${tray.logFile}`);
    } else {
      log.warn(`托盘没起来：${tray.error}（不影响机器人本体）`);
    }
  }

  if (wantWindow && !listenError) {
    const opened = openPanelWindow(`http://${apiHost}:${apiPort}`);
    if (!opened.ok) log.warn(`没能自动打开窗口，请手动访问 http://${apiHost}:${apiPort}`);
  } else if (!listenError) {
    log.info(`控制面板地址：http://${apiHost}:${apiPort}（加 --tray 会缩进托盘并弹窗口）`);
  }

  const shutdown = async (signal, options = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${signal}，正在退出…`);
    try {
      chat.stop();
      tb.stop();
      clearInterval(extendedTimer);
      scheduler.stop();
      qzoneScheduler.stop();
      extensions.dispose();
      clearInterval(lifeTimer);
      clearInterval(diaryTimer);
      server.close();
      client.stop();
      // 重启时把协议端留着（省一次重新登录的等待），彻底退出时才一起关掉，
      // 否则用户点「退出心语」之后后台还挂着一个 QQ 连接，不知道该怎么收场。
      if (!options.keepProtocol) {
        const stopped = await stopProtocol();
        if (stopped.stopped) log.info("已顺便停掉心语自己拉起来的协议端");
      }
      backup("on-exit");
      closeDb();
      releaseLock();
      // 把「这个 QQ 号被我占着」的占位删掉，否则别的实例永远起不来
      try {
        const { releaseAccountClaim } = await import("./lib/instances.mjs");
        if (accountConfigured) releaseAccountClaim(bootCfg.bot.selfId);
      } catch (error) {
        log.debug(`释放账号占位失败（占位里的进程已退出，会被下次启动自动忽略）：${error?.message ?? error}`);
      }
    } catch (error) {
      log.warn(`退出时出错：${error?.message ?? error}`);
    }
    setTimeout(() => process.exit(0), 200);
  };
  shutdownFn = shutdown;
  process.on("SIGINT", () => shutdown("收到 SIGINT"));
  process.on("SIGTERM", () => shutdown("收到 SIGTERM"));
  process.on("uncaughtException", (error) => log.error(`未捕获异常：${error?.stack ?? error}`));
  process.on("unhandledRejection", (error) => log.error(`未处理的 Promise 拒绝：${redactText(String(error?.stack ?? error))}`));

  log.info(`${character.name}已就位，等对方开口呢～`);
}

main().catch((error) => {
  log.error(`启动失败：${error?.stack ?? error}`);
  closeDb();
  process.exitCode = 1;
}).finally(() => {
  const owned = globalThis.__HEARTECHO_SELFTEST_OWNED;
  if (owned && !has("--keep") && path.dirname(owned) === path.resolve(os.tmpdir()) && path.basename(owned).startsWith("heartecho-selftest-")) {
    try { fs.rmSync(owned, { recursive: true, force: true }); } catch { /* 临时目录可稍后清理 */ }
  }
});
