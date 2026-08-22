import { Service } from "@deepseek-ai/cordis";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePrice } from "./stats.js";

/** Shanghai natural-month key, independent of the server's local timezone. */
export function shanghaiMonth(time = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).formatToParts(new Date(time));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (year === undefined || month === undefined) throw new Error("cannot resolve Asia/Shanghai month");
  return `${year}-${month}`;
}

function scaledDecimal(value, scale = 1_000_000n) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid non-negative decimal");
  const text = value.toFixed(6);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

function principalOf(value) {
  if (value === null || typeof value !== "object") return undefined;
  if (typeof value.source !== "string" || typeof value.id !== "string" || typeof value.username !== "string") return undefined;
  if (value.role !== "admin" && value.role !== "user") return undefined;
  return value;
}

/** Price one final usage sample with exact model matching and integer arithmetic. */
export function priceUsageMicros(call, pricing, usdCnyRate) {
  const atTime = Number.isFinite(call.time) ? call.time : Number.isFinite(call.createdAt) ? call.createdAt : Date.now();
  const row = resolvePrice(call.model, call.provider, pricing, undefined, atTime);
  if (row === undefined) return { priced: false, amountMicros: 0 };
  const fx = scaledDecimal(usdCnyRate);
  const units = [
    [call.inputTokens, row.inputPerMillion],
    [call.outputTokens, row.outputPerMillion],
    [call.cacheReadTokens, row.cacheReadPerMillion],
    [call.cacheWriteTokens, row.cacheWritePerMillion],
  ];
  let numerator = 0n;
  for (const [tokens, rate] of units) {
    const count = Number.isSafeInteger(tokens) && tokens > 0 ? BigInt(tokens) : 0n;
    numerator += count * scaledDecimal(rate ?? 0) * fx;
  }
  // prices and FX are each scaled 1e6. Half-up to integer CNY micros.
  const amount = (numerator + 500_000_000_000n) / 1_000_000_000_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("priced amount exceeds SQLite safe integer range");
  return { priced: true, amountMicros: Number(amount), rate: row };
}

/** Idempotent final-step accounting ledger. */
export class SpendLedger {
  constructor(path, options) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON");
    this.options = options;
    this.warned = new Set();
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spend_entries (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        principal_source TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        price_version TEXT NOT NULL,
        fx_version TEXT NOT NULL,
        usd_cny_rate TEXT NOT NULL,
        price_json TEXT,
        amount_micros INTEGER NOT NULL,
        priced INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        shanghai_month TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, turn, step)
      );
      CREATE INDEX IF NOT EXISTS idx_spend_principal_month
        ON spend_entries(principal_source, principal_id, shanghai_month, priced);
    `);
    this.insert = this.db.prepare(`
      INSERT INTO spend_entries (
        session_id, turn, step, principal_source, principal_id, username, role,
        provider, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, price_version, fx_version,
        usd_cny_rate, price_json, amount_micros, priced, occurred_at, shanghai_month
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn, step) DO UPDATE SET
        price_version=excluded.price_version, fx_version=excluded.fx_version,
        usd_cny_rate=excluded.usd_cny_rate, price_json=excluded.price_json,
        amount_micros=excluded.amount_micros, priced=excluded.priced
      WHERE spend_entries.priced = 0 AND excluded.priced = 1
    `);
  }

  setPricing(pricing) {
    if (!Array.isArray(pricing)) throw new Error("pricing must be an array");
    this.options.pricing = pricing;
  }

  ingest(call) {
    if (call?.final !== true) return false;
    const principal = principalOf(call.principal);
    if (principal === undefined) return false;
    const priced = priceUsageMicros(call, this.options.pricing, this.options.usdCnyRate);
    if (!priced.priced) {
      const key = `${call.provider ?? "?"}/${call.model ?? "?"}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[dsh-spend] 未计价模型 ${key}：不会使用默认模糊价格扣费`);
      }
    }
    const occurredAt = Number.isFinite(call.time) ? Math.trunc(call.time) : Number.isFinite(call.createdAt) ? Math.trunc(call.createdAt) : Date.now();
    const result = this.insert.run(
      call.sessionId, call.turn, call.step, principal.source, principal.id,
      principal.username, principal.role, call.provider ?? null, call.model ?? null,
      call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens,
      call.reasoningTokens, this.options.priceVersion, this.options.fxVersion,
      String(this.options.usdCnyRate), priced.priced ? JSON.stringify(priced.rate) : null,
      priced.amountMicros, priced.priced ? 1 : 0, occurredAt, shanghaiMonth(occurredAt),
    );
    return Number(result.changes) > 0;
  }

  ingestMany(calls) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let changed = 0;
      for (const call of calls) if (this.ingest(call)) changed++;
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  monthlyUsedMicros(principal, month = shanghaiMonth()) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount_micros), 0) AS used
      FROM spend_entries
      WHERE principal_source = ? AND principal_id = ? AND shanghai_month = ? AND priced = 1
    `).get(principal.source, principal.id, month);
    return Number(row?.used ?? 0);
  }

  report(requester, filter = {}) {
    const principal = principalOf(requester);
    if (principal === undefined) throw new Error("authenticated principal required");
    const month = typeof filter.month === "string" && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : shanghaiMonth();
    let rows;
    if (principal.role === "admin") {
      if (typeof filter.principalId === "string") {
        rows = this.db.prepare(`SELECT * FROM spend_entries WHERE principal_id = ? AND shanghai_month = ? ORDER BY occurred_at`).all(filter.principalId, month);
      } else {
        rows = this.db.prepare(`SELECT * FROM spend_entries WHERE shanghai_month = ? ORDER BY occurred_at`).all(month);
      }
    } else {
      rows = this.db.prepare(`SELECT * FROM spend_entries WHERE principal_source = ? AND principal_id = ? AND shanghai_month = ? ORDER BY occurred_at`).all(principal.source, principal.id, month);
    }
    return rows;
  }

  close() { this.db.close(); }
}

