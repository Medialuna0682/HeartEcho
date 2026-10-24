/**
 * ledger（小本本）扩展测试 —— 全离线。
 *
 * 覆盖：工具注册 / 可用性、kind 归一去重与查询过滤（工具 execute）、
 * 销账删除与账面摘要（promptSections）、keepDays 过期清理与 DATA_DIR 落盘。
 *
 * 注意：扩展入口在模块求值时就绑定了 DATA_DIR（compat 行为），所以测试必须
 * **先 installTestRuntime 再动态 import**，不能静态 import。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockHost, installTestRuntime } from "../../../tools/extension-harness.mjs";

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "he-ext-ledger-"));
const LEDGER_DIR = path.join(DATA_ROOT, "ledger");
const LEDGER_FILE = path.join(LEDGER_DIR, "ledger.json");

let extPromise = null;

/** 第一次调用时装好运行时（DATA_DIR 指向临时目录），再 import 扩展入口。 */
function loadExt() {
  if (!extPromise) {
    installTestRuntime({ dataDir: DATA_ROOT });
    extPromise = import("./index.js");
  }
  return extPromise;
}

function resetData() {
  fs.rmSync(LEDGER_DIR, { recursive: true, force: true });
}

function readDb() {
  return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
}

async function setupHost(t, settings = {}) {
  const mod = await loadExt();
  const host = createMockHost({
    id: "ledger",
    // mock 宿主的 dataDir 用 runner 的临时目录（case 结束自动清理）；ledger 真正的数据在 DATA_ROOT。
    dataDir: t.tempDir(),
    settings: { autoRecord: true, injectDigest: true, keepDays: 0, ...settings }
  });
  mod.setup(host.api);
  return { mod, host };
}

