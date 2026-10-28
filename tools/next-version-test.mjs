import { test as nodeTest, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-next-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_API_KEY: "SYNTHETIC_ONLY",
  HEARTECHO_LOG_LEVEL: "error",
});
const { ensureDirs } = await import("../lib/paths.mjs");
ensureDirs();
const db = await import("../lib/db.mjs");
db.getDb();
const config = await import("../lib/config.mjs");
const storage = await import("../lib/storage.mjs");
const memory = await import("../lib/extended-memory.mjs");
const policy = await import("../lib/policy.mjs");
const { ChatEngine } = await import("../lib/chat.mjs");
const { InteractionService, normalizeNotice } = await import("../lib/interactions.mjs");
const { TbGroupService, tbSearch, TB_CHARACTER } = await import("../lib/tb.mjs");
const { hindsightEnvironment } = await import("../lib/hindsight-runtime.mjs");
const { createApiServer } = await import("../lib/api.mjs");
const { panelToken } = await import("../lib/panel-auth.mjs");
const { APP_JS } = await import("../lib/ui-app.mjs");
config.saveCharacter("fixture", { name: "Fixture", persona: "test" });
const defaults = structuredClone(config.DEFAULT_CONFIG);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
let seq = 0;
function event(text, extra = {}) {
  const id = String(++seq);
  return {
    kind: "private",
    scopeKey: "private_200",
    senderId: "200",
    accountId: "100",
    messageId: id,
    eventId: `test:${id}`,
    traceId: id,
    timestampMs: Date.now(),
    text,
    images: [],
    files: [],
    segments: [],
    isMention: false,
    ...extra,
  };
}
const engines = [];
function engine(speak) {
  const sent = [],
    calls = [];
  const client = {
    selfId: 100,
    status: {},
    queue: [],
    sendPrivateMsg: async (peer, text) => {
      sent.push({ peer, text });
      return { message_id: String(sent.length) };
    },
    sendGroupMsg: async (peer, text) => {
      sent.push({ peer, text });
      return { message_id: String(sent.length) };
    },
    getGroupMemberInfo: async () => ({ role: "member" }),
  };
  const llm = {
    speak: async (character, text, options) => {
      calls.push({ character, text, options });
      return speak ? speak() : { text: "已确认。", usage: {} };
    },
    json: async () => ({ json: { summary: "当天事实摘要" }, text: "" }),
  };
  const chat = new ChatEngine({ client, llm });
  const tb = new TbGroupService({ client, chat });
  const interactions = new InteractionService({ client, chat, tb });
  engines.push({ chat, tb });
  return { chat, sent, calls, client, llm, tb, interactions };
}

const requests = [],
  documents = new Map();
let remoteFail = false,
  recallLatch = null,
  modelLatch = null;
