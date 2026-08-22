/**
 * dsh-spend host plugin.
 *
 * A Typert Remote service (`usageStats`) that replays the durable session
 * logs under the dsh home, aggregates provider-reported token usage across
 * every dimension the web UI asks for (totals, by model, by day, by session,
 * recent calls) and prices it with the configured per-model rates to produce
 * an estimated billing amount. The web GUI reaches it through the standard
 * `/api` Remote gateway (SRC discovery — no generated typert manifest).
 */
import { Service } from "@deepseek-ai/cordis";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { autoPlanFor, autoRatesFor, knowsProvider } from "./knowledge.js";
import { buildStats, computeSignature, localDay, pricingRows, scanSessions } from "./stats.js";
import { SpendAccountingService, SpendLedger } from "./ledger.js";

// ── decorator support (stage-3 decorators, transpiled — Node has none) ─────
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
    return f;
  }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function(f) {
      if (done) throw new TypeError("Cannot add initializers after decoration has completed");
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === "accessor") {
      if (result === void 0) continue;
      if (result === null || typeof result !== "object") throw new TypeError("Object expected");
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) {
      if (kind === "field") initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
var __runInitializers = function(thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
};

/** Pricing field schemas shared by the per-model rows and the default row. */
const priceFields = () => ({
  inputPerMillion: z.number().min(0).default(0),
  outputPerMillion: z.number().min(0).default(0),
  cacheReadPerMillion: z.number().min(0).default(0),
  cacheWritePerMillion: z.number().min(0).default(0),
});

/** Restrict durable calls to the authenticated dashboard/report scope. */
export function callsForPrincipal(calls, principal, requestedPrincipalId = null) {
  if (principal === null || typeof principal !== "object") throw new Error("authenticated principal required");
  if (principal.role === "admin") {
    return requestedPrincipalId === null
      ? calls
      : calls.filter((call) => call.principal?.id === requestedPrincipalId);
  }
  return calls.filter((call) => call.principal?.source === principal.source && call.principal?.id === principal.id);
}

const PRICE_FIELDS = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"];

function scalePriceFields(row, factor) {
  if (row === null || typeof row !== "object") return row;
  const result = { ...row };
  for (const field of PRICE_FIELDS) {
    if (typeof row[field] === "number") result[field] = row[field] * factor;
  }
  if (row.schedule !== undefined) {
    result.schedule = {
      ...row.schedule,
      ...row.schedule.peak === undefined ? {} : { peak: scalePriceFields(row.schedule.peak, factor) },
      ...row.schedule.offPeak === undefined ? {} : { offPeak: scalePriceFields(row.schedule.offPeak, factor) },
    };
  }
  return result;
}

/** Convert USD rate cards into the configured dashboard currency. */
export function pricingForDisplay(pricing, defaultPricing, currency, usdCnyRate) {
  if (currency !== "CNY" && currency !== "USD") throw new Error(`unsupported display currency: ${currency}`);
  if (typeof usdCnyRate !== "number" || !Number.isFinite(usdCnyRate) || usdCnyRate <= 0) throw new Error("usdCnyRate must be positive");
  const factor = currency === "CNY" ? usdCnyRate : 1;
  return {
    pricing: pricing.map((row) => scalePriceFields(row, factor)),
    defaultPricing: scalePriceFields(defaultPricing, factor),
  };
}

function moneyForDisplay(money, currency, usdCnyRate) {
  if (money === null || money === undefined) return money;
  const source = money.currency ?? "USD";
  if (source === currency) return { ...money, currency };
  if (source === "USD" && currency === "CNY") return { ...money, amount: money.amount * usdCnyRate, currency };
  if (source === "CNY" && currency === "USD") return { ...money, amount: money.amount / usdCnyRate, currency };
  throw new Error(`cannot convert ${source} to ${currency}`);
}

/** Normalize one billing plan's monetary values to the dashboard currency. */
export function planForDisplay(plan, currency, usdCnyRate) {
  const usdFactor = currency === "CNY" ? usdCnyRate : 1;
  return {
    ...plan,
    ...plan.subscription === undefined ? {} : { subscription: moneyForDisplay(plan.subscription, currency, usdCnyRate) },
    ...typeof plan.dollarsPerWeek === "number" ? { dollarsPerWeek: plan.dollarsPerWeek * usdFactor } : {},
    ...typeof plan.dollarsPerMonth === "number" ? { dollarsPerMonth: plan.dollarsPerMonth * usdFactor } : {},
    ...Array.isArray(plan.tiers) ? {
      tiers: plan.tiers.map((tier) => ({
        ...tier,
        ...tier.subscription === undefined ? {} : { subscription: moneyForDisplay(tier.subscription, currency, usdCnyRate) },
      })),
    } : {},
  };
}

/**
 * Aggregation service for the usage-stats dashboard.
 *
 * Registered as `ctx.usageStats`; the Remote gateway discovers the
 * `usageStats/query` endpoint through the typertRemote binding + Remote
 * markers (SRC discovery), so no generated descriptor files are needed.
 */
let UsageStatsService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _query_decorators;
  return class UsageStatsService extends _classSuper {
    static {
      const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _query_decorators = [Remote("query")];
      __esDecorate(this, null, _query_decorators, {
        kind: "method",
        name: "query",
        static: false,
        private: false,
        access: { has: (obj) => "query" in obj, get: (obj) => obj.query },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      if (_metadata) Object.defineProperty(this, Symbol.metadata, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: _metadata
      });
    }
    /** Required services: live sessions plus the transport-scoped identity gateway. */
    static inject = ["sessions", "typertGateway"];
    /**
     * Deployment configuration: currency, per-model rates, display limits.
     * Built-in defaults mirror the official vendor pricing (verified
     * 2026-08-14; DeepSeek pre-2026-08-17 rates) — see the profile patch for
     * the full per-model table and the change note.
     */
    static Config = z.object({
      currency: z.union([z.const("CNY"), z.const("USD")]).default("CNY"),
      pricing: z.array(z.object({
        model: z.string().required(),
        // Optional provider scoping: a row with `provider` prices only that
        // provider's model; a row without one prices the model everywhere.
        provider: z.string(),
        ...priceFields(),
      })).default([
        { model: "gpt-5.6-sol", inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 },
        { model: "gpt-5.6-terra", inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
        { model: "gpt-5.6-luna", inputPerMillion: 0.2, outputPerMillion: 1.2, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0.25 },
      ]),
      defaultPricing: z.object(priceFields()).default({
        inputPerMillion: 0.14,
        outputPerMillion: 0.28,
        cacheReadPerMillion: 0.0028,
        cacheWritePerMillion: 0,
      }),
      maxSessions: z.number().step(1).min(1).default(20),
      maxRecentCalls: z.number().step(1).min(1).default(50),
      seriesHours: z.number().step(1).min(1).default(168),
      refreshSeconds: z.number().step(1).min(5).default(30),
      ledgerPath: z.string().default(dshHomePath("spend-ledger.sqlite")),
      usdCnyRate: z.number().min(0.000001).default(7.2),
      priceVersion: z.string().default("2026-08-21"),
      fxVersion: z.string().default("fixed-2026-08-21"),
      // Optional monthly spend budget (in the configured currency): the UI
      // shows used/remaining and turns the pill amber/red when exceeded.
      monthlyBudget: z.number().min(0),
      // Per-provider billing plans for the usage/remaining display:
      //   type 'token' — prepaid balance consumed by estimated cost;
      //   type 'code'  — per-period quota (requests and/or tokens).
      plans: z.array(z.object({
        provider: z.string().required(),
        type: z.union([z.const("token"), z.const("code")]),
        balance: z.number().min(0),
        quotaRequests: z.number().step(1).min(1),
        quotaTokens: z.number().step(1).min(1),
        periodDays: z.number().step(1).min(1),
      })).default([]),
    });

    sessionsRoot;
    pricing;
    defaultPricing;
    currency;
    usdCnyRate;
    maxSessions;
    maxRecentCalls;
    seriesHours;
    refreshSeconds;
    monthlyBudget;
    plans;
    ledger;
    accounting;
    /** `signature|cwd → snapshot` cache; invalidated by any session log change. */
    cache = new Map();
    /** In-flight recompute per cache key, shared by concurrent queries. */
    inflight = new Map();

    /**
     * @param ctx - host context.
     * @param config - validated plugin configuration.
     */
    constructor(ctx, config = {}) {
      super(ctx, "usageStats");
      // Run the @Remote decorator initializers (they mark this prototype for
      // the gateway's SRC discovery).
      __runInitializers(this, _instanceExtraInitializers);
      this.sessionsRoot = dshHomePath("sessions");
      this.pricing = config.pricing ?? [];
      this.defaultPricing = config.defaultPricing ?? {};
      this.currency = config.currency ?? "CNY";
      this.usdCnyRate = config.usdCnyRate ?? 7.2;
      this.maxSessions = config.maxSessions ?? 20;
      this.maxRecentCalls = config.maxRecentCalls ?? 50;
      this.seriesHours = config.seriesHours ?? 168;
      this.refreshSeconds = config.refreshSeconds ?? 30;
      this.monthlyBudget = typeof config.monthlyBudget === "number" && Number.isFinite(config.monthlyBudget) ? config.monthlyBudget : null;
      this.plans = config.plans ?? [];
      this.ledger = new SpendLedger(config.ledgerPath ?? dshHomePath("spend-ledger.sqlite"), {
        pricing: this.pricing,
        usdCnyRate: this.usdCnyRate,
        priceVersion: config.priceVersion ?? "2026-08-21",
        fxVersion: config.fxVersion ?? "fixed-2026-08-21",
      });
      this.accounting = new SpendAccountingService(ctx, this.ledger, async () => {
        const live = this.ctx.sessions.list().map((session) => ({
          id: session.id, events: session.events, header: session.header,
        }));
        const scanned = await scanSessions(this.sessionsRoot, live);
        this.ledger.setPricing(this.pricingFor(scanned.calls));
        this.ledger.ingestMany(scanned.calls);
      });
      // Drop the cached snapshot when the plugin is reconfigured/reloaded.
      ctx.effect(() => () => {
        this.cache = new Map();
        this.inflight = new Map();
        this.ledger.close();
      }, "dsh-spend: reset cache on unload");
    }

    /** Resolve explicit and knowledge-base exact rates without a fuzzy fallback. */
    pricingFor(calls) {
      const providers = new Set(calls.map((call) => call.provider).filter((value) => typeof value === "string" && value.length > 0));
      const explicit = new Set(this.pricing.map((row) => `${row.provider ?? "*"}:${row.model}`));
      const automatic = [];
      for (const provider of providers) {
        for (const rate of autoRatesFor(provider)) {
          if (!explicit.has(`${rate.provider}:${rate.model}`) && !explicit.has(`*:${rate.model}`)) automatic.push(rate);
        }
      }
      return [...this.pricing, ...automatic];
    }

    /**
     * One statistics snapshot over every durable session log.
     *
     * The live session registry is merged on top of the durable prefix; a
     * later sample for the same (turn, step) replaces the earlier one, so the
     * merge is idempotent and nothing is double-counted.
     *
     * @param request - optional cwd and administrator-only principalId filters.
     * @returns the aggregate snapshot (pure JSON).
     */
    async query(request) {
      const principal = this.ctx.typertGateway.currentPrincipal();
      if (principal === undefined) throw new Error("authenticated principal required");
      const cwd = typeof request?.cwd === "string" && request.cwd.length > 0 ? request.cwd : null;
      const principalId = principal.role === "admin" && typeof request?.principalId === "string" && request.principalId.length > 0
        ? request.principalId
        : null;
      const live = this.ctx.sessions.list().map((session) => ({
        id: session.id,
        events: session.events,
        header: session.header,
      }));
      const signature = await computeSignature(this.sessionsRoot, live);
      const callerScope = principal.role === "admin"
        ? `admin:${principalId ?? "*"}`
        : `${principal.source}:${principal.id}`;
      const key = `${signature}\u0000${callerScope}\u0000${cwd ?? ""}`;
      const cached = this.cache.get(key);
      if (cached !== undefined) return this.withPersonalBudget(cached, principal);
      let pending = this.inflight.get(key);
      if (pending === undefined) {
        pending = this.compute(signature, live, cwd, principal, principalId).finally(() => {
          this.inflight.delete(key);
        });
        this.inflight.set(key, pending);
      }
      return this.withPersonalBudget(await pending, principal);
    }

    /** Add the live personal allowance without pinning policy changes in the stats cache. */
    withPersonalBudget(snapshot, principal) {
      const status = this.accounting.personalBudgetStatus(principal);
      if (status === null) return { ...snapshot, personalBudget: null };
      return {
        ...snapshot,
        personalBudget: {
          currency: "CNY",
          month: status.month,
          budgetMicros: status.budgetMicros,
          usedMicros: status.usedMicros,
          remainingMicros: status.remainingMicros,
          pct: status.ratio * 100,
          warning: status.warning,
          exhausted: status.exhausted,
        },
      };
    }

    /** Replay + aggregate + price, then store the snapshot under its key. */
    async compute(signature, live, cwd, principal, principalId) {
      const scanned = await scanSessions(this.sessionsRoot, live);
      const principalCalls = callsForPrincipal(scanned.calls, principal, principalId);
      const allCwds = [...new Set(
        principalCalls
          .map((call) => call.cwd)
          .filter((value) => typeof value === "string" && value.length > 0),
      )].sort();
      const calls = cwd === null
        ? principalCalls
        : principalCalls.filter((call) => call.cwd === cwd || (typeof call.cwd === "string" && call.cwd.startsWith(`${cwd}/`)));
      const visibleSessionIds = new Set(principalCalls.map((call) => call.sessionId));
      const sessions = scanned.sessions.filter((session) => visibleSessionIds.has(session.id));
      const totalSessions = visibleSessionIds.size;
      const { decodeErrors } = scanned;

      // ── auto-discovery of billing plans ──────────────────────────────────
      // Providers that actually appear in the logs get a plan from the
      // knowledge base when the deployment did not declare one explicitly;
      // the UI marks these rows as auto-discovered.
      const discovered = new Set();
      for (const call of calls) {
        if (typeof call.provider === "string" && call.provider.length > 0) discovered.add(call.provider);
      }
      const explicit = new Set(this.plans.map((plan) => plan.provider));
      const mergedPlans = [...this.plans];
      for (const provider of discovered) {
        if (explicit.has(provider)) continue;
        const plan = autoPlanFor(provider);
        if (plan === undefined) continue;
        mergedPlans.push(plan);
      }

      // ── auto-discovery of pricing ────────────────────────────────────────
      // Providers with an official rate table in the knowledge base get
      // pricing rows automatically; an explicit user row for the same
      // (provider, model) — or a generic model row — always wins.
      const explicitPricing = new Set(this.pricing.map((row) => `${row.provider ?? "*"}:${row.model}`));
      const autoPricing = [];
      for (const provider of discovered) {
        for (const rate of autoRatesFor(provider)) {
          if (explicitPricing.has(`${rate.provider}:${rate.model}`) || explicitPricing.has(`*:${rate.model}`)) continue;
          autoPricing.push(rate);
        }
      }
      const pricing = [...this.pricing, ...autoPricing];
      this.ledger.setPricing(pricing);
      this.ledger.ingestMany(scanned.calls);

      const displayRates = pricingForDisplay(pricing, this.defaultPricing, this.currency, this.usdCnyRate);
      const displayPlans = mergedPlans.map((plan) => planForDisplay(plan, this.currency, this.usdCnyRate));
      const displayAutoDiscovered = displayPlans
        .filter((plan) => plan.auto === true)
        .map((plan) => ({
          provider: plan.provider,
          label: plan.label,
          type: plan.type,
          subscription: plan.subscription,
        }));

      const stats = buildStats(calls, displayRates.pricing, displayRates.defaultPricing, {
        maxSessions: this.maxSessions,
        maxRecentCalls: this.maxRecentCalls,
        seriesHours: this.seriesHours,
        plans: displayPlans,
      });

      // ── billing view: subscription providers count their monthly fee,
      // token providers their estimated cost (single-currency only) ─────────
      const billingParts = [];
      for (const row of stats.byProvider) {
        const plan = displayPlans.find((candidate) => candidate.provider === row.provider);
        if (plan?.type === "code" && plan.subscription?.amount !== undefined && plan.subscription.amount !== null) {
          billingParts.push({
            provider: row.provider,
            kind: "subscription",
            amount: plan.subscription.amount,
            currency: plan.subscription.currency ?? "USD",
            period: plan.subscription.period ?? "month",
          });
        } else {
          // Usage-based: estimated cost of the newest 30-day window (the
          // monthly counterpart of subscription fees), not the all-time total.
          billingParts.push({
            provider: row.provider,
            kind: "token",
            amount: stats.recentCostByProvider?.[row.provider] ?? row.cost,
            currency: this.currency,
            period: "30d",
          });
        }
      }
      const billingTotal = billingParts.every((part) => part.currency === this.currency)
        ? billingParts.reduce((sum, part) => sum + part.amount, 0)
        : null;

      // ── projected month-end spend (month-to-date cost extrapolated) ───────
      const monthStart = new Date();
      const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
      const monthToDate = (stats.byDay ?? [])
        .filter((row) => row.day.startsWith(monthKey))
        .reduce((sum, row) => sum + row.cost, 0);
      const daysElapsed = monthStart.getDate();
      const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
      const projected = daysElapsed > 0 && daysInMonth > 0 ? (monthToDate / daysElapsed) * daysInMonth : null;

      // ── budget + usage overview ──────────────────────────────────────────
      let budget = null;
      if (billingTotal !== null && this.monthlyBudget !== null && this.monthlyBudget > 0) {
        budget = {
          monthly: this.monthlyBudget,
          used: billingTotal,
          remaining: Math.max(0, this.monthlyBudget - billingTotal),
          pct: Math.min(100, (billingTotal / this.monthlyBudget) * 100),
        };
      }
      const daySet = new Set((stats.byDay ?? []).map((row) => row.day));
      const todayKey = localDay(Date.now());
      let streakDays = 0;
      if (todayKey !== undefined) {
        const cursor = new Date();
        for (;;) {
          const key = localDay(cursor.getTime());
          if (key === undefined || !daySet.has(key)) break;
          streakDays += 1;
          cursor.setDate(cursor.getDate() - 1);
        }
      }
      const overview = {
        activeDays: daySet.size,
        streakDays,
        // "Most used" = most calls (the by* rows are cost-sorted).
        topModel: [...stats.byModel].sort((a, b) => b.calls - a.calls)[0]?.model ?? null,
        topProvider: [...stats.byProvider].sort((a, b) => b.calls - a.calls)[0]?.provider ?? null,
      };

      const snapshot = {
        generatedAt: Date.now(),
        currency: this.currency,
        refreshSeconds: this.refreshSeconds,
        sessionsScanned: sessions.length,
        totalSessions,
        decodeErrors,
        // Current filter scope + the full working-directory list (the UI
        // keeps its selector stable while scoped).
        scope: { cwd },
        allCwds,
        pricing: pricingRows(displayRates.pricing, displayRates.defaultPricing),
        autoDiscovered: displayAutoDiscovered,
        billing: {
          parts: billingParts,
          total: billingTotal,
          // Projected month-end spend (usage-based cost only, no
          // subscriptions): month-to-date ÷ elapsed days × days in month.
          projected: projected === null || !Number.isFinite(projected) ? null : projected,
        },
        budget,
        overview,
        ...stats,
      };
      const callerScope = principal.role === "admin"
        ? `admin:${principalId ?? "*"}`
        : `${principal.source}:${principal.id}`;
      this.cache.set(`${signature}\u0000${callerScope}\u0000${cwd ?? ""}`, snapshot);
      return snapshot;
    }
  };
})();

export { SpendAccountingService, SpendLedger, UsageStatsService, UsageStatsService as default };
