/**
 * 真实端到端测试：在真实的 QQ 上验证整条链路。
 *
 * 仓库里**不写任何真实 QQ 号或令牌**，所以三个号都必须你自己传进来。
 *
 * 三个角色（都在本机可验证）：
 *   --bot          机器人号（协议端已接管）
 *   --peer         机器人要主动联系的人（你的号，是它的好友）
 *   --probe        本机另一个已登录、能主动给机器人发消息的号
 *   --probe-ws     这个号自己的 OneBot 地址（默认 ws://127.0.0.1:3001/）
 *   --probe-token  这个号 OneBot 的 accessToken（没有就留空）
 *
 * 为什么要分「peer」和「probe」：
 *   协议端只能替「本机登录的 QQ 号」发消息。要让机器人收到一条真实私聊，
 *   发消息的必须是本机另一个已登录的号；而机器人主动发消息则可以发给任意好友（比如 --peer）。
 *   两条方向都测，才算真的端到端。
 *
 * 用法：
 *   node tools/e2e-live.mjs --bot 机器人号 --peer 你的号 --probe 另一个号 \
 *        --probe-ws ws://127.0.0.1:3001/ --probe-token <令牌>
 *   node tools/e2e-live.mjs ... --skip-send   只做只读检查，不发消息
 *
 * 也可以用环境变量：E2E_BOT / E2E_PEER / E2E_PROBE / E2E_PROBE_WS / E2E_PROBE_TOKEN
 */
import path from "node:path";

const ARGS = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = ARGS.indexOf(flag);
  return index >= 0 ? String(ARGS[index + 1] ?? "").trim() : fallback;
};
const SKIP_SEND = ARGS.includes("--skip-send");

/** 必须由使用者提供的东西：缺了就打印用法直接退出，绝不猜一个号出来。 */
function need(flag, envName, optional = "") {
  const value = argValue(flag, "") || String(process.env[envName] || "").trim();
  if (value) return value;
  if (optional) return optional;
  console.error(
    [
      `缺少参数 ${flag}（也可以用环境变量 ${envName} 提供）。`,
      "",
      "用法：",
      "  node tools/e2e-live.mjs --bot <机器人QQ> --peer <你的QQ> --probe <本机另一个已登录的QQ> \\",
      "       [--probe-ws ws://127.0.0.1:3001/] [--probe-token <该号协议端令牌>] [--skip-send]",
      "",
      "三个号的意思见文件开头的说明。仓库里不保存任何真实 QQ 号或令牌。",
    ].join("\n"),
  );
  process.exit(2);
}

const PANEL = argValue("--panel", "http://127.0.0.1:5311");
const BOT = need("--bot", "E2E_BOT");
const PEER = need("--peer", "E2E_PEER");
const PROBE = need("--probe", "E2E_PROBE");
const PROBE_WS = argValue("--probe-ws", "") || String(process.env.E2E_PROBE_WS || "").trim() || "ws://127.0.0.1:3001/";
const PROBE_TOKEN = argValue("--probe-token", "") || String(process.env.E2E_PROBE_TOKEN || "").trim();

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发消息用的通道，main 里赋值后 askAndConfirm 等辅助函数也会用到。 */
let probe = null;

/**
 * 只评估「本次测试开始之后」产生的数据。
 * 这样在已经有真实聊天记录的实例上跑测试，也不会把历史数据算进结论里。
 */
const RUN_STARTED = Date.now();


function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail: String(detail ?? "") });
  console.log(`${ok ? "✓" : "✗"} ${id} ${name}${detail ? `  · ${detail}` : ""}`);
}