const remote = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
  if (req.url.endsWith("/chat/completions")) {
    if (modelLatch) await modelLatch.promise;
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "safe" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    return;
  }
  if (remoteFail) {
    res.writeHead(503);
    res.end();
    return;
  }
  const bank = decodeURIComponent(req.url.split("/")[4] || "");
  if (req.method === "DELETE") {
    documents.delete(bank);
    res.end("{}");
    return;
  }
  if (req.url.endsWith("/recall")) {
    if (recallLatch) await recallLatch.promise;
    res.end(JSON.stringify({ results: [{ text: documents.get(bank)?.content || "remote-memory" }] }));
  } else {
    documents.set(bank, body.items[0]);
    res.end("{}");
  }
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const remoteUrl = `http://127.0.0.1:${remote.address().port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", "regression tests must not contact external services");
  return nativeFetch(url, options);
};
const apiEngine = engine();
const api = createApiServer({ ...apiEngine, control: {}, log: { info() {}, error() {}, warn() {} } });
await api.listen(0, "127.0.0.1");
const apiUrl = `http://127.0.0.1:${api.server.address().port}`;
async function request(route, body, auth = true) {
  const response = await fetch(apiUrl + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${panelToken()}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  policy.pauseState.set(false);
  config.saveConfig({
    ...structuredClone(defaults),
    activeCharacter: "fixture",
    bot: { ...defaults.bot, selfId: 100, masterId: 999 },
    chat: {
      ...defaults.chat,
      firstDelayMs: 0,
      typingDelayMs: 0,
      privateMergeWindowSec: 1,
      privateMaxWaitSec: 1,
      followUp: { enabled: false },
      antiStall: false,
      rememberFacts: false,
      replyGroupAll: true,
    },
    group: {
      ...defaults.group,
      defaultTrigger: "all",
      rate: { ...defaults.group.rate, minGapSeconds: 0, maxConsecutive: 0 },
    },
  });
  for (const table of [
    "hindsight_records",
    "hindsight_deletions",
    "memory_grants",
    "interaction_claims",
    "quota_exemptions",
    "rate_events",
    "member_policies",
  ])
    db.run(`delete from ${table}`);
  requests.length = 0;
  remoteFail = false;
  recallLatch = null;
  modelLatch = null;
});
after(() => {
  globalThis.fetch = nativeFetch;
  for (const item of engines) {
    item.chat.stop();
    item.tb.stop();
  }
  api.close();
  api.server.closeAllConnections();
  remote.closeAllConnections();
  remote.close();
  db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.ok(path.basename(tmp).startsWith("heartecho-next-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
function consent() {
  config.saveConfig({ nextMemory: { enabled: true, baseUrl: remoteUrl, apiKey: "SYNTHETIC_MEMORY_KEY" } });
  config.saveConfig({ nextMemory: { consentDigest: memory.memoryDisclosure().fingerprint } });
}
function record(scopeKey = "private_200", characterId = "fixture", content = "PRIVATE_SENTINEL") {
  const id = `record-${++seq}`,
    revision = `revision-${seq}`;
  db.run(
    "insert into hindsight_records(id,character_id,account_id,scope_key,generation,day,content,bank_id,revision,updated_at) values(?,?,?,?,?,?,?,?,?,?)",
    [id, characterId, "100", scopeKey, 0, "2026-10-01", content, `bank-${seq}`, revision, Date.now()],
  );
  return db.one("select * from hindsight_records where id = ?", [id]);
}

test("typing is normalized only for this account and poke only when aimed at the bot", () => {
  const raw = {
    post_type: "notice",
    self_id: 100,
    notice_type: "notify",
    sub_type: "input_status",
    user_id: 200,
    event_type: 1,
  };
  assert.equal(normalizeNotice(raw, 100).typing, true);
  assert.equal(normalizeNotice({ ...raw, event_type: 0 }, 100).typing, false);
  assert.equal(normalizeNotice(raw, 101), null);
  assert.equal(normalizeNotice({ ...raw, sub_type: "poke", target_id: 201 }, 100), null);
  assert.equal(normalizeNotice({ ...raw, sub_type: "poke", target_id: 100 }, 100).eventType, "poke");
});

test("typing and repeated messages never extend the whole turn beyond its deadline", async () => {
  const e = engine();
  await e.chat.receive(event("第一句"));
  for (let i = 0; i < 4; i++) {
    await delay(210);
    e.chat.noteTyping({ senderId: "200", accountId: "100", typing: true });
    await e.chat.receive(event(`后续${i}`));
  }
  await delay(350);
  assert.equal(e.calls.length, 1);
  assert.match(e.calls[0].text, /第一句[\s\S]*后续3/);
  assert.equal(e.sent.length, 1);
  e.chat.stop();
});

test("typing with no pending input does not create a reply", async () => {
  const e = engine();
  e.chat.noteTyping({ senderId: "200", accountId: "100", typing: true });
  await delay(30);
  assert.equal(e.chat.privateTurns.size, 0);
  assert.equal(e.calls.length, 0);
});

test("one delivered reply increments each quota bucket exactly once", () => {
  const target = { kind: "group", groupId: "300", peerId: "200" };
  config.saveConfig({ group: { groupOverrides: { 300: { rate: { perGroupPerMinute: 1 } } } } });
  policy.noteReply(target);
  const quota = policy.rateSnapshot(target);
  assert.equal(quota.find((q) => q.limitKey === "perUserPerHour").count, 1);
  assert.equal(quota.find((q) => q.limitKey === "perGroupPerMinute").remaining, 0);
  assert.equal(policy.rateCheck(target).ok, false);
  assert.equal(policy.rateCheck({ ...target, groupId: "301" }).ok, true);
  policy.resetReplyQuota("300");
  assert.equal(policy.rateCheck(target).ok, true);
});

test("member quota overrides group defaults, and group defaults override global settings", () => {
  config.saveConfig({ group: { groupOverrides: { 300: { rate: { perUserPerHour: 20 } } } } });
  storage.upsertMemberPolicy({
    characterId: "fixture",
    groupId: "300",
    peerId: "*",
    settings: { rate: { perUserPerHour: 10 } },
  });
  storage.upsertMemberPolicy({
    characterId: "fixture",
    groupId: "300",
    peerId: "200",
    settings: { rate: { perUserPerHour: 2 } },
  });
  assert.equal(policy.effectiveRate({ kind: "group", groupId: "300", peerId: "200" }).perUserPerHour, 2);
  assert.equal(policy.effectiveRate({ kind: "group", groupId: "300", peerId: "201" }).perUserPerHour, 10);
});

test("mentions bypass exhausted quota without increasing it, but retain a basic cooldown", () => {
  const target = { kind: "group", groupId: "300", peerId: "200" };
  config.saveConfig({ group: { rate: { perGroupPerMinute: 1 } } });
  policy.noteReply({ ...target, at: Date.now() - 4000 });
  assert.equal(policy.rateCheck({ ...target, isMention: true }).ok, true);
  policy.noteReply({ ...target, isMention: true });
  assert.equal(policy.rateSnapshot(target).find((q) => q.limitKey === "perGroupPerMinute").count, 1);
  assert.equal(policy.rateCheck({ ...target, isMention: true }).ok, false);
});

test("quota exhaustion notice is emitted once rather than on every input", async () => {
  const e = engine();
  config.saveConfig({ group: { rate: { perGroupPerMinute: 1 } } });
  policy.noteReply({ kind: "group", groupId: "300", peerId: "200", at: Date.now() - 5000 });
  await e.chat.handle(event("one", { kind: "group", groupId: "300", scopeKey: "group_300_200" }));
  await e.chat.handle(event("two", { kind: "group", groupId: "300", scopeKey: "group_300_200" }));
  assert.equal(e.sent.length, 1);
  assert.equal(e.calls.length, 0);
});

test("poke defaults to private fixed replies with persistent cooldown and rejects other targets", async () => {
  const e = engine();
  const raw = {
    post_type: "notice",
    self_id: 100,
    notice_type: "notify",
    sub_type: "poke",
    user_id: 200,
    target_id: 100,
    time: 1000,
  };
  await e.interactions.receive(raw);
  await e.interactions.receive({ ...raw, time: 1001 });
  await e.interactions.receive({ ...raw, group_id: 300 });
  await e.interactions.receive({ ...raw, target_id: 201 });
  assert.equal(e.sent.length, 1);
  assert.equal(e.calls.length, 0);
});

test("group poke can use persona and retains pause and block boundaries", async () => {
  const e = engine();
  config.saveCharacter("fixture", { poke: { groups: { 300: { groupEnabled: true, mode: "persona" } } } });
  const raw = {
    post_type: "notice",
    self_id: 100,
    notice_type: "notify",
    sub_type: "poke",
    user_id: 202,
    target_id: 100,
    group_id: 300,
    time: 1000,
  };
  await e.interactions.receive(raw);
  assert.equal(e.calls.length, 1);
  policy.pauseState.set(true);
  await e.interactions.receive({ ...raw, user_id: 203 });
  assert.equal(e.sent.length, 1);
  policy.pauseState.set(false);
  policy.blockPeer({ scopeKind: "group", scopeId: "300", peerId: "204", reason: "fixture" });
  await e.interactions.receive({ ...raw, user_id: 204 });
  assert.equal(e.sent.length, 1);
});

test("QQ admin reset is disabled by default and verifies the actual member role", async () => {
  const e = engine();
  const command = event("重置额度 202", { kind: "group", groupId: "300", scopeKey: "group_300_200", isMention: true });
  policy.noteReply({ kind: "group", groupId: "300", peerId: "202" });
  await e.interactions.adminCommand(command);
  config.saveConfig({ interaction: { adminReset: true } });
  await e.interactions.adminCommand(command);
  assert.equal(e.sent.length, 0);
  e.client.getGroupMemberInfo = async () => ({ role: "admin" });
  await e.interactions.adminCommand(command);
  assert.equal(e.sent.length, 1);
  assert.equal(
    policy.rateSnapshot({ kind: "group", groupId: "300", peerId: "202" }).find((q) => q.limitKey === "perUserPerDay")
      .count,
    0,
  );
});

test("long-term requests need explicit recall and current destination consent", async () => {
  consent();
  record();
  assert.equal((await memory.recallExtendedMemory(event("你好"), "fixture")).block, "");
  assert.equal(requests.length, 0);
  await memory.recallExtendedMemory(event("回忆一下"), "fixture");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, "Bearer SYNTHETIC_MEMORY_KEY");
  assert.equal(requests[0].body.items[0].document_id.startsWith("record-"), true);
  config.saveConfig({ nextMemory: { embedding: { baseUrl: "https://changed.example/v1" } } });
  assert.equal(memory.memoryConsentValid(), false);
  await memory.recallExtendedMemory(event("回忆一下"), "fixture");
  assert.equal(requests.length, 2);
});

test("private, group, character and account permissions are filtered before any remote query", async () => {
  consent();
  const privateRow = record(),
    otherGroup = record("group_301_200"),
    otherCharacter = record("private_200", "other"),
    otherUser = record("private_201");
  const group = event("回忆一下", { kind: "group", groupId: "300", scopeKey: "group_300_200" });
  assert.equal(memory.canRecallRecord(privateRow, group, "fixture"), false);
  assert.equal(memory.canRecallRecord(otherGroup, group, "fixture"), false);
  assert.equal(memory.canRecallRecord(otherCharacter, event("回忆一下"), "fixture"), false);
  assert.equal(memory.canRecallRecord(otherUser, event("回忆一下"), "fixture"), false);
  assert.equal(memory.canRecallRecord(privateRow, event("回忆一下", { accountId: "101" }), "fixture"), false);
  await memory.recallExtendedMemory(group, "fixture");
  assert.equal(requests.length, 0);
  assert.equal(memory.memoryGrantCommand({ ...group, text: "授权记忆到群 300" }, "fixture"), null);
  memory.memoryGrantCommand(event("授权记忆到群 300"), "fixture");
  assert.equal(memory.canRecallRecord(privateRow, group, "fixture"), true);
  memory.memoryGrantCommand(event("撤销记忆到群 300"), "fixture");
  assert.equal(memory.canRecallRecord(privateRow, group, "fixture"), false);
});

test("revoking a grant during recall prevents private content entering the answer", async () => {
  consent();
  record();
  memory.memoryGrantCommand(event("授权记忆到群 300"), "fixture");
  recallLatch = deferred();
  const result = memory.recallExtendedMemory(
    event("回忆一下", { kind: "group", groupId: "300", scopeKey: "group_300_200" }),
    "fixture",
  );
  while (!requests.some((row) => row.url.endsWith("/recall"))) await delay(5);
  memory.memoryGrantCommand(event("撤销记忆到群 300"), "fixture");
  recallLatch.resolve();
  assert.equal((await result).block, "");
});

test("offline memory falls back locally without exposing unauthorized private summaries", async () => {
  consent();
  record();
  remoteFail = true;
  const privateRecall = await memory.recallExtendedMemory(event("回忆一下"), "fixture");
  assert.match(privateRecall.block, /PRIVATE_SENTINEL/);
  const groupRecall = await memory.recallExtendedMemory(
    event("回忆一下", { kind: "group", groupId: "300", scopeKey: "group_300_200" }),
    "fixture",
  );
  assert.equal(groupRecall.block, "");
});

test("editing rotates a remote bank, deleting revokes immediately, and erasure is retried", async () => {
  consent();
  const row = record();
  await memory.syncExtendedMemory(row);
  memory.editExtendedMemory(row.id, "修正后的摘要");
  const edited = db.one("select * from hindsight_records where id = ?", [row.id]);
  assert.notEqual(edited.bank_id, row.bank_id);
  assert.equal(memory.canRecallRecord(row, event("回忆一下"), "fixture"), false);
  await memory.flushMemoryErasures();
  assert.ok(requests.some((item) => item.method === "DELETE"));
  memory.editExtendedMemory(row.id, "");
  assert.equal(memory.listExtendedMemories().length, 0);
});

test("daily summaries preserve exact provenance and are idempotent", async () => {
  consent();
  const e = engine();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  storage.insertMessage({
    eventKey: "daily-private",
    scopeKey: "private_210",
    characterId: "fixture",
    accountId: "100",
    senderId: "210",
    senderName: "Fixture",
    direction: "in",
    kind: "private",
    body: "private-day",
    at: yesterday.getTime(),
  });
  storage.insertMessage({
    eventKey: "daily-group",
    scopeKey: "group_310_210",
    characterId: "fixture",
    accountId: "100",
    senderId: "210",
    senderName: "Fixture",
    direction: "in",
    kind: "group",
    body: "group-day",
    at: yesterday.getTime(),
  });
  const inputs = [];
  e.llm.json = async (messages) => {
    inputs.push(messages[1].content);
    return { json: { summary: messages[1].content } };
  };
  await memory.archiveExtendedDaily(e.llm);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((text) => !(text.includes("private-day") && text.includes("group-day"))));
  await memory.archiveExtendedDaily(e.llm);
  assert.equal(inputs.length, 2);
});

test("extended mode does not inject long-term content into ordinary chatter", async () => {
  consent();
  record();
  const e = engine();
  await e.chat.handle(event("你好"));
  assert.equal(e.calls[0].options.memory, "");
  assert.deepEqual(e.calls[0].options.facts, []);
  assert.equal(requests.length, 0);
});

test("the current settings API cannot manufacture consent or carry credentials to another endpoint", async () => {
  consent();
  assert.equal((await request("/api/next", undefined, false)).status, 401);
  assert.equal((await request("/api/config", { nextMemory: { consentDigest: "fake" } })).status, 400);
  assert.equal((await request("/api/next/consent", { fingerprint: "stale", agreed: true })).body.ok, false);
  await request("/api/next/memory/settings", {
    baseUrl: "https://new.example",
    llm: { baseUrl: "https://model.example", model: "x" },
  });
  assert.equal(memory.memoryConsentValid(), false);
});

test("TB ordinary group messages require mentions even with all-message member policies", () => {
  config.saveConfig({ tb: { enabled: true } });
  const group = event("你好", { kind: "group", groupId: "300", scopeKey: "group_300_200" });
  assert.equal(policy.shouldReply(group).ok, false);
  assert.equal(policy.shouldReply({ ...group, isMention: true }).ok, true);
  assert.equal(policy.shouldReply({ ...group, eventType: "welcome" }).ok, true);
  assert.equal(policy.shouldReply(event("你好")).ok, true);
});

test("TB asks for missing advice context, labels failed search, and cites actual Wiki results", async () => {
  config.saveConfig({ tb: { enabled: true } });
  assert.match((await tbSearch(event("帮我配队"))).clarify, /关卡/);
  const failed = await tbSearch(event("碧蓝新舰船"));
  assert.match(failed.footer, /未完成联网核实/);
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, "wiki.biligame.com");
    return new Response(
      JSON.stringify({
        query: {
          pages: { 1: { title: "示例舰", extract: "测试数据", revisions: [{ timestamp: "2026-10-01T00:00:00Z" }] } },
        },
      }),
    );
  };
  try {
    const result = await tbSearch(event("碧蓝示例舰"));
    assert.match(result.footer, /https:\/\/wiki.biligame.com\/blhx\//);
    assert.match(result.footer, /2026-10-01/);
    assert.match(result.extra, /不可信参考资料/);
  } finally {
    globalThis.fetch = (url, options) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      return nativeFetch(url, options);
    };
  }
});

