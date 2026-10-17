/**
 * 预算闸门（规划书 FR-703 / 10.1）。
 *
 * 核心语义：
 *   - 支出必须先「原子预留」再调用模型，调用结束后按实际 usage 对账
 *   - 预留是同步的临界区，因此并发场景也不会突破硬额度
 *   - 达到 warnRatio 记一次预警，达到 100% 熔断（返回 ok:false）
 *   - 所有金额与供应商报价单位一致（默认元）
 */
import { all, run, one, audit } from "./db.mjs";
import { getConfig } from "./config.mjs";
import { dayKey, monthKey } from "./util.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("Budget");

/** scope 定义：全局 / 私聊 / 群。（任务级预算留了字段，本期不做硬约束） */
export const BUDGET_SCOPES = [
  { kind: "global", id: "*", label: "全局" },
  { kind: "private", id: "*", label: "私聊" },
  { kind: "group", id: "*", label: "群聊" },
];

function limitFor(kind, period) {
  const cfg = getConfig();
  const budget = cfg.budget ?? {};
  if (period === "month") {
    if (kind === "global") return Number(budget.globalMonthly) || 0;
    // 月额只对全局设：其余按日额 × 31 估算，作为兜底
    const daily = kind === "private" ? Number(budget.privateDaily) || 0 : Number(budget.groupDaily) || 0;
    return daily > 0 ? daily * 31 : 0;
  }
  if (kind === "global") return Number(budget.globalDaily) || 0;
  if (kind === "private") return Number(budget.privateDaily) || 0;
  if (kind === "group") return Number(budget.groupDaily) || 0;
  return 0;
}

function periodKeyOf(period, date = new Date()) {
  return period === "month" ? monthKey(date) : dayKey(date);
}

function ensureRow(scopeKind, scopeId, period, limitAmount) {
  const periodKey = periodKeyOf(period);
  run(
    `insert or ignore into budgets(scope_kind, scope_id, period, limit_amount, reserved, spent, period_key, warned, updated_at)
     values(?, ?, ?, ?, 0, 0, ?, 0, ?)`,
    [scopeKind, scopeId, period, limitAmount, periodKey, Date.now()],
  );
  const row = one(
    "select * from budgets where scope_kind = ? and scope_id = ? and period = ? and period_key = ?",
    [scopeKind, scopeId, period, periodKey],
  );
  if (row && Number(row.limit_amount) !== limitAmount) {
    run("update budgets set limit_amount = ? where id = ?", [limitAmount, row.id]);
    row.limit_amount = limitAmount;
  }
  return row;
}

/**
 * 检查是否还有预算（只读，供面板与前置判定使用）。
 * 返回 { ok, exceeded, ratio, scopes }
 */
export function checkBudget({ extra = 0 } = {}) {
  const cfg = getConfig();
  if (cfg.budget?.enabled === false) return { ok: true, exceeded: [], ratio: 0, scopes: [] };
  const scopes = [];
  const exceeded = [];
  let maxRatio = 0;
  for (const { kind, id, label } of BUDGET_SCOPES) {
    for (const period of ["day", "month"]) {
      const limit = limitFor(kind, period);
      if (limit <= 0) continue;
      const row = ensureRow(kind, id, period, limit);
      const used = Number(row?.spent ?? 0) + Number(row?.reserved ?? 0) + Number(extra || 0);
      const ratio = used / limit;
      maxRatio = Math.max(maxRatio, ratio);
      scopes.push({ kind, period, label, used, limit, ratio });
      if (ratio >= 1) exceeded.push({ kind, period, label, used, limit, ratio });
    }
  }
  return { ok: exceeded.length === 0, exceeded, ratio: maxRatio, scopes };
}

export class BudgetGate {
  constructor() {
    this.reservations = new Map();
    this.seq = 0;
  }

  /**
   * 原子预留。返回 { ok, reservationId, reason, scope }。
   * 只要有一个 scope 会突破，就整体拒绝（不做部分预留）。
   */
  reserve({ estimate = 0, task = "chat", scopeKind = "" } = {}) {
    const cfg = getConfig();
    if (cfg.budget?.enabled === false) return { ok: true, reservationId: "" };
    const amount = Math.max(0, Number(estimate) || 0);
    const dayRows = [];
    const monthRows = [];
    const exceeded = [];

    for (const kind of ["global", "private", "group"]) {
      if (kind !== "global" && scopeKind && kind !== scopeKind) continue;
      if (kind !== "global" && !scopeKind) continue;
      for (const period of ["day", "month"]) {
        const limit = limitFor(kind, period);
        if (limit <= 0) continue;
        const row = ensureRow(kind, "*", period, limit);
        const used = Number(row.spent ?? 0) + Number(row.reserved ?? 0);
        if (used + amount >= limit) {
          exceeded.push({ kind, period, used, limit });
        }
        (period === "day" ? dayRows : monthRows).push({ kind, period, row });
      }
    }

    if (exceeded.length) {
      const name = { global: "全局", private: "私聊", group: "群聊" };
      const first = exceeded[0];
      audit({
        eventType: "budget_blocked",
        reason: `${name[first.kind]}${first.period === "day" ? "日" : "月"}预算已用尽`,
        detail: { exceeded, task },
      });
      return {
        ok: false,
        reason: `${name[first.kind]}预算已到上限（${first.used.toFixed(3)}/${first.limit}），先停一会儿，免得花钱失控`,
        exceeded,
      };
    }

    const id = `r${Date.now().toString(36)}${(this.seq += 1)}`;
    this.reservations.set(id, { amount, at: Date.now(), rows: [...dayRows, ...monthRows] });
    for (const { row } of [...dayRows, ...monthRows]) {
      run("update budgets set reserved = reserved + ?, updated_at = ? where id = ?", [amount, Date.now(), row.id]);
    }
    return { ok: true, reservationId: id };
  }