async function panel(pathname, body, method) {
  const res = await fetch(PANEL + pathname, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/** 本机另一个已登录号（probe）的 OneBot 通道：用来替「对方」发消息。 */
class ProbeBot {
  constructor() {
    this.ws = null;
    this.echo = 0;
    this.pending = new Map();
    this.inbox = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(PROBE_WS, { headers: PROBE_TOKEN ? { Authorization: `Bearer ${PROBE_TOKEN}` } : undefined });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("连不上 probe 号（协议端没起或令牌不对）")), 12000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket 连接出错"));
      });
      ws.addEventListener("message", (event) => {
        let payload;
        try {
          payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }
        if (payload.echo !== undefined && this.pending.has(payload.echo)) {
          const { resolve: done, reject: fail } = this.pending.get(payload.echo);
          this.pending.delete(payload.echo);
          if (payload.status === "failed" || (payload.retcode ?? 0) !== 0) fail(new Error(payload.message || payload.wording || "调用失败"));
          else done(payload.data ?? payload);
          return;
        }
        if (payload.post_type === "message") this.inbox.push({ at: Date.now(), event: payload });
      });
    });
  }

  call(action, params = {}, timeoutMs = 20000) {
    const echo = `e2e${++this.echo}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  send(text) {
    return this.call("send_private_msg", { user_id: Number(BOT), message: text });
  }

  async waitForReply(since, { timeoutMs = 90000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hits = this.inbox.filter(
        (item) =>
          item.at > since &&
          item.event.post_type === "message" &&
          item.event.message_type === "private" &&
          String(item.event.user_id) === String(BOT),
      );
      if (hits.length) {
        return hits.map((item) => ({
          at: item.at,
          text: (item.event.message ?? [])
            .map((seg) => (seg.type === "text" ? seg.data.text : seg.type === "image" ? "[图片]" : seg.type === "face" ? "[表情]" : ""))
            .join(""),
        }));
      }
      await sleep(700);
    }
    return [];
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从机器人自己的对话记录里读回复。
 *
 * 为什么不能只靠 WebSocket 收回复：测试同时开了第二个 OneBot 连接（替对方号发消息），
 * 协议端对同一个账号的多个连接不一定把事件推给每一条，所以偶尔会漏收。
 * 机器人自己落库的记录才是权威判据——它既证明「收到了」，也证明「回了」。
 */
async function repliesFromServer(sinceMs) {
  const conv = await panel(`/api/conversation?key=private_${PROBE}&limit=30`);
  return (conv.messages ?? [])
    .filter((m) => m.direction === "out" && Number(m.at) > sinceMs)
    .map((m) => ({ at: Number(m.at), text: String(m.body ?? "") }));
}

/**
 * 发一条消息并确认她回了：先看 WebSocket，再回退到服务端记录。
 * 都不行就补发一次（协议端偶发丢事件），最后如实报告失败。
 */
async function askAndConfirm(text, { label, timeoutMs = 90000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    let attempted = false;
    try {
      await probe.send(text);
      attempted = true;
    } catch (error) {
      console.log(`（${label}：第 ${attempt} 次发送失败 —— ${String(error?.message ?? error).slice(0, 80)}）`);
    }
    if (attempted) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const fromServer = await repliesFromServer(started);
        if (fromServer.length) return { ok: true, replies: fromServer, source: "服务端记录", attempt };
        const fromWs = await probe.waitForReply(started, { timeoutMs: 1000 });
        if (fromWs.length) return { ok: true, replies: fromWs, source: "WebSocket", attempt };
        await sleep(1500);
      }
    }
    if (attempt === 1) console.log(`（${label}：没等到回复，补发一次）`);
  }
  return { ok: false, replies: [], source: "", attempt: 2 };
}

async function main() {
  console.log("=== 心语 · 真实端到端测试 ===");
  console.log(`控制面板：${PANEL}`);
  console.log(`机器人：${BOT}｜主动联系对象：${PEER}｜用于发消息的另一号：${PROBE}`);
  console.log(SKIP_SEND ? "（只读模式：不会发送任何消息）\n" : "");

  const status = await panel("/api/status");
  if (!status.ok) throw new Error("控制面板没有响应，先确认心语在跑");
  record("E2E-00", "控制面板可访问", true, `版本 ${status.version}｜已运行 ${status.uptimeSec}s`);

  const online = Boolean(status.onebot?.online);
  record("E2E-01", "机器人已连上 QQ", online, online ? `${status.onebot.nickname}（${status.onebot.selfId}）` : "未连接：先启动协议端并确认 QQ 登录");
  if (!online) return summary();

  record("E2E-02", "模型接口就绪", Boolean(status.llm?.ready), `${status.llm?.providerName} · ${status.llm?.model}`);

  const ping = await panel("/api/onebot/ping", {});
  record("E2E-03", "OneBot 动作接口可用", Boolean(ping.ok), ping.ok ? `get_login_info 正常（${ping.info?.nickname}）` : ping.error);

  const caps = await panel("/api/onebot/capabilities", {});
  const verified = Object.entries(caps.capabilities ?? {}).filter(([, v]) => v === "api_verified").length;
  record("E2E-04", "协议端能力探测", verified >= 4, `${verified} 项接口可用`);

  const friends = await panel("/api/onebot/friends", {});
  const friendOk = (friends.friends ?? []).some((f) => String(f.userId) === PEER);
  record("E2E-05", `机器人好友里有 ${PEER}`, friendOk, `共 ${(friends.friends ?? []).length} 个好友`);

  await panel("/api/groups/action", { action: "unblock", scope: "global", groupId: "*", peerId: PROBE });
  await panel("/api/policy/pause", { paused: false, reason: "端到端测试前恢复" });

  /* ------------------- 方向一：机器人主动发给「你的号」 ------------------- */

  if (!SKIP_SEND) {
    const post = await panel("/api/onebot/send", { userId: PEER, text: `[自检] ${new Date().toLocaleTimeString("zh-CN")} 这条是自动化测试发出的。` });
    record("E2E-06", `机器人能主动给 ${PEER} 发消息`, Boolean(post.ok), post.ok ? `message_id=${post.message_id}` : post.message);

    const convPeer = await panel(`/api/conversation?key=private_${PEER}&limit=10`);
    record("E2E-07", "发给对方的消息也记进了对话记录", (convPeer.messages ?? []).some((m) => m.direction === "out" && String(m.body).includes("[自检]")), `本会话 ${(convPeer.messages ?? []).length} 条`);
  }

  /* ------------- 方向二：对方发来消息，机器人按角色回话 ------------- */

  probe = new ProbeBot();
  try {
    await probe.connect();
    record("E2E-08", "另一号 OneBot 通道已连接", true, `可替 ${PROBE} 发消息`);
  } catch (error) {
    record("E2E-08", "另一号 OneBot 通道已连接", false, String(error.message));
    return summary();
  }

  // 频率闸门里有「两次回复最小间隔」（默认 15 秒）和「每人每小时/每天」的限额。
  // e2e 会在几分钟内连发十几条，很容易把真实账号的额度烧光（然后整轮假失败）。
  // 所以测试期间临时把闸门放宽，跑完立刻恢复——测的是功能，不是限流本身。
  const rateConfig = (await panel("/api/groups")).rate ?? {};
  const relaxRate = async () => {
    await panel("/api/config", {
      group: {
        rate: {
          ...rateConfig,
          minGapSeconds: 0,
          perUserPerHour: 0,
          perUserPerDay: 0,
          perGroupPerHour: 0,
          perGroupPerDay: 0,
          globalPerDay: 0,
          maxConsecutive: 0,
        },
      },
    });
  };
  const restoreRate = async () => {
    await panel("/api/config", { group: { rate: rateConfig } }).catch(() => {});
    console.log("（频率闸门已恢复原设置）");
  };

  // 「追一句」是按概率触发的主动消息，会让「这一轮新增几条消息」的断言偶发失败。
  // 测功能的时候把它关掉，跑完恢复——不然这条链路上会有一层随机性。
  const followUpBefore = (await panel("/api/style")).chat?.followUp ?? { enabled: true };
  const silenceFollowUp = async () => {
    await panel("/api/style", { followUp: { ...followUpBefore, enabled: false } }).catch(() => {});
  };
  const restoreFollowUp = async () => {
    await panel("/api/style", { followUp: followUpBefore }).catch(() => {});
    console.log("（追一句功能已恢复原设置）");
  };

  /** 自检用：确认放宽之后闸门确实是开的（不然整轮都会假失败）。 */
  async function assertGateOpen() {
    const simulated = await panel("/api/policy/simulate", { scopeKey: `private_${PROBE}`, senderId: PROBE, text: "闸门探测" });
    return { open: simulated.decision === "reply", detail: `${simulated.decision}${simulated.reason ? "：" + simulated.reason : ""}` };
  }

  if (!SKIP_SEND) {
    // 测试期间临时放宽限流，避免把真实账号的每小时额度烧光（跑完会恢复）
    await relaxRate();
    await silenceFollowUp();
    const gate = await assertGateOpen();
    record("E2E-08b", "测试期间频率闸门已放宽", gate.open, `闸门探测：${gate.detail}`);

    const marker = `端到端测试${Date.now().toString(36)}`;
    const first = await askAndConfirm(`[${marker}] 你好，这是自动化测试发来的消息`, { label: "第一轮私聊" });
    record("E2E-09", "成功发出私聊消息并收到回复", first.ok, first.ok ? `回复来源：${first.source}（第 ${first.attempt} 次发送）` : "两次发送都没等到回复");
    record("E2E-10", "机器人私聊回了话", first.ok, first.replies.map((r) => r.text).join(" / ").slice(0, 160) || "没有回复");

    const conv = await panel(`/api/conversation?key=private_${PROBE}&limit=40`);
    const all = conv.messages ?? [];
    const now = all.filter((m) => Number(m.at) >= RUN_STARTED);
    record("E2E-11", "消息按会话落库", now.some((m) => String(m.body).includes(marker)), `本次新增 ${now.length} 条 / 该会话共 ${all.length} 条`);
    record("E2E-12", "回复也写进了对话记录", now.some((m) => m.direction === "out" && String(m.body).length > 0));

    /* ----------------------- 「记住」与作用域隔离 ----------------------- */


    const fact = `我不吃香菜（${Date.now().toString(36)}）`;
    const factResult = await askAndConfirm(`记住：${fact}`, { label: "记住指令" });
    record("E2E-13", "「记住：…」有回应", factResult.ok, factResult.replies.map((r) => r.text).join(" ").slice(0, 90) || "没有回应");

    const memory = await panel("/api/memory");
    const fresh = (memory.items ?? []).filter((item) => Number(item.at) >= RUN_STARTED);
    const mine = fresh.filter((item) => item.scope_key === `private_${PROBE}`);
    record("E2E-14", "事实写进了这个会话的记忆", mine.length > 0, `本次新增 ${mine.length} 条：${mine.map((m) => m.content).join("｜").slice(0, 70)}`);

    const others = fresh.filter((item) => item.scope_key !== `private_${PROBE}`);
    record("E2E-15", "新记忆没有串到别的会话", others.length === 0, others.length ? `越界：${others.map((m) => m.scope_key).join(",")}` : "隔离正确");

    const recall = await panel("/api/memory/recall", { scopeKey: `private_${PROBE}`, query: "香菜", subjectId: PROBE });
    record("E2E-16", "按关键词能检索到", (recall.items ?? []).length > 0, `命中 ${(recall.items ?? []).length} 条`);

    const cross = await panel("/api/memory/recall", { scopeKey: "private_999999999", query: "香菜", subjectId: "999999999" });
    record("E2E-17", "换个会话检索不到", (cross.items ?? []).length === 0, "跨会话隔离有效");

    /* --------------------------- 多轮对话 --------------------------- */

    const food = await askAndConfirm("我晚上想吃点什么好呢", { label: "第二轮对话" });
    record("E2E-18", "第二轮对话仍正常回复", food.ok, food.replies.map((r) => r.text).join(" ").slice(0, 120) || "没有回复");
  }

  /* ------------------------- 判定审计与记账 ------------------------- */

  const decisions = await panel("/api/decisions");
  record("E2E-19", "记录了准入判定过程", (decisions.decisions ?? []).length > 0, `最近 ${(decisions.decisions ?? []).length} 条判定`);

  const simulate = await panel("/api/policy/simulate", { scopeKey: `private_${PROBE}`, text: "在吗", senderId: PROBE });
  record("E2E-20", "面板可模拟判定", Boolean(simulate.trace), `结果：${simulate.decision}（${simulate.reason || "通过"}）`);

  const llm = await panel("/api/llm");
  const calls = llm.usage?.totals?.calls ?? 0;
  record("E2E-21", "模型调用被记账", calls > 0, `${calls} 次调用，估算 ${Number(llm.usage?.totals?.cost ?? 0).toFixed(4)} 元`);
  record("E2E-22", "预算闸门有上限", (llm.budget?.scopes ?? []).some((s) => s.limit > 0), (llm.budget?.scopes ?? []).filter((s) => s.limit > 0).map((s) => `${s.label} ${s.limit}`).join("｜"));

  /* --------------------------- 拉黑闭环 --------------------------- */

  if (!SKIP_SEND) {
    await panel("/api/groups/action", { action: "block", scope: "global", groupId: "*", peerId: PROBE, reason: "端到端测试" });
    await sleep(1000);
    const beforeCalls = (await panel("/api/llm")).usage?.totals?.calls ?? 0;
    const blockedSince = Date.now();
    await probe.send("拉黑之后我应该收不到回复了").catch(() => {});
    // 黑名单场景反过来：要确认「服务端没有产生任何出站」。给它足够时间真的处理这条消息。
    await sleep(20000);
    const blockedReply = await probe.waitForReply(blockedSince, { timeoutMs: 5000 });
    const blockedOutbound = await repliesFromServer(blockedSince);
    const noReply = blockedReply.length === 0 && blockedOutbound.length === 0;
    record(
      "E2E-23",
      "黑名单里收不到任何回复",
      noReply,
      noReply ? "符合预期（WebSocket 与服务端记录都是零出站）" : `居然回了：${[...blockedReply, ...blockedOutbound].map((r) => r.text).join(" / ").slice(0, 80)}`,
    );

    const afterCalls = (await panel("/api/llm")).usage?.totals?.calls ?? 0;
    record("E2E-24", "黑名单消息没有产生模型费用", afterCalls === beforeCalls, `调用数 ${beforeCalls} → ${afterCalls}`);

    const audit = await panel("/api/policy/audit");
    record("E2E-25", "黑名单已登记在案", (audit.blocklist ?? []).some((b) => String(b.peer_id) === PROBE), `共 ${(audit.blocklist ?? []).length} 条`);

    await panel("/api/groups/action", { action: "unblock", scope: "global", groupId: "*", peerId: PROBE });
    await sleep(800);
    // 解除后还要等闸门放开，否则测到的是限流而不是「解除黑名单能不能回」
    const restored = await askAndConfirm("现在应该能正常说话了", { label: "解除黑名单后" });
    record("E2E-26", "解除黑名单后可以正常回复", restored.ok, restored.replies.map((r) => r.text).join(" ").slice(0, 110) || "没有回复");

    /* ---------------------------- 主动消息 ---------------------------- */

    const greet = await panel("/api/schedule/greet", { kind: "proactive", userId: PEER });
    record("E2E-27", "主动消息能真的发出去", Boolean(greet.sent), greet.sent ? `发出：${String(greet.sent.text).replace(/\n/g, " ").slice(0, 80)}` : "没发出去，看面板日志");

    const sandbox = await panel("/api/chat/sandbox", { text: "在吗，试一下不会发到 QQ 的那种" });
    record("E2E-28", "面板试聊可用且不发送", Array.isArray(sandbox.bubbles) && sandbox.bubbles.length > 0, (sandbox.bubbles ?? []).join(" / ").slice(0, 100));

    // 不管上面走到哪一步，都要把用户原本的频率设置还回去
    await restoreRate();
    await restoreFollowUp();
  }

  /* ----------------------------- 空间与系统 ----------------------------- */

  const qz = await panel("/api/qzone/check", {});
  record("E2E-29", "QQ 空间自检可执行", (qz.report?.steps ?? []).length > 0, qz.report?.conclusion?.slice(0, 100) ?? "");

  const sys = await panel("/api/system");
  record("E2E-30", "数据库完整性正常", sys.runtime?.integrity?.ok === true, sys.runtime?.integrity?.value);
  const backup = await panel("/api/system/backup", {});
  record("E2E-31", "可以一键备份", Boolean(backup.ok), backup.file ? path.basename(backup.file) : backup.error);

  probe.close();
  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(62));
  console.log(`真实端到端测试：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log("未通过：");
    for (const item of failed) console.log(`  ${item.id} ${item.name} —— ${item.detail}`);
  }
  console.log("═".repeat(62));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error("端到端测试崩了：", error?.stack ?? error);
  process.exitCode = 2;
});