test("rules changes require explicit confirmation and multiple joins are merged", async () => {
  const e = engine();
  config.saveConfig({ tb: { enabled: true, groups: { 300: { enabled: true, source: "notice" } } } });
  e.client.call = async () => [
    { notice_id: "older", publish_time: 1, message: { text: "旧公告" } },
    { notice_id: "latest", publish_time: 2, message: { text: "本群规则" } },
  ];
  assert.equal((await e.tb.refreshRules("300")).confirmationRequired, true);
  assert.equal(config.getConfig().tb.groups[300].rules, undefined);
  assert.throws(() => e.tb.confirmRules("300", "wrong"));
  e.tb.confirmRules("300", config.getConfig().tb.groups[300].pendingRules.fingerprint);
  const welcome = event("", { kind: "group", groupId: "300", scopeKey: "group_300_200", eventType: "welcome" });
  await e.tb.welcome(welcome);
  await e.tb.welcome({ ...welcome, eventId: "join-201", senderId: "201" });
  await e.tb.flush("fixture:300");
  assert.equal(e.sent.length, 1);
  assert.match(e.sent[0].text, /200、201[\s\S]*本群规则/);
});

test("stale character loads no longer replace the newly saved role", async () => {
  const start = APP_JS.indexOf("async function loadCharacters(");
  const end = APP_JS.indexOf("/* ------------------------------ 试聊与对话", start);
  const pending = deferred();
  let count = 0;
  const S = { characters: [], activeCharacter: null, editingCharacter: null };
  const ctx = vm.createContext({
    S,
    api: async (url) => {
      if (url === "/api/characters")
        return ++count === 1 ? pending.promise : { ok: true, list: [{ id: "saved" }], active: "saved" };
      return { ok: true, character: { id: "saved", name: "所有字段已保存" } };
    },
  });
  vm.runInContext(APP_JS.slice(start, end) + ";globalThis.load=loadCharacters;", ctx);
  const old = ctx.load();
  await ctx.load("saved");
  pending.resolve({ ok: true, list: [], active: "example" });
  await old;
  assert.equal(S.characters.length, 1);
  assert.equal(S.editingCharacter.id, "saved");
});

