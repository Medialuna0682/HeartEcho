/**
 * 本地控制 API（默认回环监听，敏感接口必须授权）。
 *
 * 安全约束（规划书 16.3）：
 *   - 默认只监听 127.0.0.1，不暴露到公网
 *   - 对外输出配置时 API Key 一律打码，并且再也不会回传到前端
 *   - 所有写操作走同一个 JSON 入口，非法字段直接在服务端拒绝
 */
import http from "node:http";
import { nextApi } from "./next-api.mjs";
import { panelToken, panelCookie, checkPanelRequest } from "./panel-auth.mjs";
import { otherEditionStatus } from "./edition-safety.mjs";
import { APP_VERSION } from "./version.mjs";
import fs from "node:fs";
import path from "node:path";
import { getConfig, saveConfig, listCharacters, loadCharacter, saveCharacter, deleteCharacter, newCharacterId, cloneCharacter, activeCharacterId, CHARACTER_FIELDS, LOCKABLE_FIELDS, USER_FIELDS, replyStyle, LENGTH_PRESETS, ACTIVITY_PRESETS } from "./config.mjs";
import { PROVIDERS, TASK_TYPES, findProvider, guessProviderId } from "./providers.mjs";
import { all, one, run, backup, integrityCheck, audit } from "./db.mjs";
import {
  listSessions,
  getSession,
  recentMessages,
  scopeLabel,
  resolveMemberPolicy,
  upsertMemberPolicy,
  groupMembers,
  allGroups,
  upsertGroupMember,
  storageStats,
} from "./storage.mjs";
import {
  listMemories,
  addManualMemory,
  updateMemory,
  deleteMemory,
  retractMemory,
  memoryStats,
  MEMORY_CATEGORIES,
  SOURCE_TYPES,
  retrieveMemories,
} from "./memory.mjs";
import { lifeSnapshot, archiveOnce, writeDiary, reflect, addSimulatedExperience, listGoals, closeGoal, listExperiences, listReflections, listDiary, updateRelationship, promptBlock } from "./life.mjs";
import { privateUserProfile } from "./privacy.mjs";
import { runJob, listJobs, getJob, runningKinds, runningJob } from "./jobs.mjs";
import { buildSystemPrompt, userProfileLines } from "./llm.mjs";
import { usageReport, checkBudget } from "./budget.mjs";
import { ACTION, gate, pauseState, blockPeer, unblockPeer, listBlocklist, listWarnings, resetWarnings, hitFilter, rateSnapshot, checkBlocked } from "./policy.mjs";
import { listReminders, addReminder, updateReminder, deleteReminder, addBirthday, deleteBirthday, listBirthdays, OCCASIONS, todayHolidays } from "./scheduler.mjs";
import { protocolStatus, syncProtocolConfig, recentProtocolLogs, describeHealth, listAccountConfigs, ensureAccountConfig } from "./health.mjs";
import { weatherStatus, clearCache as clearWeatherCache, cachedSummary, cachedWeatherBlock, recordWeatherFeedback, clearWeatherFeedback, weatherFeedbackStatus, weatherFeedbackBlock, isWeatherMuted } from "./weather.mjs";
import { recoverMissedMessages } from "./recovery.mjs";
import { diagnoseProtocol, ensureProtocol, startProtocol, restartProtocol, readLogTail, protocolRuntimeInfo } from "./protocol.mjs";
import { listInstances, createInstance, startInstance, deleteInstance, probeInstance, instancePanelUrl, registryFile, dataDirOf, sharedProtocolDir } from "./instances.mjs";
import { autostartStatus, setAutostart, relaunchSelf, openPanelWindow, findBrowser } from "./desktop.mjs";
import { onLog, recentLogs, getLogLevel, setLogLevel, maskSecret } from "./log.mjs";
import { paths, loadSettings, saveSettings, isSea } from "./paths.mjs";
import { ui } from "./ui.mjs";
import { activeCharacter } from "./config.mjs";