/** Internal principal-aware service consumed by dsh-passwords quota checks. */
export class SpendAccountingService extends Service {
  constructor(ctx, ledger, reconcile) {
    super(ctx, "spendAccounting");
    this.ledger = ledger;
    this.reconcileSource = reconcile;
    this.reconciling = undefined;
    this.budgetResolvers = new Set();
  }

  async reconcile() {
    if (this.reconciling === undefined) {
      this.reconciling = Promise.resolve(this.reconcileSource?.())
        .finally(() => { this.reconciling = undefined; });
    }
    await this.reconciling;
  }

  monthlyUsedMicros(principal, month) {
    if (principalOf(principal) === undefined) throw new Error("authenticated principal required");
    return this.ledger.monthlyUsedMicros(principal, month);
  }

  /** Register one principal source's monthly allowance lookup. */
  registerBudgetResolver(resolve) {
    if (typeof resolve !== "function") throw new TypeError("budget resolver must be a function");
    if (this.budgetResolvers.has(resolve)) throw new Error("budget resolver is already registered");
    this.budgetResolvers.add(resolve);
    return () => {
      this.budgetResolvers.delete(resolve);
    };
  }

  /** Resolve the allowance owned by the first resolver that recognizes the principal. */
  monthlyBudgetMicros(principal) {
    if (principalOf(principal) === undefined) throw new Error("authenticated principal required");
    for (const resolve of this.budgetResolvers) {
      const budget = resolve(principal);
      if (budget === undefined) continue;
      if (budget === null) return null;
      if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("monthly budget must be a non-negative safe integer or null");
      return budget;
    }
    return undefined;
  }

  /** Current principal's allowance status, or null when no policy provider owns it. */
  personalBudgetStatus(principal, month) {
    const budget = this.monthlyBudgetMicros(principal);
    return budget === undefined ? null : this.budgetStatus(principal, budget, month);
  }

  budgetStatus(principal, monthlyBudgetMicros, month) {
    const usedMicros = this.monthlyUsedMicros(principal, month);
    if (monthlyBudgetMicros === null) return { month: month ?? shanghaiMonth(), usedMicros, budgetMicros: null, remainingMicros: null, ratio: 0, warning: false, exhausted: false };
    const budget = Math.max(0, Math.trunc(monthlyBudgetMicros));
    const ratio = budget === 0 ? 1 : usedMicros / budget;
    return {
      month: month ?? shanghaiMonth(), usedMicros, budgetMicros: budget,
      remainingMicros: Math.max(0, budget - usedMicros), ratio,
      warning: ratio >= 0.8, exhausted: usedMicros >= budget,
    };
  }

  report(requester, filter) { return this.ledger.report(requester, filter); }
}