test("the TB launcher uses separate default storage, and Docker auth configuration is explicit", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "process.argv.push('fixture','--tb');await import('./lib/boot-env.mjs');console.log((await import('./lib/paths.mjs')).paths.data)",
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_"))), LOCALAPPDATA: tmp },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /心语TB/);
  assert.ok(TB_CHARACTER.sources.length >= 2);
  const environment = hindsightEnvironment(config.getConfig().nextMemory);
  assert.match(environment, /ApiKeyTenantExtension/);
  assert.throws(() => hindsightEnvironment({ ...config.getConfig().nextMemory, apiKey: "bad\nKEY=value" }));
});

test("concurrent group replies cannot oversubscribe the last quota slot", async () => {
  const pending = deferred();
  const e = engine(() => pending.promise);
  config.saveConfig({ group: { rate: { perGroupPerMinute: 1 } } });
  const first = e.chat.handle(event("first", { kind: "group", groupId: "350", scopeKey: "group_350_200" }));
  while (!e.calls.length) await delay(5);
  await e.chat.handle(event("second", { kind: "group", groupId: "350", senderId: "201", scopeKey: "group_350_201" }));
  assert.equal(e.calls.length, 1);
  pending.resolve({ text: "实际回复", usage: {} });
  await first;
  assert.equal(
    policy
      .rateSnapshot({ kind: "group", groupId: "350", peerId: "200" })
      .find((q) => q.limitKey === "perGroupPerMinute").count,
    1,
  );
});

