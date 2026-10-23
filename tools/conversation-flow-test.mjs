import { test as nodeTest, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-flow-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "protocol"),
  HEARTECHO_INSTANCES_HOME: tmp,
  HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"),
  HEARTECHO_API_KEY: "SYNTHETIC_ONLY",
  HEARTECHO_LOG_LEVEL: "error",
});
(await import("../lib/paths.mjs")).ensureDirs();
const db = await import("../lib/db.mjs");
db.getDb();
const config = await import("../lib/config.mjs");
const storage = await import("../lib/storage.mjs");
const { ChatEngine } = await import("../lib/chat.mjs");
const { Scheduler } = await import("../lib/scheduler.mjs");
const { createApiServer } = await import("../lib/api.mjs");
const { panelToken } = await import("../lib/panel-auth.mjs");
const { APP_JS } = await import("../lib/ui-app.mjs");
config.saveCharacter("fixture", { name: "Fixture" });
const baseline = {
  activeCharacter: "fixture",
  bot: { selfId: 10000001, masterId: 10000002 },
  chat: {
    privateMergeWindowSec: 0.08,
    firstDelayMs: 0,
    typingDelayMs: 0,
    splitBubbles: false,
    antiStall: false,
    rememberFacts: false,
    quietHours: { enabled: false },
    followUp: { enabled: false },
  },
  group: { rate: { enabled: false } },
  life: { enabled: false },
  weather: { enabled: false },
  greet: {
    morning: { enabled: false },
    noon: { enabled: false },
    night: { enabled: false },
    holidays: { enabled: false },
    birthdays: { enabled: false },
    proactive: { enabled: false },
  },
};
beforeEach(() => config.saveConfig(baseline));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", "no external network in regression tests");
  return nativeFetch(url, options);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("fixture timed out");
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let seq = 0;
const event = (peer, text, extra = {}) => ({
  kind: "private",
  scopeKey: `private_${peer}`,
  senderId: String(peer),
  accountId: "10000001",
  senderName: "Fixture",
  eventId: `fixture:${++seq}`,
  messageId: String(seq),
  timestampMs: Date.now(),
  text,
  images: [],
  files: [],
  segments: [],
  ...extra,
});
const engines = [];
function makeEngine(reply) {
  const calls = [],
    sent = [];
  const engine = new ChatEngine({
    client: {
      selfId: 10000001,
      sendPrivateMsg: async (peer, text) => {
        sent.push({ peer, text });
        return { message_id: String(sent.length) };
      },
      downloadImage: async (image) => ({ dataUrl: `data:image/png;base64,${image.file}`, source: "fixture" }),
      downloadFile: async (file) => ({ buffer: Buffer.from(`contents of ${file.name}`), source: "fixture" }),
    },
    llm: {
      speak: async (character, userText, options) => {
        calls.push({ character, userText, options });
        return reply ? reply(calls.length) : { text: "收到你的完整说明。", requestId: "fake", usage: {} };
      },
    },
  });
  engines.push(engine);
  return { engine, calls, sent };
}
const api = createApiServer({
  client: { status: {}, queue: [] },
  llm: {},
  chat: {},
  control: {},
  log: { info() {}, warn() {}, error() {} },
});
await api.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${api.server.address().port}`;
const token = panelToken();
async function request(route, body, authorized = true) {
  const res = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
after(() => {
  globalThis.fetch = nativeFetch;
  for (const engine of engines) engine.stop();
  api.close();
  api.server.closeAllConnections();
  db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.ok(path.basename(tmp).startsWith("heartecho-flow-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("five consecutive inputs are persisted immediately and generate once after the last pause", async () => {
  const { engine, calls, sent } = makeEngine();
  for (let i = 1; i <= 5; i++) {
    await engine.receive(event(10000011, `sentence ${i}`));
    assert.equal(calls.length, 0);
    await sleep(10);
  }
  assert.equal(
    Number(
      db.one("select count(*) as n from messages where scope_key = ? and direction = 'in'", ["private_10000011"]).n,
    ),
    5,
  );
  await until(() => sent.length === 1);
  assert.equal(calls.length, 1);
  for (let i = 1; i <= 5; i++) assert.ok(calls[0].userText.includes(`sentence ${i}`));
  assert.equal(calls[0].options.history.length, 0, "the current input must not also appear in history");
});

test("new input while generating discards the old result and includes all unanswered inputs", async () => {
  const first = deferred();
  const { engine, calls, sent } = makeEngine((n) => (n === 1 ? first.promise : { text: "这次完整回答。", usage: {} }));
  const intake = engine.receive(event(10000012, "first part"));
  await until(() => calls.length === 1);
  await engine.receive(event(10000012, "second part"));
  await sleep(100);
  assert.equal(sent.length, 0);
  first.resolve({ text: "这是过时的回答。", usage: {} });
  await intake;
  await until(() => sent.length === 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].userText.includes("first part") && calls[1].userText.includes("second part"));
  assert.equal(sent[0].text, "这次完整回答。");
});

test("new input during the initial send delay prevents stale delivery", async () => {
  config.saveConfig({ chat: { privateMergeWindowSec: 0.02, firstDelayMs: 120 } });
  const { engine, calls, sent } = makeEngine();
  await engine.receive(event(10000013, "before delay"));
  await until(() => calls.length === 1);
  await engine.receive(event(10000013, "during delay"));
  await until(() => sent.length === 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].userText.includes("before delay") && calls[1].userText.includes("during delay"));
  assert.equal(
    Number(
      db.one("select count(*) as n from messages where scope_key = ? and direction = 'out'", ["private_10000013"]).n,
    ),
    1,
  );
});

test("an already-started QQ send is recorded; replacement answers only the newly arrived input", async () => {
  const delivery = deferred();
  const { engine, calls, sent } = makeEngine();
  let began = false;
  engine.client.sendPrivateMsg = async (peer, text) => {
    sent.push({ peer, text });
    if (!began) {
      began = true;
      return delivery.promise;
    }
    return { message_id: "next" };
  };
  const intake = engine.receive(event(10000021, "already answered input"));
  await until(() => began);
  await engine.receive(event(10000021, "new input"));
  delivery.resolve({ message_id: "first" });
  await intake;
  await until(() => sent.length === 2);
  assert.equal(calls[1].userText, "new input");
  assert.equal(
    Number(
      db.one("select count(*) as n from messages where scope_key = ? and direction = 'out'", ["private_10000021"]).n,
    ),
    2,
  );
});

test("clearing an in-flight buffered turn prevents late output and accepts a fresh turn", async () => {
  const pending = deferred();
  const { engine, calls, sent } = makeEngine((n) =>
    n === 1 ? pending.promise : { text: "清空后的新回答。", usage: {} },
  );
  const intake = engine.receive(event(10000022, "old input"));
  await until(() => calls.length === 1);
  await engine.clearConversation("private_10000022");
  pending.resolve({ text: "不应出现的旧回答。", usage: {} });
  await intake;
  await sleep(30);
  assert.equal(sent.length, 0);
  await engine.receive(event(10000022, "fresh input"));
  await until(() => sent.length === 1);
  assert.equal(sent[0].text, "清空后的新回答。");
});

test("more than six inputs retain every sentence and duplicate delivery does not reset the window", async () => {
  const { engine, calls, sent } = makeEngine();
  const original = event(10000014, "part 0");
  await engine.receive(original);
  assert.equal((await engine.receive(original)).reason, "duplicate");
  for (let i = 1; i < 20; i++) await engine.receive(event(10000014, `part ${i}`));
  await until(() => sent.length === 1);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 20; i++) assert.ok(calls[0].userText.includes(`part ${i}`));
  assert.equal(
    Number(
      db.one("select count(*) as n from messages where scope_key = ? and direction = 'in'", ["private_10000014"]).n,
    ),
    20,
  );
});

test("separate conversations and attachments remain separate", async () => {
  const { engine, calls, sent } = makeEngine();
  await engine.receive(event(10000015, "photo", { images: [{ file: "AA==" }], files: [{ name: "one.txt" }] }));
  await engine.receive(event(10000016, "different person"));
  await engine.receive(event(10000015, "another photo", { images: [{ file: "BB==" }], files: [{ name: "two.txt" }] }));
  await until(() => sent.length === 2);
  const withFiles = calls.find((x) => x.userText.includes("another photo"));
  assert.deepEqual(withFiles.options.images, ["data:image/png;base64,AA==", "data:image/png;base64,BB=="]);
  assert.deepEqual(
    withFiles.options.files.map((x) => x.name),
    ["one.txt", "two.txt"],
  );
  assert.ok(!withFiles.userText.includes("different person"));
});

test("clearing and stopping discard pending turns; new input cancels old follow-up timers", async () => {
  const { engine, calls } = makeEngine();
  let followed = false;
  const timer = setTimeout(() => {
    followed = true;
  }, 120);
  engine.followTimers.set(timer, "private_10000017");
  await engine.receive(event(10000017, "do not follow up"));
  await engine.clearConversation("private_10000017");
  await engine.receive(event(10000018, "stop before replying"));
  engine.stop();
  await sleep(170);
  assert.equal(calls.length, 0);
  assert.equal(followed, false);
});

test("a role change before flushing cannot answer old buffered input under the new role", async () => {
  const { engine, calls } = makeEngine();
  await engine.receive(event(10000019, "old role input"));
  config.saveCharacter("other", { name: "Other" });
  config.saveConfig({ activeCharacter: "other" });
  await sleep(130);
  assert.equal(calls.length, 0);
});

test("private merge duration is persisted and returned by the actual style API", async () => {
  assert.equal((await request("/api/style", { privateMergeWindowSec: 4 })).status, 200);
  assert.equal((await request("/api/style")).body.chat.privateMergeWindowSec, 4);
  await request("/api/style", { privateMergeWindowSec: 100 });
  assert.equal((await request("/api/style")).body.chat.privateMergeWindowSec, 30);
  await request("/api/style", { privateMergeWindowSec: 0 });
  assert.equal((await request("/api/style")).body.chat.privateMergeWindowSec, 0);
});

function mealScheduler() {
  const sent = [];
  const scheduler = new Scheduler({
    client: {
      selfId: 10000001,
      sendPrivateMsg: async (peer, text) => {
        sent.push(text);
        return { message_id: String(sent.length) };
      },
    },
    llm: {
      speak() {
        throw new Error("no real model");
      },
    },
  });
  return { scheduler, sent };
}
function meals() {
  config.saveConfig({
    greet: {
      morning: { enabled: true, at: "08:30", text: "MORNING", randomDelayMinutes: 0, windowMinutes: 30 },
      noon: { enabled: true, at: "12:30", text: "NOON", randomDelayMinutes: 0, windowMinutes: 30 },
    },
  });
}

test("starting at noon skips the expired morning greeting and sends noon only once", async () => {
  meals();
  const { scheduler, sent } = mealScheduler();
  const now = new Date(2030, 0, 2, 12, 35);
  assert.deepEqual(
    (await scheduler.tickMeals(now)).map((x) => x.kind),
    ["noon"],
  );
  assert.deepEqual(sent, ["NOON"]);
  assert.equal((await scheduler.tickMeals(now)).length, 0);
});

test("greetings inside the window remain eligible, with the next slot as a hard end", async () => {
  meals();
  const { scheduler, sent } = mealScheduler();
  await scheduler.tickMeals(new Date(2030, 0, 3, 8, 40));
  assert.deepEqual(sent, ["MORNING"]);
  config.saveConfig({ greet: { morning: { at: "12:20", windowMinutes: 180 } } });
  assert.deepEqual(
    (await scheduler.tickMeals(new Date(2030, 0, 4, 12, 35))).map((x) => x.kind),
    ["noon"],
  );
});

test("a generated greeting is checked again after generation expires; manual greetings remain explicit", async () => {
  meals();
  config.saveConfig({ greet: { morning: { text: "" } } });
  const { scheduler, sent } = mealScheduler();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  scheduler.compose = async () => {
    offset += 120000;
    return { text: "TOO_LATE" };
  };
  try {
    await scheduler.tickMeals(new Date(2030, 0, 5, 8, 59, 30));
  } finally {
    Date.now = realNow;
  }
  assert.equal(sent.length, 0);
  await scheduler.greetNow({ kind: "morning", text: "MANUAL" });
  assert.deepEqual(sent, ["MANUAL"]);
});

test("group summaries omit member payloads; member API paginates, searches and preserves authorization", async () => {
  for (let i = 0; i < 1000; i++)
    storage.upsertGroupMember({
      groupId: "20000001",
      peerId: String(30000000 + i),
      nickname: `Member ${i}`,
      card: i === 999 ? "Unique card" : "",
    });
  storage.upsertGroupMember({ groupId: "20000002", peerId: "40000001", nickname: "Other group" });
  const summary = (await request("/api/groups?members=none")).body;
  assert.ok(summary.groups.every((x) => x.members.length === 0));
  assert.equal(summary.groups.find((x) => x.groupId === "20000001").memberCount, 1000);
  const first = (await request("/api/groups/members?groupId=20000001")).body;
  const second = (await request("/api/groups/members?groupId=20000001&page=2")).body;
  assert.equal(first.members.length, 50);
  assert.equal(first.total, 1000);
  assert.equal(first.totalPages, 20);
  assert.equal(new Set([...first.members, ...second.members].map((x) => x.peerId)).size, 100);
  assert.equal((await request("/api/groups/members?groupId=20000001&q=Unique")).body.total, 1);
  assert.equal((await request("/api/groups/members?groupId=20000001&q=30000999")).body.total, 1);
  assert.equal((await request("/api/groups/members?groupId=20000001&q=Other%20group")).body.total, 0);
  assert.equal((await request("/api/groups/members?groupId=20000001&q=%27%20OR%201%3D1--")).body.total, 0);
  assert.equal((await request("/api/groups/members?groupId=20000001&pageSize=10000")).body.members.length, 100);
  assert.equal((await request("/api/groups/members?groupId=invalid")).status, 400);
  assert.equal((await request("/api/groups/members?groupId=20000001", undefined, false)).status, 401);
  assert.equal(
    (await request("/api/groups")).body.groups.find((x) => x.groupId === "20000001").members.length,
    1000,
    "legacy clients retain the full response",
  );
});

test("member UI defaults collapsed and preserves drafts/open state across pages, search and refresh", async () => {
  const requests = [];
  const ctx = vm.createContext({
    console,
    ICONS: {},
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { hash: "", pathname: "/", search: "" },
    sessionStorage: { getItem: () => token },
    document: { documentElement: { setAttribute() {} }, addEventListener() {} },
    window: { addEventListener() {} },
    fetch: (route, options) => {
      requests.push(route);
      return fetch(base + route, options);
    },
  });
  vm.runInContext(APP_JS + "\nglobalThis.view={S,pageGroups,groupMemberView};", ctx);
  ctx.view.S.groupSel = "20000001";
  const closed = await ctx.view.pageGroups();
  assert.match(closed, /<details id="groupMembers">/);
  assert.equal(
    requests.some((x) => x.startsWith("/api/groups/members?")),
    false,
  );
  const state = ctx.view.groupMemberView("20000001");
  state.open = true;
  const first = await ctx.view.pageGroups();
  assert.equal((first.match(/data-save=/g) || []).length, 50);
  state.drafts.set("30000000", { note: "UNSAVED & draft" });
  state.page = 2;
  assert.equal((await ctx.view.pageGroups()).includes("UNSAVED"), false);
  state.page = 1;
  ctx.view.S.groups = null;
  const refreshed = await ctx.view.pageGroups();
  assert.match(refreshed, /<details id="groupMembers" open>/);
  assert.match(refreshed, /UNSAVED &amp; draft/);
  state.q = "Unique";
  assert.equal(((await ctx.view.pageGroups()).match(/data-save=/g) || []).length, 1);
  assert.equal(state.drafts.get("30000000").note, "UNSAVED & draft");
});