process.once("exit", () => {
  try {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

export const cases = [
  {
    name: "注册四个工具且 available() 同步为真",
    run: async (t) => {
      resetData();
      const { mod, host } = await setupHost(t);
      t.eq(mod.available(), true, "ledger 没有外部依赖，available() 应同步为 true");
      t.deepEq(
        host.api.tools.all().map((tool) => tool.id),
        ["add_record", "query_records", "settle_records", "remove_record"],
        "工具 id 与源码保持一致"
      );
      t.eq(host.tools.get("add_record").name, "记一笔账");
      t.eq(host.tools.get("query_records").name, "查小本本");
      t.eq(host.tools.get("settle_records").name, "销账");
      t.eq(host.tools.get("remove_record").name, "删掉一笔账");
      t.ok(
        host.logs.some((item) => String(item.args?.[0] ?? "").includes("小本本已就绪")),
        "setup() 应记录就绪日志"
      );
    }
  },
  {
    name: "add_record：kind 归一、名字归一、去重与原子落盘",
    run: async (t) => {
      resetData();
      const { host } = await setupHost(t);
      const ctx = host.ctx({ chatName: "测试群" });
      const add = host.tools.get("add_record");

      const added = await add.execute(ctx, {
        who: "阿强(12345)",
        kind: "请吃饭",
        detail: "说明天请我吃饭",
        amount: 2,
        unit: "顿",
        evidence: "明天我请"
      });
      t.ok(!added.isError, "记账不应报错");
      t.contains(added.content, "记上了");
      t.contains(added.content, "阿强(12345)｜欠饭×2顿｜说明天请我吃饭", "别名 kind 应归一成「欠饭」");
      t.contains(added.content, "现在一共 1 笔没结清");

      t.ok(fs.existsSync(LEDGER_FILE), "账本应写到 DATA_DIR/ledger/ledger.json");
      t.ok(!fs.existsSync(`${LEDGER_FILE}.tmp`), "原子写不应残留 .tmp 文件");
      const db = readDb();
      t.eq(db.entries.length, 1);
      t.eq(db.entries[0].kind, "欠饭");
      t.eq(db.entries[0].key, "阿强", "normKey 应去掉括号里的 QQ 号");
      t.eq(db.entries[0].chatName, "测试群");
      t.eq(db.entries[0].status, "open");
      t.eq(db.entries[0].id, "L1");

      const dup = await add.execute(ctx, { who: "阿强", kind: "欠饭", detail: "说明天请我吃饭" });
      t.contains(dup.content, "没有重复记", "同人同类同 detail 的未结清账应挡重复");
      t.eq(readDb().entries.length, 1, "重复记账不应新增记录");

      const second = await add.execute(ctx, { who: "小明", kind: "insult", detail: "说我是猪" });
      t.contains(second.content, "小明｜骂我×1次", "英文别名 insult 应归一成「骂我」");
      t.eq(readDb().entries.length, 2);
    }
  },
  {
    name: "query_records：who/kind/status 过滤与 rank 汇总",
    run: async (t) => {
      resetData();
      const { host } = await setupHost(t);
      const ctx = host.ctx({ chatName: "测试群" });
      const add = host.tools.get("add_record");
      await add.execute(ctx, { who: "阿强", kind: "欠饭", detail: "欠三顿饭", amount: 3, unit: "顿" });
      await add.execute(ctx, { who: "小明", kind: "欠钱", detail: "借了五块", amount: 5, unit: "块" });
      await add.execute(ctx, { who: "阿强", kind: "骂我", detail: "说我是猪" });

      const query = host.tools.get("query_records");
      let out = await query.execute(ctx, {});
      t.contains(out.content, "共 3 笔");
      t.contains(out.content, "阿强");
      t.contains(out.content, "小明");

      out = await query.execute(ctx, { who: "阿强" });
      t.contains(out.content, "阿强");
      t.notContains(out.content, "小明", "who 过滤后不应出现其他人");

      out = await query.execute(ctx, { kind: "欠饭" });
      t.contains(out.content, "欠饭×3顿");
      t.notContains(out.content, "借了五块", "kind 过滤后不应出现其它类型");

      out = await query.execute(ctx, { status: "settled" });
      t.contains(out.content, "没有符合条件的账", "还没有销账记录");

      out = await query.execute(ctx, { status: "all", limit: 2 });
      t.contains(out.content, "共 3 笔");
      t.contains(out.content, "还有 1 笔没列出来", "limit 截断时要提示剩余条数");

      out = await query.execute(ctx, { rank: true });
      t.contains(out.content, "按人汇总");
      t.contains(out.content, "阿强 2 笔（欠饭×1、骂我×1）");
    }
  },
  {
    name: "settle/remove 与 promptSections 摘要",
    run: async (t) => {
      resetData();
      const { mod, host } = await setupHost(t);
      const ctx = host.ctx({ chatName: "测试群" });
      const add = host.tools.get("add_record");
      await add.execute(ctx, { who: "阿强", kind: "欠饭", detail: "欠三顿饭", amount: 3, unit: "顿" });
      await add.execute(ctx, { who: "阿强", kind: "骂我", detail: "说我是猪" });
      await add.execute(ctx, { who: "小明", kind: "欠钱", detail: "借了五块", amount: 5, unit: "块" });

      const settle = host.tools.get("settle_records");
      let out = await settle.execute(ctx, { who: "阿强", kind: "欠饭", note: "已请吃饭" });
      t.contains(out.content, "销账 1 笔");
      t.contains(out.content, "（已销账", "销账后行尾应标已销账");

      out = await host.tools.get("query_records").execute(ctx, {});
      t.contains(out.content, "共 2 笔", "销账后未结清只剩 2 笔");
      t.notContains(out.content, "欠饭×3顿", "已销账的账不应出现在默认（未结清）查询里");

      out = await settle.execute(ctx, { ids: "L2,L3" });
      t.contains(out.content, "销账 2 笔", "ids 精确销账");

      const remove = host.tools.get("remove_record");
      out = await remove.execute(ctx, { ids: "L2", reason: "记错人了" });
      t.contains(out.content, "删掉了 1 笔");
      out = await remove.execute(ctx, { ids: "L9" });
      t.ok(out.isError, "删不存在的编号应报错");
      t.contains(out.content, "编号没找到");
      t.eq(readDb().entries.length, 2, "删除后账本只剩 L1、L3");

      // 摘要：再记两笔未结清，promptSections 应给出一行摘要
      await add.execute(ctx, { who: "小刚", kind: "欠人情", detail: "帮了个忙" });
      await add.execute(ctx, { who: "小刚", kind: "欠人情", detail: "又帮了个忙" });
      await add.execute(ctx, { who: "小红", kind: "欠钱", detail: "借一块" });

      let sections = mod.promptSections();
      t.eq(sections.length, 1, "默认只注入一段账面摘要");
      t.eq(sections[0].id, "ledger-digest");
      t.eq(sections[0].priority, 36);
      t.contains(sections[0].content, "3 笔没结清，涉及 2 个人");
      t.contains(sections[0].content, "ledger__query_records");

      host.setSettings({ injectDigest: false });
      sections = mod.promptSections();
      t.deepEq(sections, [], "关掉摘要后不应注入");

      host.setSettings({ injectDigest: true, autoRecord: false });
      sections = mod.promptSections();
      t.eq(sections.length, 2, "关闭自动记账但保留摘要时应同时注入两段");
      t.eq(sections[0].id, "ledger-manual-only", "关闭自动记账时应注入手动提示");
      t.contains(sections[0].content, "ledger__add_record");
      t.eq(sections[1].id, "ledger-digest", "摘要开关仍为开，摘要继续注入");
    }
  },
  {
    name: "keepDays 清理过期已结清记录（数据只在 DATA_DIR）",
    run: async (t) => {
      resetData();
      const oldIso = new Date(Date.now() - 40 * 86400000).toISOString();
      const nowIso = new Date().toISOString();
      fs.mkdirSync(LEDGER_DIR, { recursive: true });
      fs.writeFileSync(
        LEDGER_FILE,
        JSON.stringify({
          version: 1,
          nextId: 3,
          entries: [
            { id: "L1", who: "旧账", kind: "欠饭", detail: "很久之前", at: oldIso, status: "settled", settledAt: oldIso },
            { id: "L2", who: "小刚", kind: "欠饭", detail: "还欠着", at: nowIso, status: "open" }
          ]
        }),
        "utf8"
      );

      const { mod, host } = await setupHost(t, { keepDays: 1 });
      t.eq(readDb().entries.length, 2, "setup 只读不写，不应提前清理");
      t.eq(mod.available(), true);

      const out = await host.tools
        .get("add_record")
        .execute(host.ctx(), { who: "阿强", kind: "欠饭", detail: "新账" });
      t.contains(out.content, "记上了");

      const db = readDb();
      t.eq(db.entries.length, 2, "过期的已结清记录应在落盘时清掉");
      t.ok(!db.entries.some((entry) => entry.who === "旧账"), "旧的已销账记录应被清理");
      t.ok(db.entries.some((entry) => entry.who === "小刚" && entry.status === "open"), "未结清的账不受 keepDays 影响");
      t.ok(db.entries.some((entry) => entry.who === "阿强"), "新账应落盘");
      t.ok(fs.existsSync(path.join(DATA_ROOT, "ledger", "ledger.json")), "所有数据都在 DATA_DIR 下");
    }
  }
];