test("an unsent model failure releases reserved quota", async () => {
  const e = engine(async () => {
    throw new Error("synthetic generation failure");
  });
  await e.chat.handle(event("failure", { kind: "group", groupId: "351", scopeKey: "group_351_200" }));
  assert.equal(e.sent.length, 0);
  assert.equal(
    policy
      .rateSnapshot({ kind: "group", groupId: "351", peerId: "200" })
      .find((q) => q.limitKey === "perGroupPerMinute").count,
    0,
  );
});

test("revocation while a model is generating prevents the already-recalled private answer", async () => {
  consent();
  record();
  memory.memoryGrantCommand(event("授权记忆到群 352"), "fixture");
  const pending = deferred();
  const e = engine(() => pending.promise);
  const work = e.chat.handle(
    event("回忆一下", { kind: "group", groupId: "352", scopeKey: "group_352_200", isMention: true }),
  );
  while (!e.calls.length) await delay(5);
  memory.memoryGrantCommand(event("撤销记忆到群 352"), "fixture");
  pending.resolve({ text: "PRIVATE_SENTINEL", usage: {} });
  await work;
  assert.equal(e.sent.length, 0);
});

test("clearing an in-flight recall prevents its late private reply and removes pending memory", async () => {
  consent();
  record("private_220");
  const e = engine();
  recallLatch = deferred();
  const work = e.chat.handle(event("回忆一下", { senderId: "220", scopeKey: "private_220" }));
  while (!requests.some((item) => item.url.endsWith("/recall"))) await delay(5);
  await e.chat.clearConversation("private_220");
  recallLatch.resolve();
  await work;
  assert.equal(e.sent.length, 0);
  assert.equal(memory.listExtendedMemories().filter((row) => row.scope_key === "private_220").length, 0);
});