function json(res, code, body) {
  const text = JSON.stringify(body, (key, value) => (key === "apiKey" ? undefined : value));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 对外配置：去掉所有明文密钥，只保留提示。 */
export function publicConfig() {
  const cfg = structuredClone(getConfig());
  const profiles = cfg.llm?.profiles ?? {};
  for (const [id, profile] of Object.entries(profiles)) {
    const key = profile.apiKey ?? "";
    profile.hasApiKey = Boolean(key);
    profile.apiKeyHint = key ? `${String(key).slice(0, 6)}…${String(key).slice(-4)}` : "";
    profile.apiKey = "";
  }
  return cfg;
}

export function createApiServer(ctx) {
  const { client, llm, chat, scheduler, qzone, qzoneScheduler, budgetGate, log, control, extensions } = ctx;
  const sseClients = new Set();
  const startedAt = Date.now();
  const token = panelToken();
  const publicMember = (member, cfg) => {
    const policy = resolveMemberPolicy({ characterId: cfg.activeCharacter, groupId: member.group_id, peerId: member.peer_id });
    const blocked = checkBlocked({ kind: "group", groupId: member.group_id, peerId: member.peer_id, characterId: cfg.activeCharacter });
    return {
      peerId: member.peer_id, nickname: member.nickname, card: member.card, role: member.role, level: member.level,
      left: Boolean(member.left_at), syncAt: member.sync_at, attitude: policy.attitude, note: policy.note,
      nicknameOverride: policy.nickname, mute: Boolean(policy.mute), trigger: policy.trigger, replyChance: policy.replyChance,
      blocked: blocked.blocked, blockedReason: blocked.row?.reason ?? "",
      quota: rateSnapshot({ kind: "group", groupId: member.group_id, peerId: member.peer_id }),
    };
  };
  let listenHost = "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    const denied = checkPanelRequest(req, { host: listenHost, port: server.address()?.port, token });
    if (denied) return json(res, denied.code, { ok: false, message: denied.message });
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (url.pathname.startsWith("/api/next")) {
        const result = await nextApi({ route, url, body: req.method === "GET" ? {} : await readBody(req), ctx });
        if (result !== null) return json(res, 200, result);
      }
      if (route === "POST /api/panel/session") {
        res.setHeader("Set-Cookie", panelCookie(token));
        return json(res, 200, { ok: true });
      }
      if (route === "GET /" || route === "GET /index.html") {
        const html = ui();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      if (route === "GET /favicon.svg") {
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
        res.end(faviconSvg());
        return;
      }

      /* ------------------------------ 总览 ------------------------------ */

      if (route === "GET /api/status") {
        const cfg = getConfig();
        const character = (() => {
          try {
            return activeCharacter();
          } catch {
            return null;
          }
        })();
        const onebotStatus = { ...client.status, queue: client.queue.length };
        const llmStatus = llm.status();
        const budget = budgetGate.snapshot();
        const groups = allGroups();
        return json(res, 200, {
          ok: true,
          otherEdition: otherEditionStatus(),
          version: APP_VERSION,
          ruleUpdates: Object.entries(cfg.tb.groups).filter(([, settings]) => settings.pendingRules).map(([groupId, settings]) => ({ groupId, fingerprint: settings.pendingRules.fingerprint })),
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          onboarding: cfg.onboarding,
          character: character ? { id: character.id, name: character.name, title: character.title, avatar: character.avatar } : null,
          characters: listCharacters().length,
          bots: {
            selfId: cfg.bot.selfId,
            masterId: cfg.bot.masterId,
            masterName: cfg.bot.masterName,
            panel: `http://${cfg.bot.panelHost}:${cfg.bot.panelPort}`,
          },
          onebot: onebotStatus,
          llm: llmStatus,
          budget,
          chat: {
            busy: chat.snapshot().busy.length,
            merging: chat.snapshot().merging,
            lastReply: chat.snapshot().lastReply,
            replyPrivate: cfg.chat.replyPrivate,
            replyGroupAt: cfg.chat.replyGroupAt,
          },
          style: replyStyle(),
          weather: cachedSummary(),
          paused: pauseState.snapshot(),
          storage: storageStats(),
          groups: groups.length,
          memory: memoryStats(),
          schedule: {
            lastTickAt: scheduler.snapshot().lastTickAt,
            lastSent: scheduler.snapshot().active,
            reminders: scheduler.snapshot().reminders.filter((item) => item.enabled).length,
            automationMode: cfg.greet?.automationMode,
          },
          qzone: { enabled: cfg.qzone?.enabled === true, mode: qzoneScheduler.status().mode, capabilities: qzone.snapshot().capabilities },
          health: describeHealth({ onebotStatus, llmStatus, budget }),
          paths: { data: paths.data, logs: paths.logs, characters: paths.characters, database: paths.database },
        });
      }

      if (route === "GET /api/health") {
        const budget = budgetGate.snapshot();
        return json(res, 200, { ok: true, ...describeHealth({ onebotStatus: client.status, llmStatus: llm.status(), budget }) });
      }

      if (route === "GET /api/logs") {
        return json(res, 200, { ok: true, level: getLogLevel(), logs: recentLogs(Number(url.searchParams.get("limit")) || 300) });
      }

      if (route === "POST /api/logs/level") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, level: setLogLevel(body.level) });
      }

      if (route === "GET /api/logs/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const send = (entry) => {
          try {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
          } catch {
            /* ignore */
          }
        };
        for (const entry of recentLogs(80)) send(entry);
        const off = onLog(send);
        sseClients.add(res);
        const keep = setInterval(() => res.write(": ping\n\n"), 25000);
        keep.unref?.();
        req.on("close", () => {
          clearInterval(keep);
          off();
          sseClients.delete(res);
        });
        return;
      }

      /* ------------------------------ 首次引导 ------------------------------ */

      if (route === "GET /api/onboarding") {
        const cfg = getConfig();
        const protocol = protocolStatus();
        const character = activeCharacter();
        const steps = {
          character: Boolean(character?.name && character?.persona && character.name !== "未命名"),
          model: llm.status().ready,
          qq: Boolean(protocol.configFound) && Boolean(cfg.bot.selfId),
          peer: Boolean(cfg.bot.masterId),
          privacy: cfg.onboarding?.steps?.privacy === true,
        };
        // 四件事都齐了就直接算完成：引导是给「还没配好」的人看的，
        // 已经配好的机器每次打开面板还弹一遍，等于把人挡在外面。
        // 但「重新走一遍引导」之后要能真的再弹出来，所以 reopenedAt 会盖掉这个自动完成。
        const configured = steps.character && steps.model && steps.qq && steps.peer;
        const reopened = Boolean(cfg.onboarding?.reopenedAt);
        return json(res, 200, {
          ok: true,
          done: cfg.onboarding?.done === true || (configured && !reopened),
          snoozed: Boolean(cfg.onboarding?.snoozedAt),
          steps,
          protocol,
          providers: PROVIDERS.map((provider) => ({ ...provider })),
          taskTypes: TASK_TYPES,
          suggestions: {
            selfId: cfg.bot.selfId,
            masterId: cfg.bot.masterId,
          },
          note: "建议按顺序做完这四步：写角色 → 连模型 → 连 QQ → 填对方 QQ 号。",
        });
      }

      if (route === "POST /api/onboarding/snooze") {
        // 用户点了「以后再说」：记住这个决定，别下次打开面板又弹一次
        const cfg = saveConfig({ onboarding: { ...(getConfig().onboarding ?? {}), snoozedAt: Date.now() } });
        return json(res, 200, { ok: true, onboarding: cfg.onboarding });
      }

      if (route === "POST /api/onboarding/reset") {
        const cfg = saveConfig({ onboarding: { done: false, snoozedAt: 0, steps: {}, reopenedAt: Date.now() } });
        return json(res, 200, { ok: true, onboarding: cfg.onboarding, message: "引导已重新打开，刷新面板就能看到" });
      }

      if (route === "POST /api/onboarding/done") {
        const body = await readBody(req);
        const cfg = saveConfig({
          onboarding: { done: body?.done !== false, completedAt: Date.now(), steps: body?.steps ?? getConfig().onboarding?.steps ?? {}, reopenedAt: 0, snoozedAt: 0 },
        });
        return json(res, 200, { ok: true, onboarding: cfg.onboarding });
      }

      /* ------------------------------ 配置 ------------------------------ */

      if (route === "GET /api/config") return json(res, 200, { ok: true, config: publicConfig(), providers: PROVIDERS, taskTypes: TASK_TYPES });

      if (route === "POST /api/config") {
        const body = await readBody(req) ?? {};
        if (body.nextMemory || body.tb) return json(res, 400, { ok: false, message: "请从扩展功能页保存记忆与 TB 设置" });
        // apiKey 为空字符串表示「不改」，避免前端打码值把真 Key 覆盖掉
        if (body?.llm?.profiles) {
          for (const [id, profile] of Object.entries(body.llm.profiles)) {
            if (profile && typeof profile.apiKey === "string" && profile.apiKey.trim() === "") delete profile.apiKey;
            if (profile && "hasApiKey" in profile) delete profile.hasApiKey;
            if (profile && "apiKeyHint" in profile) delete profile.apiKeyHint;
            if (profile && !profile.provider && profile.baseUrl) profile.provider = guessProviderId(profile.baseUrl);
          }
        }
        const next = saveConfig(body);
        log.info("配置已更新");
        return json(res, 200, { ok: true, config: publicConfig(), activeCharacter: next.activeCharacter });
      }

      if (route === "GET /api/providers") {
        return json(res, 200, { ok: true, providers: PROVIDERS, taskTypes: TASK_TYPES, current: getConfig().llm });
      }

      /* ------------------------------ 插件 / 技能（扩展） ------------------------------ */

      if (route === "GET /api/extensions") {
        const status = extensions?.status?.() ?? { ok: false, message: "扩展宿主没有启动", extensions: [], counts: {}, errors: [] };
        return json(res, 200, { ok: Boolean(status.ok), ...status });
      }

      if (route === "POST /api/extensions/toggle") {
        const body = await readBody(req) ?? {};
        const kind = String(body.kind ?? "");
        const id = String(body.id ?? "").trim();
        if (!["plugins", "skills"].includes(kind) || !id) return json(res, 400, { ok: false, message: "kind 只能是 plugins/skills，id 不能为空" });
        if (!extensions) return json(res, 400, { ok: false, message: "扩展宿主没有启动（--probe 模式不支持）" });
        const enabled = body.enabled !== false;
        const result = await extensions.setEnabled(kind, id, enabled);
        if (result.ok) log.info(`扩展 ${kind}/${id} 已${enabled ? "启用" : "停用"}`);
        const status = extensions.status();
        return json(res, result.ok ? 200 : 400, { ...result, ok: result.ok, ...status });
      }

      if (route === "POST /api/extensions/settings") {
        const body = await readBody(req) ?? {};
        const kind = String(body.kind ?? "");
        const id = String(body.id ?? "").trim();
        if (!["plugins", "skills"].includes(kind) || !id) return json(res, 400, { ok: false, message: "kind 只能是 plugins/skills，id 不能为空" });
        if (!extensions) return json(res, 400, { ok: false, message: "扩展宿主没有启动（--probe 模式不支持）" });
        const result = await extensions.updateSettings(kind, id, body.settings ?? {});
        if (result.ok) log.info(`扩展 ${kind}/${id} 的设置已保存`);
        const status = extensions.status();
        return json(res, result.ok ? 200 : 400, { ...result, ok: result.ok, ...status });
      }

      /* ------------------------------ 角色工作室 ------------------------------ */

      if (route === "GET /api/characters") {
        return json(res, 200, {
          ok: true,
          active: activeCharacterId(),
          fields: CHARACTER_FIELDS,
          lockable: LOCKABLE_FIELDS,
          list: listCharacters().map((id) => {
            try {
              const character = loadCharacter(id);
              return { id, name: character.name, title: character.title, updatedAt: character.updatedAt, version: character.version };
            } catch {
              return { id, name: id };
            }
          }),
        });
      }

      if (route === "POST /api/characters/new") {
        const body = await readBody(req);
        const firstCharacter = listCharacters().length === 0;
        const id = newCharacterId(body?.id || body?.name);
        const character = saveCharacter(id, {
          name: body?.name || "新角色",
          title: body?.title || "",
          persona: body?.persona || "在这里写她是谁、从哪来、平时在做什么。",
          speechStyle: body?.speechStyle || "称呼对方为「你」，语气自然。",
          greeting: body?.greeting || "你好呀，今天过得怎么样呢？",
        }, { create: true });
        if (body?.activate === true || firstCharacter) saveConfig({ activeCharacter: id });
        return json(res, 200, { ok: true, character });
      }

      if (route === "POST /api/characters/clone") {
        const body = await readBody(req);
        const character = cloneCharacter(body.source || activeCharacterId(), body.name);
        return json(res, 200, { ok: true, character });
      }

      if (route.startsWith("GET /api/characters/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        return json(res, 200, {
          ok: true,
          character: loadCharacter(id),
          active: activeCharacterId(),
          fields: CHARACTER_FIELDS,
          userFields: USER_FIELDS,
          lockable: LOCKABLE_FIELDS,
        });
      }

      if (route.startsWith("PUT /api/characters/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const body = await readBody(req);
        const character = saveCharacter(id, body ?? {}, { bumpVersion: body?.bumpVersion === true, requireExisting: true });
        return json(res, 200, { ok: true, character });
      }

      if (route.startsWith("POST /api/characters/") && url.pathname.endsWith("/activate")) {
        const id = decodeURIComponent(url.pathname.split("/").slice(-2)[0]);
        loadCharacter(id);
        saveConfig({ activeCharacter: id });
        return json(res, 200, { ok: true, active: id });
      }

      if (route.startsWith("DELETE /api/characters/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        deleteCharacter(id);
        return json(res, 200, { ok: true, active: activeCharacterId() });
      }

      /* ------------------------------ 试聊与对话 ------------------------------ */

      if (route === "POST /api/chat/sandbox") {
        const body = await readBody(req);
        const images = Array.isArray(body?.images) ? body.images.slice(0, 3) : [];
        const result = await chat.sandbox({ text: body?.text ?? "", images, scopeKey: "panel_sandbox", peerId: body?.peerId });
        return json(res, 200, { ok: true, ...result });
      }

      /*
       * 手动补一遍漏掉的消息。
       * 正常情况连上协议端时已经自动补过；这个按钮是给「我明明发了、面板上没有」的人用的。
       */
      if (route === "POST /api/chat/recover") {
        const body = await readBody(req);
        const result = await recoverMissedMessages({
          client,
          extraPeers: body?.peerId ? [String(body.peerId)] : [],
        });
        const detail = result.results
          .filter((item) => item.added || item.error)
          .map((item) => `${item.peerId}：补回 ${item.added || 0} 条${item.error ? `（${item.error}）` : ""}`);
        return json(res, 200, {
          ok: true,
          added: result.added,
          peers: result.peers,
          results: result.results,
          message: result.added ? `补回了 ${result.added} 条漏掉的消息` : "没有发现漏掉的消息（查了 " + result.peers + " 个会话）",
          detail,
        });
      }

      if (route === "GET /api/conversations") {
        const cfg = getConfig();
        return json(res, 200, {
          ok: true,
          list: listSessions({ limit: 300 }).map((row) => ({
            scopeKey: row.scope_key,
            label: scopeLabel(row.scope_key, { masterId: cfg.bot.masterId, masterName: cfg.bot.masterName }),
            count: row.message_count,
            summary: row.summary,
            lastAt: row.last_at,
            preview: String(row.last_body ?? "").slice(0, 60),
          })),
        });
      }

      if (route === "GET /api/conversation") {
        const key = url.searchParams.get("key");
        if (!key) return json(res, 400, { ok: false, message: "缺少 key" });
        const cfg = getConfig();
        const messages = recentMessages(key, Math.min(400, Number(url.searchParams.get("limit")) || 200));
        return json(res, 200, {
          ok: true,
          session: getSession(key),
          label: scopeLabel(key, { masterId: cfg.bot.masterId, masterName: cfg.bot.masterName }),
          messages,
        });
      }

      if (route === "POST /api/conversation/clear") {
        const body = await readBody(req);
        const result = await chat.clearConversation(body?.key ?? "", { alsoMemory: body?.alsoMemory !== false });
        audit({ eventType: "conversation_cleared", scopeKey: body?.key ?? "", actor: "panel", detail: result });
        return json(res, 200, { ok: true, ...result });
      }

      if (route === "GET /api/decisions") {
        return json(res, 200, { ok: true, decisions: chat.snapshot().decisions });
      }

      /* ------------------------------ 群聊与审核 ------------------------------ */

      if (route === "GET /api/groups") {
        const cfg = getConfig();
        const groups = allGroups().map((row) => {
          const members = url.searchParams.get("members") === "none" ? [] : groupMembers(row.group_id).map((member) => publicMember(member, cfg));
          const sample = one("select peer_id from group_members where group_id = ? order by left_at is not null, level desc, peer_id asc limit 1", [row.group_id]);
          return { groupId: row.group_id, memberCount: row.members, syncAt: row.sync_at, members, samplePeerId: sample?.peer_id || "" };
        });
        return json(res, 200, {
          ok: true,
          groups,
          allowList: cfg.chat.groupAllowList,
          denyList: cfg.group.denyList,
          rate: cfg.group.rate,
          filter: cfg.group.filter,
          warnings: listWarnings(),
          blocked: listBlocklist(),
        });
      }

      if (route === "GET /api/groups/members") {
        const groupId = String(url.searchParams.get("groupId") || "");
        if (!/^\d+$/.test(groupId)) return json(res, 400, { ok: false, message: "请选择有效的群" });
        const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
        const params = [groupId];
        let where = "group_id = ?";
        if (query) {
          where += " and (instr(peer_id, ?) > 0 or instr(lower(coalesce(nickname, '')), lower(?)) > 0 or instr(lower(coalesce(card, '')), lower(?)) > 0)";
          params.push(query, query, query);
        }
        const total = Number(one(`select count(*) as n from group_members where ${where}`, params)?.n || 0);
        const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize"))) || 50));
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(url.searchParams.get("page"))) || 1));
        const rows = all(`select * from group_members where ${where} order by left_at is not null, level desc, peer_id asc limit ? offset ?`, [...params, pageSize, (page - 1) * pageSize]);
        return json(res, 200, { ok: true, groupId, page, pageSize, total, totalPages, members: rows.map((member) => publicMember(member, getConfig())) });
      }

      if (route === "POST /api/groups/sync") {
        const body = await readBody(req);
        const list = await client.getGroupList();
        const groups = Array.isArray(list) ? list : [];
        const wanted = body?.groupId ? groups.filter((item) => String(item.group_id) === String(body.groupId)) : groups;
        const summary = [];
        for (const item of wanted) {
          const gid = String(item.group_id);
          try {
            const members = await client.getGroupMemberList(gid);
            const present = [];
            for (const member of Array.isArray(members) ? members : []) {
              present.push(String(member.user_id));
              upsertGroupMember({
                groupId: gid,
                peerId: String(member.user_id),
                nickname: member.nickname ?? "",
                card: member.card ?? "",
                role: member.role ?? "member",
                level: member.level ?? 0,
              });
            }
            const { markLeftMembers } = await import("./storage.mjs");
            const left = markLeftMembers(gid, present);
            summary.push({ groupId: gid, name: item.group_name ?? "", members: present.length, left: left.length });
          } catch (error) {
            summary.push({ groupId: gid, name: item.group_name ?? "", error: String(error?.message ?? error) });
          }
        }
        return json(res, 200, { ok: true, groups: summary, total: groups.length });
      }

      if (route === "POST /api/groups/member") {
        const body = await readBody(req);
        const cfg = getConfig();
        const patch = body?.patch ?? {};
        const target = { characterId: cfg.activeCharacter, groupId: body?.groupId ?? "*", peerId: String(body?.peerId ?? "") };
        if (!target.peerId) return json(res, 400, { ok: false, message: "缺少 peerId" });
        upsertMemberPolicy({ ...target, settings: patch });
        const policy = resolveMemberPolicy(target);
        return json(res, 200, { ok: true, policy });
      }

      if (route === "POST /api/groups/action") {
        const body = await readBody(req);
        const action = String(body?.action ?? "");
        const cfg = getConfig();
        const groupId = String(body?.groupId ?? "*");
        const peerId = String(body?.peerId ?? "");
        if (action === "block") {
          blockPeer({
            scopeKind: body?.scope === "global" ? "global" : "group",
            scopeId: body?.scope === "global" ? "*" : groupId,
            peerId,
            reason: body?.reason || "面板手动拉黑",
            by: "panel",
          });
        } else if (action === "unblock") {
          unblockPeer({ scopeKind: body?.scope === "global" ? "global" : "group", scopeId: body?.scope === "global" ? "*" : groupId, peerId, by: "panel" });
          unblockPeer({ scopeKind: "character", scopeId: cfg.activeCharacter, peerId, by: "panel" });
        } else if (action === "resetWarn") {
          resetWarnings({ scopeKey: `group:${groupId}`, peerId });
          resetWarnings({ scopeKey: `global:*`, peerId });
        } else {
          return json(res, 400, { ok: false, message: `不认识的动作：${action}` });
        }
        return json(res, 200, { ok: true, blocked: listBlocklist(), warnings: listWarnings() });
      }

      if (route === "POST /api/policy/pause") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, paused: pauseState.set(body?.paused === true, String(body?.reason ?? "面板操作")) });
      }

      if (route === "GET /api/policy/audit") {
        return json(res, 200, {
          ok: true,
          blocklist: listBlocklist(),
          warnings: listWarnings(),
          moderation: all("select * from moderation_events order by at desc limit 100"),
        });
      }

      if (route === "POST /api/policy/simulate") {
        const body = await readBody(req);
        const cfg = getConfig();
        const scopeKey = String(body?.scopeKey ?? `private_${cfg.bot.masterId}`);
        const event = {
          eventId: `sim:${Date.now()}`,
          kind: scopeKey.startsWith("group_") ? "group" : "private",
          groupId: scopeKey.startsWith("group_") ? scopeKey.split("_")[1] : "",
          senderId: String(body?.senderId ?? cfg.bot.masterId),
          senderName: body?.senderName ?? "",
          text: String(body?.text ?? ""),
          isMention: body?.isMention === true,
          messageId: `sim-${Date.now()}`,
          scopeKey,
        };
        const result = gate(event, { characterId: cfg.activeCharacter });
        const rate = rateSnapshot({ kind: event.kind, groupId: event.groupId, peerId: event.senderId });
        const blocked = checkBlocked({ kind: event.kind, groupId: event.groupId, peerId: event.senderId, characterId: cfg.activeCharacter });
        return json(res, 200, {
          ok: true,
          decision: result.action,
          reason: result.reason,
          trace: result.trace,
          filterHit: hitFilter(event.text),
          blocked,
          rate,
          budget: checkBudget(),
        });
      }

      if (route === "POST /api/policy/test-filter") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, hit: hitFilter(body?.text ?? "") });
      }

      /* ------------------------------ 记忆 ------------------------------ */

      if (route === "GET /api/memory") {
        const cfg = getConfig();
        const scopeKey = url.searchParams.get("scopeKey") || "";
        const items = listMemories({ scopeKey: scopeKey || null, limit: 400 }).map((row) => ({
          ...row,
          label: scopeLabel(row.scope_key, { masterId: cfg.bot.masterId, masterName: cfg.bot.masterName }),
        }));
        return json(res, 200, {
          ok: true,
          categories: MEMORY_CATEGORIES,
          sourceTypes: SOURCE_TYPES,
          stats: memoryStats(),
          items,
          sessions: listSessions({ limit: 200 }).map((row) => ({
            scopeKey: row.scope_key,
            label: scopeLabel(row.scope_key, { masterId: cfg.bot.masterId, masterName: cfg.bot.masterName }),
            count: row.message_count,
          })),
        });
      }

      if (route === "POST /api/memory/add") {
        const body = await readBody(req);
        const cfg = getConfig();
        const scopeKey = String(body?.scopeKey ?? `private_${cfg.bot.masterId}`);
        const added = addManualMemory({
          scopeKey,
          content: body?.content ?? "",
          category: body?.category || "fact",
          subjectId: String(body?.subjectId ?? (scopeKey.startsWith("private_") ? scopeKey.slice(8) : "")),
          characterId: cfg.activeCharacter,
          pinned: body?.pinned !== false,
        });
        return json(res, 200, { ok: true, added });
      }

      if (route === "POST /api/memory/update") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, memory: updateMemory(body?.id, body?.patch ?? {}) });
      }

      if (route === "POST /api/memory/delete") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, deleted: deleteMemory(body?.id) });
      }

      if (route === "POST /api/memory/retract") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, memory: retractMemory(body?.id, { reason: body?.reason }) });
      }

      if (route === "POST /api/memory/recall") {
        const body = await readBody(req);
        const items = retrieveMemories({
          scopeKey: String(body?.scopeKey ?? ""),
          query: body?.query ?? "",
          subjectId: String(body?.subjectId ?? ""),
          limit: Number(body?.limit) || 8,
        });
        return json(res, 200, { ok: true, items });
      }

      /* ------------------------------ 数字生命 ------------------------------ */

      if (route === "GET /api/life") {
        const cfg = getConfig();
        const character = activeCharacter();
        return json(res, 200, {
          ok: true,
          ...lifeSnapshot({ characterId: character.id, masterId: cfg.bot.masterId, masterName: cfg.bot.masterName }),
          // 任务进度跟页面一起来，刷新页面也能看到上次跑到哪了
          jobs: listJobs({ limit: 8 }),
          running: runningKinds(),
        });
      }

      /*
       * 数字生命的三件长活：归档 / 日记 / 反思。
       *
       * 以前是同步执行的 HTTP 请求，带来两个问题：
       *   · 几十秒里界面什么都不说，用户不知道在跑还是在挂；
       *   · 请求还没回来时再点一次，就又启动一遍——连点五次反思就出五批反思。
       * 现在立刻返回任务号，活放后台跑，进度和结果都能从 /api/jobs 查。
       * 同一类任务在跑时，重复点击只会拿到同一个任务（jobs 里做了单飞）。
       */
      if (route === "GET /api/jobs") {
        const id = url.searchParams.get("id");
        if (id) return json(res, 200, { ok: true, job: getJob(id) });
        return json(res, 200, { ok: true, jobs: listJobs({ limit: Number(url.searchParams.get("limit")) || 20 }), running: runningKinds() });
      }

      if (route === "POST /api/life/archive") {
        const body = await readBody(req);
        const cfg = getConfig();
        const character = activeCharacter();
        const job = runJob("archive", "归档记忆", (progress) =>
          archiveOnce({
            llm,
            character,
            masterId: cfg.bot.masterId,
            masterName: cfg.bot.masterName,
            force: true,
            limit: Number(body?.limit) || 3,
            scopeKey: body?.scopeKey || null,
            onProgress: progress,
          }),
        );
        return json(res, 200, { ok: true, ...job });
      }

      if (route === "POST /api/life/diary") {
        const body = await readBody(req);
        const cfg = getConfig();
        const job = runJob("diary", "写日记", (progress) =>
          writeDiary({
            llm,
            character: activeCharacter(),
            masterId: cfg.bot.masterId,
            masterName: cfg.bot.masterName,
            force: body?.force === true,
            onProgress: progress,
          }),
        );
        return json(res, 200, { ok: true, ...job });
      }

      if (route === "POST /api/life/reflect") {
        const body = await readBody(req);
        const cfg = getConfig();
        const scopeKey = String(body?.scopeKey ?? `private_${cfg.bot.masterId}`);
        const job = runJob("reflect", "自我反思", (progress) =>
          reflect({ llm, character: activeCharacter(), scopeKey, masterId: cfg.bot.masterId, masterName: cfg.bot.masterName, onProgress: progress }),
        );
        return json(res, 200, { ok: true, ...job });
      }

      if (route === "POST /api/life/simulate") {
        const body = await readBody(req);
        const cfg = getConfig();
        const added = addSimulatedExperience({
          characterId: cfg.activeCharacter,
          scopeKey: String(body?.scopeKey ?? `private_${cfg.bot.masterId}`),
          content: body?.content ?? "",
        });
        return json(res, 200, { ok: true, added });
      }

      if (route === "POST /api/life/goal") {
        const body = await readBody(req);
        const action = String(body?.action ?? "close");
        if (action === "close") closeGoal(body?.id, { status: body?.status || "done" });
        return json(res, 200, { ok: true });
      }

      /* ------------------------------ 主动与日程 ------------------------------ */

      if (route === "GET /api/schedule") {
        const cfg = getConfig();
        return json(res, 200, {
          ok: true,
          ...scheduler.snapshot(),
          occasions: OCCASIONS,
          todayHolidays: todayHolidays(new Date()).map((item) => item.name),
          birthdays: listBirthdays(),
          automationModes: [
            { id: "manual", label: "完全手动", hint: "只在你自己点按钮时才发" },
            { id: "review", label: "待审核", hint: "自动生成候选，但要你点确认才发" },
            { id: "limited_auto", label: "有限自动", hint: "在规则和预算范围内自动执行" },
          ],
          masterId: cfg.bot.masterId,
        });
      }

      if (route === "POST /api/schedule/greet") {
        const body = await readBody(req);
        const sent = await scheduler.greetNow({ kind: body?.kind || "proactive", userId: body?.userId, text: body?.text, occasion: body?.occasion });
        return json(res, 200, { ok: true, sent });
      }

      if (route === "POST /api/schedule/reminder") {
        const body = await readBody(req);
        const action = String(body?.action ?? "add");
        if (action === "add") {
          const created = addReminder({
            targetId: String(body?.targetId ?? ""),
            text: body?.text,
            at: body?.at,
            repeatRule: body?.repeatRule || "none",
            polish: body?.polish !== false,
            advanceMinutes: body?.advanceMinutes || 0,
          });
          return json(res, 200, { ok: true, reminder: created });
        }
        if (action === "update") return json(res, 200, { ok: true, reminder: updateReminder(body?.id, body?.patch ?? {}) });
        if (action === "delete") {
          deleteReminder(body?.id);
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { ok: false, message: `不认识的动作：${action}` });
      }

      if (route === "POST /api/schedule/birthday") {
        const body = await readBody(req);
        if (body?.action === "delete") {
          deleteBirthday(body?.id);
          return json(res, 200, { ok: true, birthdays: listBirthdays() });
        }
        const created = addBirthday({ peerId: body?.peerId, name: body?.name, monthDay: body?.monthDay, calendar: body?.calendar, privacy: body?.privacy });
        return json(res, 200, { ok: true, birthday: created, birthdays: listBirthdays() });
      }

      /* ------------------------------ 空间 ------------------------------ */

      if (route === "GET /api/qzone") {
        return json(res, 200, {
          ok: true,
          ...qzone.snapshot(),
          scheduler: qzoneScheduler.status(),
          config: getConfig().qzone,
        });
      }

      if (route === "POST /api/qzone/check") {
        const report = await qzone.selfCheck();
        return json(res, 200, { ok: true, report, capabilities: qzone.snapshot().capabilities });
      }

      if (route === "POST /api/qzone/draft") {
        const body = await readBody(req);
        const draft = await qzoneScheduler.draftPost({ topic: body?.topic ?? "" });
        return json(res, 200, { ok: true, draft });
      }

      if (route === "POST /api/qzone/approve") {
        const body = await readBody(req);
        try {
          const result = await qzoneScheduler.approveDraft(body?.id);
          return json(res, 200, { ok: true, ...result, drafts: qzoneScheduler.status().drafts });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      if (route === "POST /api/qzone/reject") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, draft: qzoneScheduler.rejectDraft(body?.id) });
      }

      if (route === "POST /api/qzone/post") {
        const body = await readBody(req);
        try {
          const result = await qzoneScheduler.postOnce({ content: body?.content, images: body?.images, dryRun: body?.dryRun === true });
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      /** 发一条带本地图片的说说：把本地文件转成 file:// 地址交给协议端上传。 */
      if (route === "POST /api/qzone/post-with-image") {
        const body = await readBody(req);
        const file = String(body?.file ?? "").trim();
        if (!file) return json(res, 400, { ok: false, message: "缺少 file（本地图片路径）" });
        if (!fs.existsSync(file)) return json(res, 200, { ok: false, message: `找不到这个文件：${file}` });
        const normalized = /^[a-zA-Z]:[\\/]/.test(file) ? `file://${file.replace(/\\/g, "/")}` : file;
        try {
          const result = await qzone.publish(String(body?.content ?? ""), {
            images: [normalized],
            ugcRight: Number(body?.ugcRight) || 1,
            dryRun: body?.dryRun === true,
            idempotencyKey: `manual-image-post:${path.basename(file)}:${Math.floor(Date.now() / 60000)}`,
          });
          return json(res, 200, { ok: true, images: 1, ...result });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      if (route === "POST /api/qzone/feeds") {
        try {
          const items = await qzone.feedItems({ count: Number(body_count(url)) || 20 });
          return json(res, 200, { ok: true, items });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "", kind: error?.kind ?? "unknown" });
        }
      }

      if (route === "POST /api/qzone/my-list") {
        const body = await readBody(req);
        try {
          const data = await qzone.msgList(body?.targetUin || 0, 0, Number(body?.num) || 10);
          return json(res, 200, { ok: true, items: data?.msglist ?? [], source: data?.source ?? "adapter" });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "", kind: error?.kind ?? "unknown" });
        }
      }

      if (route === "POST /api/qzone/react") {
        const body = await readBody(req);
        const result = await qzoneScheduler.reactOnce({ dryRun: body?.dryRun !== false });
        return json(res, 200, { ok: true, ...result });
      }

      if (route === "POST /api/qzone/like") {
        const body = await readBody(req);
        try {
          return json(res, 200, { ok: true, ...(await qzone.like(body?.tid, body?.targetUin, { dryRun: body?.dryRun === true })) });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      if (route === "POST /api/qzone/comment") {
        const body = await readBody(req);
        try {
          const text = String(body?.content ?? "").trim() || (await qzone.composeComment({ character: activeCharacter(), post: { text: body?.postText ?? "" } }));
          return json(res, 200, { ok: true, content: text, ...(await qzone.comment(body?.tid, text, body?.targetUin)) });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      if (route === "POST /api/qzone/capability") {
        const body = await readBody(req);
        const { setCapability } = await import("./qzone.mjs");
        setCapability(String(body?.capability ?? ""), String(body?.status ?? "unknown"), body?.note ?? "");
        return json(res, 200, { ok: true, capabilities: qzone.snapshot().capabilities });
      }

      if (route === "POST /api/qzone/delete") {
        const body = await readBody(req);
        try {
          const result = await qzone.remove(String(body?.tid ?? ""));
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error), hint: error?.hint ?? "" });
        }
      }

      /* ------------------------------ 模型与资费 ------------------------------ */

      if (route === "GET /api/llm") {
        return json(res, 200, {
          ok: true,
          status: llm.status(),
          config: { ...getConfig().llm, profiles: Object.fromEntries(Object.entries(getConfig().llm.profiles).map(([id, profile]) => [id, { ...profile, apiKey: "" }])) },
          providers: PROVIDERS,
          taskTypes: TASK_TYPES,
          budget: budgetGate.snapshot(),
          usage: usageReport({ from: Date.now() - 30 * 86400000 }),
        });
      }

      if (route === "POST /api/llm/test") {
        const body = await readBody(req);
        const result = await llm.testConnection({ profileId: body?.profileId, patch: body?.patch });
        return json(res, 200, { ok: result.ok, ...result, status: llm.status() });
      }

      /*
       * 拉取「这家 API 到底给了哪些模型」。
       * 各家的模型名经常变（比如 Kimi 的 moonshot-v1-8k 已经下线），
       * 所以不要靠猜，直接问它自己的 /models。
       */
      if (route === "POST /api/llm/models") {
        const body = await readBody(req);
        const result = await llm.listModels({
          profileId: body?.profileId,
          patch: body?.baseUrl || body?.apiKey ? { baseUrl: body.baseUrl, apiKey: body.apiKey } : null,
        });
        return json(res, 200, { ok: result.ok, ...result });
      }

      /* 显式指定「聊天用哪个模型」（面板的选择器走这里，会一并校正上下文长度与看图能力） */
      if (route === "POST /api/llm/model") {
        const body = await readBody(req);
        const cfg = getConfig();
        const id = body?.profileId || cfg.llm.activeProfile;
        const model = String(body?.model ?? "").trim();
        if (!model) return json(res, 400, { ok: false, message: "请选择或填写一个模型" });
        const profile = cfg.llm.profiles[id] ?? {};
        const preset = (findProvider(profile.provider)?.models ?? []).find((item) => item.id === model);
        const next = saveConfig({
          llm: {
            profiles: {
              [id]: {
                model,
                ...(preset?.contextTokens ? { contextTokens: preset.contextTokens } : {}),
                ...(preset?.vision !== undefined ? { vision: preset.vision } : {}),
                // 价格跟着模型走，否则预算会按错的价格估
                ...(preset && Number.isFinite(Number(preset.priceIn)) ? { priceIn: Number(preset.priceIn) } : {}),
                ...(preset && Number.isFinite(Number(preset.priceOut)) ? { priceOut: Number(preset.priceOut) } : {}),
              },
            },
          },
        });
        log.info(`聊天模型已改为：${model}`);
        // 用户亲自选了模型：把「临时顶替」的记录清掉，从下一个请求开始就用他选的这个
        llm.autoPicked?.delete(id);
        return json(res, 200, {
          ok: true,
          model,
          profile: { model: next.llm.profiles[id].model, contextTokens: next.llm.profiles[id].contextTokens, vision: next.llm.profiles[id].vision },
          known: Boolean(preset),
          message: preset ? `已切换到 ${preset.name || model}` : `已切换到 ${model}（这个模型不在预设里，价格与上下文长度请自己确认）`,
        });
      }

      if (route === "POST /api/llm/usage") {
        const body = await readBody(req);
        const days = Math.max(1, Math.min(365, Number(body?.days) || 30));
        return json(res, 200, { ok: true, usage: usageReport({ from: Date.now() - days * 86400000 }) });
      }

      if (route === "POST /api/budget/reset") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, budget: budgetGate.reset({ scopeKind: body?.scopeKind ?? null, period: body?.period ?? null }) });
      }

      /* ------------------------------ 运行环境与系统 ------------------------------ */

      if (route === "GET /api/system") {
        return json(res, 200, {
          ok: true,
          settings: loadSettings(),
          settingsFile: paths.settings,
          autostart: autostartStatus(),
          protocol: protocolStatus(),
          protocolLogs: recentProtocolLogs(30),
          paths: {
            app: paths.app,
            root: paths.root,
            data: paths.data,
            logs: paths.logs,
            database: paths.database,
            characters: paths.characters,
            backups: paths.backups,
            snowluma: paths.snowluma,
          },
          runtime: {
            version: APP_VERSION,
            installed: paths.installed,
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            pid: process.pid,
            execPath: process.execPath,
            isSea,
            bundled: globalThis.__HEARTECHO_BUNDLED__ === true || process.env.HEARTECHO_BUNDLED === "1",
            appDir: paths.app,
            bundleRoot: paths.root,
            sourceMode: paths.sourceMode,
            settings: paths.settings,
            sqlite: one("select sqlite_version() as v")?.v ?? "",
            integrity: integrityCheck(),
            uptimeSec: Math.round(process.uptime()),
          },
          capabilities: client.capabilities,
        });
      }

      if (route === "POST /api/system/settings") {
        const body = await readBody(req);
        const next = saveSettings(body?.settings ?? {});
        return json(res, 200, { ok: true, settings: next, message: "已写入「心语设置.json」，重启后生效" });
      }

      if (route === "POST /api/system/sync-protocol") {
        const result = syncProtocolConfig();
        return json(res, 200, result);
      }

      /* ------------------------ 协议端（把 QQ 变成接口的那个程序） ------------------------ */

      if (route === "GET /api/protocol") {
        const report = await diagnoseProtocol();
        return json(res, 200, { ok: true, ...report, runtime: protocolRuntimeInfo(), logTail: readLogTail(path.join(paths.logs, "protocol.out.log"), 30) });
      }

      if (route === "POST /api/protocol/start") {
        const result = await startProtocol();
        const after = await diagnoseProtocol();
        return json(res, 200, { ok: Boolean(result.ok), message: result.message, logFile: result.logFile, after });
      }

      if (route === "POST /api/protocol/ensure") {
        const result = await ensureProtocol({ autoStart: true, autoRestart: true });
        return json(res, 200, {
          ok: Boolean(result.ok),
          action: result.action,
          message: result.message,
          logFile: result.logFile,
          before: result.before,
          after: result.after,
        });
      }

      if (route === "POST /api/protocol/restart") {
        const body = await readBody(req);
        const result = await restartProtocol({ waitForPort: Number(body?.waitForPort) || 0 });
        const after = await diagnoseProtocol();
        return json(res, 200, {
          ok: Boolean(result.ok),
          stoppedPid: result.stoppedPid || 0,
          portReady: result.portReady !== false,
          message: result.message,
          logFile: result.logFile,
          after,
        });
      }

      if (route === "GET /api/protocol/log") {
        const file = path.join(paths.logs, "protocol.out.log");
        return json(res, 200, { ok: true, file, tail: readLogTail(file, Number(url.searchParams.get("lines")) || 60) });
      }

      if (route === "POST /api/prompt/preview") {
        // 真的把提示词拼出来给用户看：分层、世界观、关于你、天气、长度指令都在里面
        const body = await readBody(req);
        const cfg = getConfig();
        const character = activeCharacter();
        const scopeKey = String(body?.scopeKey || `private_${cfg.bot.masterId || "0"}`);
        const memory = promptBlock({
          characterId: character.id,
          scopeKey,
          query: String(body?.query ?? ""),
          subjectId: String(cfg.bot.masterId || ""),
          masterId: cfg.bot.masterId,
          masterName: cfg.bot.masterName,
          accountId: String(cfg.bot.selfId || ""),
        });
        const style = replyStyle();
        // 和真实聊天保持同一套逻辑：被叫停时不给预报，只给「对方说那边是 X」的反馈块
        const muted = isWeatherMuted().muted;
        const weatherBlock = muted ? "" : cachedWeatherBlock();
        const feedback = weatherFeedbackBlock();
        const audience = { kind: scopeKey.startsWith("private_") ? "private" : "group", peerId: scopeKey.slice(8), accountId: String(cfg.bot.selfId || ""), scopeKey };
        const prompt = buildSystemPrompt(character, {
          audience,
          isGroup: audience.kind === "group",
          masterName: cfg.bot.masterName || "指挥官",
          relationship: `你在和「${cfg.bot.masterName || "指挥官"}」私聊。`,
          memory: memory.block,
          style,
          weatherBlock,
          feedback,
        });
        return json(res, 200, {
          ok: true,
          prompt,
          style,
          layers: {
            worldview: Boolean(character.worldview),
            userFields: userProfileLines(privateUserProfile(character, audience)).length,
            weather: Boolean(weatherBlock),
            weatherMuted: muted,
            weatherFeedback: Boolean(feedback),
            memory: Boolean(memory.block),
          },
        });
      }

      /* ------------------------------ 天气与位置 ------------------------------ */

      if (route === "GET /api/weather") {
        const status = await weatherStatus();
        return json(res, 200, { ok: Boolean(status.ok), ...status });
      }

      if (route === "POST /api/weather/refresh") {
        const body = await readBody(req);
        if (typeof body?.city === "string") {
          saveConfig({ weather: { city: body.city.trim() } });
          clearWeatherCache();
          log.info(body.city.trim() ? `天气城市改成：${body.city.trim()}` : "天气改成自动定位");
        }
        if (body?.location === "clear") clearWeatherCache();
        const status = await weatherStatus({ force: true });
        return json(res, 200, { ok: Boolean(status.ok), ...status });
      }

      if (route === "POST /api/weather/settings") {
        const body = await readBody(req);
        const patch = {};
        if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body?.autoLocate === "boolean") patch.autoLocate = body.autoLocate;
        if (body?.proactive && typeof body.proactive === "object") patch.proactive = body.proactive;
        if (typeof body?.city === "string") patch.city = body.city.trim();
        const next = saveConfig({ weather: patch });
        return json(res, 200, { ok: true, weather: next.weather });
      }

      if (route === "POST /api/weather/greet") {
        const body = await readBody(req);
        const sent = await scheduler.greetWeatherNow({ userId: body?.userId });
        return json(res, 200, {
          ok: Boolean(sent),
          message: sent ? `已发出：${sent.text}` : "没发出去（看日志，可能是预算或黑名单）",
          sent,
        });
      }

      /*
       * 「今天别再提天气」/「恢复提醒」。
       * 用户在 QQ 里直接说「我这边是大晴天」「别再说了」也会自动触发（见 chat.mjs），
       * 这里的接口是给面板上手动开关用的，两边写的是同一份状态。
       */
      if (route === "POST /api/weather/mute") {
        const body = await readBody(req);
        if (body?.restore) {
          clearWeatherFeedback();
          log.info("天气提醒已恢复");
          return json(res, 200, { ok: true, restored: true, feedback: weatherFeedbackStatus(), message: "已恢复：之后照常按设置提天气" });
        }
        const hours = Math.max(1, Math.min(72, Number(body?.hours) || 12));
        const recorded = recordWeatherFeedback({ type: "stop", note: String(body?.note || ""), text: "面板手动", hours });
        log.info(`面板关闭了天气提醒（${hours} 小时）`);
        return json(res, 200, {
          ok: true,
          feedback: weatherFeedbackStatus(),
          message: `好，今天不再提天气了（到 ${new Date(recorded.until).toLocaleString("zh-CN")} 为止）`,
        });
      }

      /* ---------------------------- 对话设置（长度/条数/活跃度） ---------------------------- */

      if (route === "GET /api/style") {
        const cfg = getConfig();
        const { id: profileId, profile, provider } = { id: cfg.llm.activeProfile, profile: cfg.llm.profiles[cfg.llm.activeProfile] ?? {}, provider: findProvider(cfg.llm.profiles[cfg.llm.activeProfile]?.provider) };
        return json(res, 200, {
          ok: true,
          style: replyStyle(),
          model: {
            profileId,
            provider: profile.provider ?? "",
            providerName: provider?.name ?? profile.provider ?? "",
            model: profile.model ?? "",
            available: Array.isArray(profile.availableModels) ? profile.availableModels : [],
            preset: (provider?.models ?? []).map((item) => item.id),
            vision: Boolean(profile.vision),
            contextTokens: profile.contextTokens ?? null,
            fetchedAt: profile.modelsFetchedAt ?? 0,
            ready: Boolean(profile.apiKey && profile.baseUrl && profile.model),
          },
          chat: {
            maxReplyChars: cfg.chat.maxReplyChars,
            maxBubbles: cfg.chat.maxBubbles,
            activity: cfg.chat.activity,
            followUp: cfg.chat.followUp,
            useEmoji: cfg.chat.useEmoji,
            typingDelayMs: cfg.chat.typingDelayMs,
            firstDelayMs: cfg.chat.firstDelayMs,
            privateMergeWindowSec: cfg.chat.privateMergeWindowSec ?? 3,
            privateMaxWaitSec: cfg.chat.privateMaxWaitSec ?? 15,
            waitForTyping: cfg.chat.waitForTyping !== false,
            splitBubbles: cfg.chat.splitBubbles,
            antiStall: cfg.chat.antiStall !== false,
            files: {
              enabled: cfg.chat.files?.enabled !== false,
              maxBytes: cfg.chat.files?.maxBytes ?? 2097152,
              maxChars: cfg.chat.files?.maxChars ?? 12000,
              maxPerMessage: cfg.chat.files?.maxPerMessage ?? 3,
              keepTurns: cfg.chat.files?.keepTurns ?? 2,
            },
            quietHours: cfg.chat.quietHours,
            rememberFacts: cfg.chat.rememberFacts,
          },
          lengthPresets: LENGTH_PRESETS,
          activityPresets: ACTIVITY_PRESETS,
        });
      }

      if (route === "POST /api/style") {
        const body = await readBody(req);
        const patch = {};
        const num = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
        if (body?.maxReplyChars !== undefined) patch.maxReplyChars = num(body.maxReplyChars, 20, 600);
        if (body?.maxBubbles !== undefined) patch.maxBubbles = num(body.maxBubbles, 1, 8);
        if (body?.activity !== undefined) patch.activity = num(body.activity, 0, 100);
        if (body?.followUp && typeof body.followUp === "object") {
          patch.followUp = {
            enabled: body.followUp.enabled !== false,
            chance: Math.max(0, Math.min(1, Number(body.followUp.chance ?? 0.5))),
            delaySec: num(body.followUp.delaySec ?? 9, 2, 120),
            maxPerTurn: num(body.followUp.maxPerTurn ?? 1, 0, 3),
          };
        }
        if (typeof body?.useEmoji === "boolean") patch.useEmoji = body.useEmoji;
        if (body?.firstDelayMs !== undefined) patch.firstDelayMs = num(body.firstDelayMs, 0, 15000);
        if (body?.privateMergeWindowSec !== undefined) patch.privateMergeWindowSec = num(body.privateMergeWindowSec, 1, 15);
        if (body?.privateMaxWaitSec !== undefined) patch.privateMaxWaitSec = num(body.privateMaxWaitSec, 1, 15);
        if (typeof body?.waitForTyping === "boolean") patch.waitForTyping = body.waitForTyping;
        if (body?.typingDelayMs !== undefined) patch.typingDelayMs = num(body.typingDelayMs, 0, 15000);
        if (typeof body?.splitBubbles === "boolean") patch.splitBubbles = body.splitBubbles;
        if (typeof body?.antiStall === "boolean") patch.antiStall = body.antiStall;
        if (body?.files && typeof body.files === "object") {
          const before = getConfig().chat.files ?? {};
          patch.files = {
            enabled: body.files.enabled !== undefined ? body.files.enabled !== false : before.enabled !== false,
            maxBytes: num(body.files.maxBytes ?? before.maxBytes ?? 2097152, 16 * 1024, 32 * 1024 * 1024),
            maxChars: num(body.files.maxChars ?? before.maxChars ?? 12000, 200, 200000),
            maxPerMessage: num(body.files.maxPerMessage ?? before.maxPerMessage ?? 3, 1, 5),
            keepTurns: num(body.files.keepTurns ?? before.keepTurns ?? 2, 0, 5),
          };
        }
        const next = saveConfig({ chat: patch });
        log.info(`对话设置已更新：${JSON.stringify(patch)}`);
        return json(res, 200, { ok: true, style: replyStyle(), chat: next.chat, message: "已保存，下一条回复就按新设置来" });
      }

      if (route === "POST /api/system/backup") {
        return json(res, 200, { ok: true, ...backup("manual") });
      }

      /* ------------------------- QQ 账号（机器人号 / 对方号） ------------------------- */

      if (route === "GET /api/account") {
        const cfg = getConfig();
        const configs = listAccountConfigs();
        const status = client.status || {};
        return json(res, 200, {
          ok: true,
          selfId: String(cfg.bot.selfId ?? ""),
          masterId: String(cfg.bot.masterId ?? ""),
          masterName: cfg.bot.masterName || "",
          online: Boolean(status.online),
          loggedIn: { selfId: String(status.selfId ?? cfg.bot.selfId ?? ""), nickname: status.nickname || "" },
          configs,
          configFound: configs.some((item) => String(item.selfId) === String(cfg.bot.selfId)),
          configFile: path.join(paths.snowluma, "config", `onebot_${cfg.bot.selfId}.json`),
          protocolDir: paths.snowluma,
          protocolDirExists: fs.existsSync(paths.snowluma),
          wsUrl: cfg.bot.onebotWsUrl,
        });
      }

      if (route === "POST /api/account") {
        const body = await readBody(req);
        const before = getConfig().bot;
        const patch = {};
        const notes = [];

        const selfIdText = String(body?.selfId ?? "").trim();
        if (selfIdText) {
          if (!/^\d{5,12}$/.test(selfIdText)) return json(res, 400, { ok: false, message: "机器人 QQ 号应该是 5-12 位数字" });
          if (Number(selfIdText) !== Number(before.selfId)) {
            patch.selfId = Number(selfIdText);
            notes.push(`机器人 QQ 号：${before.selfId} → ${selfIdText}`);
          }
        }

        const masterText = String(body?.masterId ?? "").trim();
        if (masterText !== "") {
          if (masterText !== "0" && !/^\d{5,12}$/.test(masterText)) return json(res, 400, { ok: false, message: "对方 QQ 号应该是 5-12 位数字" });
          if (Number(masterText) !== Number(before.masterId)) {
            patch.masterId = Number(masterText);
            notes.push(`对方 QQ 号：${before.masterId || "（空）"} → ${masterText === "0" ? "（清空）" : masterText}`);
          }
        }

        if (typeof body?.masterName === "string" && body.masterName.trim() !== String(before.masterName ?? "")) {
          patch.masterName = body.masterName.trim() || "指挥官";
          notes.push(`对方的称呼 → ${patch.masterName}`);
        }

        if (!Object.keys(patch).length) return json(res, 200, { ok: true, changed: false, message: "没有任何改动" });

        const next = saveConfig({ bot: patch });
        log.info(`账号设置有改动：${notes.join("；")}`);

        // 换了机器人号，协议端那边也要有这个号才会真的接管
        let protocol = null;
        if (patch.selfId && body?.createProtocolConfig !== false) {
          protocol = ensureAccountConfig(next.bot.selfId);
          if (protocol.ok && protocol.created) log.info(`已为 ${next.bot.selfId} 生成协议端账号配置：${protocol.file}`);
        }

        return json(res, 200, {
          ok: true,
          changed: true,
          notes,
          protocol,
          bot: { selfId: String(next.bot.selfId), masterId: String(next.bot.masterId || ""), masterName: next.bot.masterName },
          restartNeeded: Boolean(patch.selfId),
          message: patch.selfId
            ? "已保存。机器人换了号，需要重新登录：在 QQ 里退出旧号、登上新号，然后点「重启协议端」"
            : "已保存，立刻生效",
        });
      }

      if (route === "POST /api/account/adopt") {
        // 从协议端读出「现在实际登录的是哪个号」，一键填进上面那个输入框
        const ping = await client.ping().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        const info = ping?.info ?? {};
        const actual = String(info.user_id ?? ping?.status?.selfId ?? "").trim();
        if (!actual) {
          return json(res, 200, { ok: false, message: "协议端没回答当前登录的 QQ 号，请先确认协议端在运行、QQ 已登录", ping });
        }
        const next = saveConfig({ bot: { selfId: Number(actual) } });
        const protocol = ensureAccountConfig(actual);
        log.info(`已按协议端实际登录的号更新机器人 QQ：${actual}`);
        return json(res, 200, {
          ok: true,
          selfId: actual,
          nickname: info.nickname || "",
          protocol,
          bot: { selfId: String(next.bot.selfId) },
          message: `已把机器人 QQ 号设为 ${actual}${info.nickname ? `（${info.nickname}）` : ""}`,
        });
      }

      /* ------------------------------ 多实例 ------------------------------ */

      /*
       * 一个 QQ 号 = 一个实例 = 一个角色。
       * 同时聊两个角色，就给第二个角色配第二个 QQ 号，开第二个实例。
       * 这些接口只负责「把实例目录准备好 / 拉起来 / 打开它的面板」，
       * 那个 QQ 的登录仍然要人扫码（QQ 没有可以自动化的登录接口）。
       */
      if (route === "GET /api/instances") {
        const list = await listInstances();
        return json(res, 200, {
          ok: true,
          instances: list,
          root: path.dirname(registryFile()),
          registry: registryFile(),
          sharedProtocol: sharedProtocolDir(),
          limitNote: "一个 QQ 号只能开一个实例；同一账号同时登录会互相顶下线。",
        });
      }

      if (route === "POST /api/instances") {
        const body = await readBody(req);
        try {
          const created = await createInstance({
            name: body?.name,
            accountId: body?.accountId,
            masterId: body?.masterId,
            masterName: body?.masterName,
            characterId: body?.characterId,
            copyProtocolDir: body?.copyProtocol !== false,
          });
          return json(res, 200, {
            ok: true,
            ...created,
            message: `已创建实例「${created.name}」。第一次启动要在这个实例的协议端里扫码登录 QQ ${created.accountId}，之后就能自己跑了。`,
          });
        } catch (error) {
          return json(res, 400, { ok: false, message: String(error?.message ?? error) });
        }
      }

      if (route === "POST /api/instances/start") {
        const body = await readBody(req);
        const result = await startInstance(String(body?.dir ?? ""));
        const message = !result.ok
          ? result.reason
          : result.alreadyRunning
            ? "这个实例已经在运行了"
            : result.restarted
              ? "已启动；为了让它接上自己的 QQ 号，顺手重启了一次共用协议端（几秒后它自己的面板就能打开）"
              : "已启动，几秒后它自己的面板就能打开了";
        return json(res, result.ok ? 200 : 400, { ok: result.ok, ...result, message });
      }

      if (route === "POST /api/instances/open") {
        const body = await readBody(req);
        const dir = String(body?.dir ?? "");
        const probe = await probeInstance(dir);
        if (!probe.alive) {
          return json(res, 400, { ok: false, message: `这个实例现在没在跑（${probe.reason || "面板没响应"}），先点「启动」` });
        }
        const url = await instancePanelUrl(dir);
        openPanelWindow(url, { dataDir: dataDirOf(dir) });
        // 回给前端的是去掉令牌的地址，免得令牌被写进页面/日志
        const shown = new URL(url);
        shown.hash = "";
        return json(res, 200, { ok: true, url: shown.href });
      }

      if (route === "POST /api/instances/delete") {
        const body = await readBody(req);
        const result = await deleteInstance(String(body?.id ?? ""), { deleteFiles: body?.deleteFiles === true });
        return json(res, result.ok ? 200 : 400, { ok: result.ok, ...result, message: result.ok ? "已删除" : result.reason });
      }

      /* --------------------------- 开机自启 / 窗口 --------------------------- */

      if (route === "GET /api/system/autostart") {
        return json(res, 200, { ok: true, ...autostartStatus(), settings: loadSettings() });
      }

      if (route === "POST /api/system/autostart") {
        const body = await readBody(req);
        const result = setAutostart(Boolean(body?.enabled));
        const status = autostartStatus();
        log.info(body?.enabled ? (result.ok ? "已开启开机自启" : `开启开机自启失败：${result.error}`) : "已关闭开机自启");
        return json(res, 200, {
          ok: Boolean(result.ok),
          ...status,
          message: result.ok ? (body?.enabled ? "已开启：下次开机自动在托盘里运行" : "已关闭开机自启") : result.error,
        });
      }

      if (route === "POST /api/system/open-panel") {
        const cfg = getConfig();
        const opened = openPanelWindow(`http://${cfg.bot.panelHost || "127.0.0.1"}:${Number(cfg.bot.panelPort) || 5311}`);
        return json(res, 200, { ok: Boolean(opened.ok), ...opened, browser: findBrowser() });
      }

      if (route === "POST /api/system/restart") {
        json(res, 200, { ok: true, message: "正在重启…几秒后控制面板会自己回来" });
        setTimeout(() => {
          if (typeof control?.restart === "function") control.restart();
          else relaunchSelf({ delayMs: 1500 });
        }, 400);
        return;
      }

      if (route === "POST /api/system/quit") {
        json(res, 200, { ok: true, message: "正在退出心语…" });
        setTimeout(() => {
          if (typeof control?.quit === "function") control.quit();
          else process.exit(0);
        }, 400);
        return;
      }

      if (route === "GET /api/system/backups") {
        try {
          const list = fs
            .readdirSync(paths.backups)
            .filter((name) => name.endsWith(".db"))
            .map((name) => ({ name, size: fs.statSync(path.join(paths.backups, name)).size, at: fs.statSync(path.join(paths.backups, name)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
          return json(res, 200, { ok: true, dir: paths.backups, list });
        } catch (error) {
          return json(res, 200, { ok: true, dir: paths.backups, list: [], error: String(error?.message ?? error) });
        }
      }

      /* ------------------------------ OneBot 动作 ------------------------------ */

      if (route === "POST /api/onebot/ping") {
        const result = await client.ping();
        return json(res, 200, { ok: result.ok, ...result, status: client.status });
      }

      if (route === "POST /api/onebot/reconnect") {
        client.stop();
        setTimeout(() => client.start(), 400);
        return json(res, 200, { ok: true });
      }

      if (route === "POST /api/onebot/capabilities") {
        const caps = await client.probeCapabilities({ refresh: true });
        return json(res, 200, { ok: true, capabilities: caps });
      }

      if (route === "POST /api/onebot/send") {
        const body = await readBody(req);
        const text = String(body?.text ?? "").trim();
        if (!text) return json(res, 400, { ok: false, message: "内容为空" });
        const target = String(body?.userId || getConfig().bot.masterId || "");
        if (!target) return json(res, 400, { ok: false, message: "还没有设置对方 QQ 号" });
        try {
          const data = await client.sendPrivateMsg(target, text);
          const { insertMessage, ensureSession } = await import("./storage.mjs");
          ensureSession(`private_${target}`, { accountId: String(client.selfId) });
          insertMessage({
            eventKey: `out:manual:${Date.now()}`,
            scopeKey: `private_${target}`,
            direction: "out",
            senderId: client.selfId,
            kind: "private",
            at: Date.now(),
            body: text,
            status: "sent",
            platformMessageId: String(data?.message_id ?? ""),
          });
          return json(res, 200, { ok: true, message_id: data?.message_id ?? "" });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error) });
        }
      }

      if (route === "POST /api/onebot/friends") {
        try {
          const list = await client.getFriendList();
          return json(res, 200, { ok: true, friends: Array.isArray(list) ? list.map((item) => ({ userId: String(item.user_id), nickname: item.nickname ?? "", remark: item.remark ?? "" })) : [] });
        } catch (error) {
          return json(res, 200, { ok: false, message: String(error?.message ?? error) });
        }
      }

      return json(res, 404, { ok: false, message: `没有这个接口：${route}` });
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`接口出错 ${route}：${message}`);
      return json(res, 500, { ok: false, message });
    }
  });

  server.on("clientError", (err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* ignore */
    }
  });

  return {
    listen(port, host) {
      listenHost = host;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },
    close() {
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close();
    },
    server,
  };
}

function body_count(url) {
  return Number(url.searchParams.get("count")) || 20;
}

function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c6cf6"/><stop offset="1" stop-color="#f472b6"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="20" fill="url(#g)"/>
  <path d="M20 28c0-5 4-9 9-9 2.6 0 4.8 1 6.4 2.7 1.6-1.7 3.8-2.7 6.4-2.7 5 0 9 4 9 9 0 9.5-15.4 17-15.4 17S20 37.5 20 28z" fill="#fff" opacity="0.95"/>
</svg>`;
}