  /** 对账：把预留换算成实际支出。actual 为 null 时按预留额计入。 */
  settle(reservationId, { actual = null, usageSource = "estimated" } = {}) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return { ok: false, reason: "预留意不存在（可能已对账）" };
    this.reservations.delete(reservationId);
    const amount = Math.max(0, Number(actual ?? reservation.amount) || 0);
    const warned = [];
    for (const { kind, period, row } of reservation.rows) {
      const current = one("select * from budgets where id = ?", [row.id]);
      if (!current) continue;
      const nextReserved = Math.max(0, Number(current.reserved) - reservation.amount);
      const nextSpent = Number(current.spent) + amount;
      const ratio = Number(current.limit_amount) > 0 ? nextSpent / Number(current.limit_amount) : 0;
      const warnRatio = Number(getConfig().budget?.warnRatio) || 0.8;
      const shouldWarn = ratio >= warnRatio && !current.warned;
      run("update budgets set reserved = ?, spent = ?, warned = ?, updated_at = ? where id = ?", [
        nextReserved,
        nextSpent,
        shouldWarn ? 1 : current.warned,
        Date.now(),
        current.id,
      ]);
      if (shouldWarn) warned.push({ kind, period, ratio, used: nextSpent, limit: Number(current.limit_amount) });
    }
    for (const item of warned) {
      log.warn(`预算预警：${item.kind}/${item.period} 已用 ${(item.ratio * 100).toFixed(0)}%（${item.used.toFixed(3)}/${item.limit}）`);
    }
    return { ok: true, amount, usageSource, warned };
  }

  /** 取消预留（生成失败时用）。 */
  release(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;
    this.reservations.delete(reservationId);
    for (const { row } of reservation.rows) {
      run("update budgets set reserved = max(0, reserved - ?), updated_at = ? where id = ?", [
        reservation.amount,
        Date.now(),
        row.id,
      ]);
    }
    return true;
  }

  snapshot() {
    const cfg = getConfig();
    const out = { enabled: cfg.budget?.enabled !== false, scopes: [], warned: [], exceeded: [] };
    for (const { kind, id, label } of BUDGET_SCOPES) {
      for (const period of ["day", "month"]) {
        const limit = limitFor(kind, period);
        const row = limit > 0 ? ensureRow(kind, id, period, limit) : null;
        out.scopes.push({
          kind,
          period,
          label: `${label}${period === "day" ? "日" : "月"}`,
          limit,
          spent: Number(row?.spent ?? 0),
          reserved: Number(row?.reserved ?? 0),
          ratio: limit > 0 ? Number(row?.spent ?? 0) / limit : 0,
        });
      }
    }
    out.pendingReservations = this.reservations.size;
    return out;
  }

  /** 手动重置（面板用：用户改了额度或想清账）。 */
  reset({ scopeKind = null, period = null } = {}) {
    const clauses = [];
    const params = [];
    if (scopeKind) {
      clauses.push("scope_kind = ?");
      params.push(scopeKind);
    }
    if (period) {
      clauses.push("period = ?");
      params.push(period);
    }
    const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
    run(`delete from budgets${where}`, params);
    return this.snapshot();
  }
}

/** 历史账单（面板「可解释账单」用）。 */
export function usageReport({ from = Date.now() - 7 * 86400000, to = Date.now() } = {}) {
  const rows = all(
    `select task, provider, model, count(*) as calls, sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
            sum(cost) as cost, sum(case when usage_source = 'actual' then 1 else 0 end) as actual_calls
     from llm_usage where at >= ? and at <= ? group by task, provider, model order by cost desc`,
    [from, to],
  );
  const totals = one(
    `select count(*) as calls, sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out, sum(cost) as cost
     from llm_usage where at >= ? and at <= ?`,
    [from, to],
  );
  const byDay = all(
    `select substr(date(at/1000, 'unixepoch', 'localtime'), 1, 10) as day, count(*) as calls, sum(cost) as cost
     from llm_usage where at >= ? and at <= ? group by day order by day desc limit 60`,
    [from, to],
  );
  const byScope = all(
    `select scope_key, count(*) as calls, sum(cost) as cost from llm_usage
     where at >= ? and at <= ? and scope_key <> '' group by scope_key order by cost desc limit 40`,
    [from, to],
  );
  return {
    from,
    to,
    rows: rows.map((row) => ({ ...row, cost: Number(row.cost ?? 0) })),
    totals: {
      calls: Number(totals?.calls ?? 0),
      tokensIn: Number(totals?.tokens_in ?? 0),
      tokensOut: Number(totals?.tokens_out ?? 0),
      cost: Number(totals?.cost ?? 0),
    },
    byDay: byDay.map((row) => ({ ...row, cost: Number(row.cost ?? 0) })),
    byScope: byScope.map((row) => ({ ...row, cost: Number(row.cost ?? 0) })),
  };
}