test("fresh installations persist their first created role as active even when later creations are opt-in", () => {
  const childDir = path.join(tmp, "first-install");
  const source = `
    import assert from 'node:assert/strict';
    const paths=await import('./lib/paths.mjs');paths.ensureDirs();
    const cfg=await import('./lib/config.mjs');cfg.ensureConfigFile();
    const {panelToken}=await import('./lib/panel-auth.mjs');
    const {createApiServer}=await import('./lib/api.mjs');
    const api=createApiServer({client:{},chat:{}});await api.listen(0,'127.0.0.1');
    const url='http://127.0.0.1:'+api.server.address().port;
    try {
      const result=await fetch(url+'/api/characters/new',{method:'POST',headers:{Authorization:'Bearer '+panelToken(),'Content-Type':'application/json'},body:JSON.stringify({name:'First',activate:false})});
      const value=await result.json();assert.equal(value.ok,true);assert.equal(cfg.getConfig().activeCharacter,value.character.id);
      assert.equal(cfg.loadCharacter(value.character.id).name,'First');
    } finally {api.close();api.server.closeAllConnections();(await import('./lib/db.mjs')).closeDb();}
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HEARTECHO_APP_DIR: childDir,
      HEARTECHO_DATA_DIR: path.join(childDir, "data"),
      HEARTECHO_LOG_DIR: path.join(childDir, "logs"),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("schema v2 upgrades preserve legacy conversations without guessing new provenance", () => {
  db.exec("drop table role_scope_resets");
  const before = storage.messageCount("private_200");
  db.exec(
    "drop table message_origins; drop table hindsight_records; drop table hindsight_deletions; drop table memory_grants; drop table interaction_claims; drop table quota_exemptions; pragma user_version=2",
  );
  db.closeDb();
  db.getDb();
  assert.equal(db.one("pragma user_version").user_version, 3);
  assert.equal(storage.messageCount("private_200"), before);
  assert.equal(db.one("select count(*) as n from message_origins").n, 0);
});

test("the real model queue rechecks memory grants before sending a queued prompt", async () => {
  const { LlmGateway } = await import("../lib/llm.mjs");
  const row = record();
  const group = event("回忆一下", { kind: "group", groupId: "360", scopeKey: "group_360_200" });
  memory.memoryGrantCommand(event("授权记忆到群 360"), "fixture");
  config.saveConfig({
    llm: {
      profiles: { default: { baseUrl: remoteUrl, apiKey: "SYNTHETIC_MODEL_KEY", model: "fixture", maxConcurrency: 1 } },
    },
  });
  const gateway = new LlmGateway();
  modelLatch = deferred();
  const first = gateway.chat([{ role: "user", content: "safe" }], {
    scopeKey: "private_250",
    skipBudget: true,
    retries: 0,
  });
  while (!requests.some((item) => item.url.endsWith("/chat/completions"))) await delay(5);
  const queued = gateway.chat([{ role: "user", content: "PRIVATE_QUEUED_SENTINEL" }], {
    scopeKey: group.scopeKey,
    skipBudget: true,
    retries: 0,
    validity: () => memory.canRecallRecord(row, group, "fixture"),
  });
  const rejected = assert.rejects(queued, (error) => error.kind === "scope_cleared");
  memory.memoryGrantCommand(event("撤销记忆到群 360"), "fixture");
  modelLatch.resolve();
  await first;
  await rejected;
  assert.equal(requests.filter((item) => item.url.endsWith("/chat/completions")).length, 1);
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_QUEUED_SENTINEL"));
});

test("clearing one role preserves another role's data without replaying it into the cleared role", async () => {
  consent();
  config.saveCharacter("other", { name: "Other" });
  config.saveConfig({ nextMemory: { characterLinks: [["fixture", "other"]] } });
  record("private_230", "fixture", "CURRENT_ROLE");
  const other = record("private_230", "other", "OTHER_ROLE");
  db.run("update hindsight_records set updated_at = ? where id = ?", [Date.now() - 1000, other.id]);
  storage.insertMessage({
    eventKey: "role-clear-a",
    scopeKey: "private_230",
    characterId: "fixture",
    accountId: "100",
    direction: "in",
    senderId: "230",
    senderName: "Fixture",
    kind: "private",
    body: "A",
    at: Date.now(),
  });
  storage.insertMessage({
    eventKey: "role-clear-b",
    scopeKey: "private_230",
    characterId: "other",
    accountId: "100",
    direction: "in",
    senderId: "230",
    senderName: "Fixture",
    kind: "private",
    body: "B",
    at: Date.now(),
  });
  await engine().chat.clearConversation("private_230");
  const remaining = memory.listExtendedMemories().find((row) => row.id === other.id);
  assert.ok(remaining);
  const target = event("回忆一下", { scopeKey: "private_230", senderId: "230" });
  assert.equal(memory.canRecallRecord(remaining, target, "other"), true);
  assert.equal(memory.canRecallRecord(remaining, target, "fixture"), false);
  assert.equal(db.one("select body from messages where event_key = 'role-clear-b'").body, "B");
  assert.equal(db.one("select body from messages where event_key = 'role-clear-a'"), null);
});
