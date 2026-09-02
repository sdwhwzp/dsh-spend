/**
 * dsh-spend host plugin.
 *
 * An authenticated Remote service (`usageStats`) that replays the durable
 * session logs under the dsh home, aggregates provider-reported token usage across
 * every dimension the web UI asks for (totals, by model, by day, by session,
 * recent calls) and prices it with the configured per-model rates to produce
 * an estimated billing amount. The web GUI reaches it through the standard
 * generated Remote gateway.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { autoRatesFor, discoverPlans, normalizeProvider } from "./knowledge.js";
import { SpendAccountingService, SpendLedger } from "./ledger.js";
import { PROVIDER_BALANCE, PROVIDER_USAGE } from "./providers.js";
import { buildStats, computeSignature, localDay, normalizeProviderUsage, pricingRows, resolvePrice, scanSessions } from "./stats.js";

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

/** Stable account choices exposed only to an authenticated administrator. */
export function principalOptionsFor(calls, requester) {
  if (requester === null || typeof requester !== "object") throw new Error("authenticated principal required");
  if (requester.role !== "admin") return [];
  const options = new Map();
  const add = (value) => {
    if (
      value === null
      || typeof value !== "object"
      || typeof value.source !== "string"
      || typeof value.id !== "string"
      || typeof value.username !== "string"
      || (value.role !== "admin" && value.role !== "user")
      || options.has(value.id)
    ) return;
    options.set(value.id, {
      source: value.source,
      id: value.id,
      username: value.username,
      role: value.role,
    });
  };
  add(requester);
  for (const call of calls) add(call?.principal);
  return [...options.values()].sort((left, right) => {
    if (left.id === requester.id) return -1;
    if (right.id === requester.id) return 1;
    if (left.role !== right.role) return left.role === "admin" ? -1 : 1;
    return left.username.localeCompare(right.username) || left.id.localeCompare(right.id);
  });
}

/** Reject price mutations that do not come from an authenticated administrator. */
export function assertPricingAdministrator(principal) {
  if (principal === undefined || principal === null || typeof principal !== "object") {
    throw new Error("authenticated principal required");
  }
  if (principal.role !== "admin") throw new Error("administrator permission required");
}

const PRICE_FIELDS = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"];

function pricingIdentity(request) {
  if (request === null || typeof request !== "object") throw new Error("pricing request must be an object");
  const provider = typeof request.provider === "string" ? request.provider.trim() : "";
  const model = typeof request.model === "string" ? request.model.trim() : "";
  if (provider.length === 0 || provider.length > 200) throw new Error("provider must contain 1-200 characters");
  if (model.length === 0 || model.length > 200) throw new Error("model must contain 1-200 characters");
  return { provider, model };
}

/** Validate and convert one browser-entered price row to durable USD rates. */
export function normalizePricingOverride(request, usdCnyRate, now = Date.now()) {
  const identity = pricingIdentity(request);
  if (request.currency !== "USD" && request.currency !== "CNY") throw new Error("currency must be USD or CNY");
  if (typeof usdCnyRate !== "number" || !Number.isFinite(usdCnyRate) || usdCnyRate <= 0) {
    throw new Error("usdCnyRate must be positive");
  }
  const factor = request.currency === "CNY" ? usdCnyRate : 1;
  const row = { ...identity };
  for (const field of PRICE_FIELDS) {
    const value = request[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      throw new Error(`${field} must be a finite number between 0 and 1000000`);
    }
    row[field] = Math.round((value / factor) * 1_000_000_000) / 1_000_000_000;
  }
  const updatedAt = Number.isSafeInteger(now) && now > 0 ? now : Date.now();
  return {
    ...row,
    priceVersion: `custom-${updatedAt}`,
    updatedAt,
    custom: true,
  };
}

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
      ...row.schedule.after === undefined ? {} : { after: scalePriceFields(row.schedule.after, factor) },
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

/** Keep subscription plans and fixed-fee billing private to administrators. */
export function planDisclosureForPrincipal(
  principal,
  plans,
  autoDiscovered,
  plannedBillingParts,
  usageBillingParts,
) {
  if (principal.role === "admin") {
    return { plans, autoDiscovered, billingParts: plannedBillingParts };
  }
  return { plans: [], autoDiscovered: [], billingParts: usageBillingParts };
}

const MAX_CATALOG_MODELS = 1_000;

/** Validate and deduplicate the model routes submitted by the authenticated browser catalog. */
export function normalizeCatalogModels(request) {
  if (request === null || typeof request !== "object" || !Array.isArray(request.models)) {
    throw new Error("models must be an array");
  }
  if (request.models.length > MAX_CATALOG_MODELS) throw new Error(`models cannot exceed ${MAX_CATALOG_MODELS} entries`);
  const models = new Map();
  for (const candidate of request.models) {
    if (candidate === null || typeof candidate !== "object") throw new Error("each model must be an object");
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
    if (provider.length === 0 || provider.length > 200) throw new Error("provider must contain 1-200 characters");
    if (model.length === 0 || model.length > 200) throw new Error("model must contain 1-200 characters");
    models.set(`${provider}\u0000${model}`, { provider, model });
  }
  return [...models.values()];
}

/** Install periodic ledger reconciliation owned by the plugin lifecycle. */
export function registerDailyReconciliation(ctx, accounting, intervalHours, timers = globalThis) {
  const hours = typeof intervalHours === "number" && Number.isFinite(intervalHours) && intervalHours > 0
    ? intervalHours
    : 24;
  ctx.effect(() => {
    let disposed = false;
    const reconcile = () => {
      void accounting.reconcile().catch((error) => {
        if (!disposed) console.warn("[dsh-spend] 每日模型用量同步失败：", error);
      });
    };
    const timer = timers.setInterval(reconcile, hours * 60 * 60 * 1_000);
    timer?.unref?.();
    return () => {
      disposed = true;
      timers.clearInterval(timer);
    };
  }, "dsh-spend: daily model usage reconciliation");
}

/**
 * Aggregation service for the usage-stats dashboard.
 *
 * Registered as `ctx.usageStats`; the Gateway discovers its Remote markers
 * and injects the authenticated request principal for each invocation.
 */
let UsageStatsService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  return class UsageStatsService extends _classSuper {
    static {
      for (const name of ["query", "catalogPricing", "savePricing", "deletePricing"]) {
        __esDecorate(this, null, [Remote(name)], {
          kind: "method",
          name,
          static: false,
          private: false,
          access: { has: (object) => name in object, get: (object) => object[name] },
        }, null, _instanceExtraInitializers);
      }
    }
    /** Required services: live sessions and authenticated transport identity. */
    static inject = ["sessions", "typertGateway"];
    /**
     * Deployment configuration: currency, per-model rates, display limits.
     * Built-in defaults mirror the official vendor pricing (verified
     * 2026-08-14; DeepSeek pre-2026-08-17 rates) — see the profile patch for
     * the full per-model table and the change note.
     */
    static Config = z.object({
      currency: z.union([z.const("CNY"), z.const("USD")]).default("USD"),
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
      syncIntervalHours: z.number().min(1).default(24),
      ledgerPath: z.string().default(dshHomePath("spend-ledger.sqlite")),
      priceVersion: z.string().default("2026-08-27"),
      fxVersion: z.string().default("fixed-2026-08-21"),
      // Optional monthly spend budget (in the configured currency): the UI
      // shows used/remaining and turns the pill amber/red when exceeded.
      monthlyBudget: z.number().min(0),
      // Per-provider billing plans for the usage/remaining display:
      //   type 'token' — prepaid balance consumed by estimated cost;
      //   type 'code'  — per-window quotas (requests and/or tokens).
      // Code plans may declare a `quota` row with per-window caps:
      //   requestsPer5h / requestsPerDay / requestsPerWeek / requestsPerMonth,
      //   dollarsPer5h / dollarsPerDay / dollarsPerWeek / dollarsPerMonth,
      //   tokensPer5h / tokensPerDay / tokensPerWeek / tokensPerMonth,
      //   window5hMultiplier (relative 5h cap when counts are unpublished),
      //   note (free-text shown below the limits).
      // The legacy single-window fields (quotaRequests/quotaTokens +
      // periodDays) keep working for plain deployments.
      plans: z.array(z.object({
        provider: z.string().required(),
        type: z.union([z.const("token"), z.const("code")]),
        balance: z.number().min(0),
        quotaRequests: z.number().step(1).min(1),
        quotaTokens: z.number().step(1).min(1),
        periodDays: z.number().step(1).min(1),
        quota: z.object({
          requestsPer5h: z.number().min(0),
          requestsPerDay: z.number().min(0),
          requestsPerWeek: z.number().min(0),
          requestsPerMonth: z.number().min(0),
          dollarsPer5h: z.number().min(0),
          dollarsPerDay: z.number().min(0),
          dollarsPerWeek: z.number().min(0),
          dollarsPerMonth: z.number().min(0),
          tokensPer5h: z.number().min(0),
          tokensPerDay: z.number().min(0),
          tokensPerWeek: z.number().min(0),
          tokensPerMonth: z.number().min(0),
          window5hMultiplier: z.number().min(0),
          note: z.string(),
        }).default({}),
      })).default([]),
      // Live usage of subscription providers, shown directly on the plan
      // cards (percent per window + reset time) instead of locally estimated
      // quota rows. Built-in adapters (lib/providers.js) cover opencode-go
      // (Bearer API key via the credentials seam), openai-codex / claude-sub
      // (CLI OAuth credentials on disk) and github-copilot (GitHub token);
      // a usageEndpoints row here overrides the built-in URL/timeout or adds
      // a custom provider served by the generic Bearer-key path. Endpoints
      // that are reverse-engineered may fail; failures surface as a friendly
      // note on the card with the local estimate as fallback.
      usageEndpoints: z.array(z.object({
        provider: z.string().required(),
        url: z.string().required(),
        apiKeyEnv: z.string(),
        timeoutMs: z.number().step(1).min(1000),
      })).default([
        { provider: "opencode-go", url: "https://opencode.ai/zen/go/v1/usage", timeoutMs: 15000 },
      ]),
      // Fixed fallback for the UI's currency switch (USD ↔ CNY): 1 USD in
      // CNY. Used when `liveRate` is off or the quote API is unreachable.
      usdCnyRate: z.number().min(0).default(7.2),
      // When enabled, the host refreshes a live USD→CNY quote (6h cache)
      // and serves it in `rates`; failures silently fall back to the fix.
      liveRate: z.boolean().default(true),
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
    syncIntervalHours;
    monthlyBudget;
    plans;
    ledger;
    accounting;
    usageEndpoints;
    /** Live provider usage cache: `provider → { at, data }` (TTL = refresh interval). */
    usageCache = new Map();
    usageTtlMs;
    liveRate;
    /** Last fetched USD→CNY rates (live quote or fixed fallback). */
    ratesCache = null;
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
      __runInitializers(this, _instanceExtraInitializers);
      this.sessionsRoot = dshHomePath("sessions");
      this.pricing = config.pricing ?? [];
      this.defaultPricing = config.defaultPricing ?? {};
      this.currency = config.currency ?? "USD";
      this.usdCnyRate = config.usdCnyRate ?? 7.2;
      this.maxSessions = config.maxSessions ?? 20;
      this.maxRecentCalls = config.maxRecentCalls ?? 50;
      this.seriesHours = config.seriesHours ?? 168;
      this.refreshSeconds = config.refreshSeconds ?? 30;
      this.syncIntervalHours = config.syncIntervalHours ?? 24;
      this.monthlyBudget = typeof config.monthlyBudget === "number" && Number.isFinite(config.monthlyBudget) ? config.monthlyBudget : null;
      this.plans = config.plans ?? [];
      this.ledger = new SpendLedger(config.ledgerPath ?? dshHomePath("spend-ledger.sqlite"), {
        pricing: this.pricing,
        usdCnyRate: this.usdCnyRate,
        priceVersion: config.priceVersion ?? "2026-08-27",
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
      registerDailyReconciliation(ctx, this.accounting, this.syncIntervalHours);
      this.usageEndpoints = config.usageEndpoints ?? [];
      this.usageTtlMs = Math.max(15000, (config.refreshSeconds ?? 30) * 1000);
      this.usdCnyRate = typeof config.usdCnyRate === "number" && Number.isFinite(config.usdCnyRate) && config.usdCnyRate > 0 ? config.usdCnyRate : 7.2;
      this.liveRate = config.liveRate !== false;
      // Drop the cached snapshot when the plugin is reconfigured/reloaded.
      ctx.effect(() => () => {
        this.cache = new Map();
        this.inflight = new Map();
        this.ledger.close();
        this.usageCache = new Map();
      }, "dsh-spend: reset cache on unload");
    }

    /** Resolve explicit and knowledge-base exact rates without a fuzzy fallback. */
    pricingFor(calls) {
      const providers = new Set(calls.map((call) => call.provider).filter((value) => typeof value === "string" && value.length > 0));
      const custom = this.ledger.pricingOverrides();
      const customKeys = new Set(custom.map((row) => `${row.provider}:${row.model}`));
      const configured = this.pricing.filter((row) => !customKeys.has(`${row.provider ?? "*"}:${row.model}`));
      const explicitRows = [...custom, ...configured];
      const explicit = new Set(explicitRows.map((row) => `${row.provider ?? "*"}:${row.model}`));
      const automatic = [];
      for (const provider of providers) {
        for (const rate of autoRatesFor(provider)) {
          if (!explicit.has(`${rate.provider}:${rate.model}`) && !explicit.has(`*:${rate.model}`)) automatic.push(rate);
        }
      }
      return [...explicitRows, ...automatic];
    }

    /** Persist an exact internal price entered in the dashboard's display currency. */
    async savePricing(request) {
      return this.savePricingForPrincipal(request, this.ctx.typertGateway.currentPrincipal());
    }

    /** Persist one exact price for an explicitly verified administrator. */
    async savePricingForPrincipal(request, principal) {
      assertPricingAdministrator(principal);
      const row = normalizePricingOverride(request, this.usdCnyRate);
      const saved = this.ledger.savePricingOverride(row);
      this.cache = new Map();
      await this.accounting.reconcile();
      return pricingForDisplay([saved], {}, this.currency, this.usdCnyRate).pricing[0];
    }

    /** Remove one exact dashboard-managed price; prior priced entries stay frozen. */
    async deletePricing(request) {
      return this.deletePricingForPrincipal(request, this.ctx.typertGateway.currentPrincipal());
    }

    /** Remove one exact price for an explicitly verified administrator. */
    async deletePricingForPrincipal(request, principal) {
      assertPricingAdministrator(principal);
      const { provider, model } = pricingIdentity(request);
      const removed = this.ledger.deletePricingOverride(provider, model);
      this.cache = new Map();
      await this.accounting.reconcile();
      return { removed };
    }

    /**
     * USD → CNY display rate for the UI's currency switch. Tries a live
     * quote (open.er-api.com) when `liveRate` is enabled, cached for 6h;
     * any failure silently falls back to the configured fixed rate.
     */
    async getRates() {
      const now = Date.now();
      const cached = this.ratesCache;
      if (cached != null && now - cached.at < 6 * 3600 * 1000) return cached;
      const rates = { USD: 1, CNY: this.usdCnyRate, source: "fixed", at: now };
      if (this.liveRate && typeof fetch === "function") {
        try {
          const res = await fetch("https://open.er-api.com/v6/latest/USD", {
            signal: AbortSignal.timeout(5000),
            headers: { accept: "application/json" },
          });
          if (res.ok) {
            const body = await res.json();
            const cny = Number(body?.rates?.CNY);
            if (Number.isFinite(cny) && cny > 0) {
              rates.CNY = cny;
              rates.source = "live";
            }
          }
        } catch {
          // Offline or blocked quote: keep the fixed fallback rate.
        }
      }
      this.ratesCache = rates;
      return rates;
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
      return this.queryForPrincipal(request, this.ctx.typertGateway.currentPrincipal());
    }

    /** Return current rates for every model route visible to the authenticated browser. */
    async catalogPricing(request) {
      return this.catalogPricingForPrincipal(request, this.ctx.typertGateway.currentPrincipal());
    }

    /** Build one account-scoped snapshot for an explicitly verified caller. */
    async queryForPrincipal(request, principal) {
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
      let snapshot = cached;
      if (snapshot === undefined) {
        let pending = this.inflight.get(key);
        if (pending === undefined) {
          pending = this.compute(signature, live, cwd, principal, principalId).finally(() => {
            this.inflight.delete(key);
          });
          this.inflight.set(key, pending);
        }
        snapshot = await pending;
      }
      const plans = await Promise.all((snapshot.plans ?? []).map(async (plan) => {
        if (plan?.type === "code") {
          const usage = await this.fetchProviderUsage(plan.provider);
          return usage === undefined ? plan : { ...plan, providerUsage: usage };
        }
        if (plan?.type === "token") {
          const balance = await this.fetchProviderBalance(plan.provider);
          return balance === undefined ? plan : { ...plan, providerBalance: balance };
        }
        return plan;
      }));
      const withLiveProviders = plans.some((plan, index) => plan !== snapshot.plans[index])
        ? { ...snapshot, plans }
        : snapshot;
      return this.withPersonalBudget(withLiveProviders, principal);
    }

    /** Return CNY rates for every route in the browser's live model catalog. */
    async catalogPricingForPrincipal(request, principal) {
      if (principal === undefined) throw new Error("authenticated principal required");
      const models = normalizeCatalogModels(request);
      const routes = models.map(({ provider }) => ({ provider }));
      const pricing = this.pricingFor(routes);
      const display = pricingForDisplay(pricing, {}, "CNY", this.usdCnyRate).pricing;
      const now = Date.now();
      return {
        generatedAt: now,
        currency: "CNY",
        syncIntervalHours: this.syncIntervalHours,
        models: models.map(({ provider, model }) => {
          const rate = resolvePrice(model, provider, display, undefined, now);
          if (rate === undefined) return { provider, model, priced: false };
          return {
            provider,
            model,
            priced: true,
            inputPerMillion: rate.inputPerMillion ?? 0,
            outputPerMillion: rate.outputPerMillion ?? 0,
            cacheReadPerMillion: rate.cacheReadPerMillion ?? 0,
            cacheWritePerMillion: rate.cacheWritePerMillion ?? 0,
          };
        }),
      };
    }

    /** Add the live personal allowance without pinning policy changes in the stats cache. */
    withPersonalBudget(snapshot, principal) {
      const selectedPrincipal = principal.role === "admin" ? snapshot.accountFilter?.selected ?? null : null;
      const budgetPrincipal = selectedPrincipal ?? principal;
      const status = this.accounting.personalBudgetStatus(budgetPrincipal);
      if (status === null) return { ...snapshot, personalBudget: null };
      return {
        ...snapshot,
        personalBudget: {
          principal: budgetPrincipal,
          isViewer: budgetPrincipal.source === principal.source && budgetPrincipal.id === principal.id,
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

    /**
     * Fetch one subscription provider's official usage payload through its
     * built-in adapter (OpenCode Go, OpenAI Codex, Claude Code, GitHub
     * Copilot) or the generic bearer-endpoint path for custom `usageEndpoints`
     * rows. The response is normalized to per-window percent + reset rows; a
     * missing credential, non-200 response or fetch failure resolves to an
     * `{ error }` payload instead of throwing, so the dashboard never breaks
     * on a vendor endpoint. Results are cached for the refresh interval.
     * @param provider - provider id.
     * @returns the normalized usage payload, or undefined when neither a
     *   built-in adapter nor a `usageEndpoints` row exists for the provider.
     */
    async fetchProviderUsage(provider) {
      // Canonical id everywhere: adapter lookup, usageEndpoints match and the
      // cache slot must agree with the plan row's id (#10). Alias misses
      // would otherwise re-fetch (and re-error) on every query.
      const canonical = normalizeProvider(provider);
      const adapter = PROVIDER_USAGE[canonical];
      const endpoint = this.usageEndpoints.find((entry) => normalizeProvider(entry.provider) === canonical);
      if (adapter === undefined && endpoint === undefined) return undefined;
      const cached = this.usageCache.get(canonical);
      if (cached !== undefined && Date.now() - cached.at < this.usageTtlMs) return cached.data;
      let data;
      try {
        const usage = adapter !== undefined
          ? await adapter.fetch(this.providerIo(), endpoint ?? null)
          // Generic path for custom usageEndpoints rows: Bearer <PROVIDER>_API_KEY.
          : await this.fetchGenericUsage(canonical, endpoint);
        data = { ...usage, provider: canonical, source: "provider", fetchedAt: Date.now(), error: null };
      } catch (error) {
        data = {
          provider: canonical,
          source: "provider",
          fetchedAt: Date.now(),
          windows: {},
          extra: [],
          meta: null,
          error: String(error?.message ?? error),
        };
      }
      this.usageCache.set(canonical, { at: Date.now(), data });
      return data;
    }

    /**
     * Fetch one token-billed provider's official account balance through its
     * built-in balance adapter (DeepSeek, Moonshot — see
     * `lib/providers/balance-*.js`). The response is normalized to
     * `{ currency, total, granted?, toppedUp? }`; a missing credential,
     * non-200 response or fetch failure resolves to an `{ error }` payload
     * instead of throwing, so the dashboard never breaks on a vendor
     * endpoint. Results are cached for the refresh interval (separate cache
     * slot from the usage payloads).
     * @param provider - provider id.
     * @returns the normalized balance payload, or undefined when no balance
     *   adapter exists for the provider.
     */
    async fetchProviderBalance(provider) {
      // Canonical id for adapter lookup + cache slot, matching the plan row
      // canonicalization in compute() (#10): a `deepseek-official` plan must
      // still resolve the `deepseek` balance adapter.
      const canonical = normalizeProvider(provider);
      const adapter = PROVIDER_BALANCE[canonical];
      if (adapter === undefined) return undefined;
      const endpoint = this.usageEndpoints.find((entry) => normalizeProvider(entry.provider) === canonical);
      const cacheKey = `${canonical}\u0000balance`;
      const cached = this.usageCache.get(cacheKey);
      if (cached !== undefined && Date.now() - cached.at < this.usageTtlMs) return cached.data;
      let data;
      try {
        const balance = await adapter.fetch(this.providerIo(), endpoint ?? null);
        data = { provider: canonical, source: "provider", fetchedAt: Date.now(), balance, error: null };
      } catch (error) {
        data = {
          provider: canonical,
          source: "provider",
          fetchedAt: Date.now(),
          balance: null,
          error: String(error?.message ?? error),
        };
      }
      this.usageCache.set(cacheKey, { at: Date.now(), data });
      return data;
    }

    /** Generic bearer-key fetch for a custom `usageEndpoints` row (no adapter). */
    async fetchGenericUsage(provider, endpoint) {
      const envName = endpoint.apiKeyEnv ?? `${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`;
      const key = await this.resolveUsageKey(envName);
      if (typeof key !== "string" || key.length === 0) throw new Error(`API key not configured (${envName})`);
      const res = await this.providerIo().request(endpoint.url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        timeoutMs: endpoint.timeoutMs,
      });
      if (res.status === 401 || res.status === 403) throw new Error(`API key rejected (HTTP ${res.status})`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return normalizeProviderUsage(res.json, provider);
    }

    /**
     * I/O context handed to the provider adapters (injectable for tests):
     * environment, home dir, credential resolution, file reads and a timeout-
     * guarded JSON request helper.
     */
    providerIo() {
      return {
        env: process.env,
        home: os.homedir(),
        resolveRef: (envName) => this.resolveUsageKey(envName),
        readText: async (path) => {
          try {
            return await readFile(path, "utf8");
          } catch {
            return undefined;
          }
        },
        request: async (url, options = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
          let response;
          try {
            response = await fetch(url, {
              method: options.method ?? "GET",
              headers: options.headers ?? {},
              ...(options.body !== undefined ? { body: options.body } : {}),
              signal: controller.signal,
            });
          } catch (error) {
            throw Object.assign(new Error(`request failed: ${String(error?.message ?? error)}`), { code: "NETWORK" });
          } finally {
            clearTimeout(timer);
          }
          const text = await response.text();
          let json;
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          return { status: response.status, ok: response.ok, text, json };
        },
      };
    }

    /**
     * Resolve a credential by environment name: the credentials seam
     * (`ctx.credentials`) first — the managed `$DSH_HOME/.credentials.yaml`
     * document — then the process environment. The seam is read through
     * `ctx.reflect.get("credentials")`, the inject-free accessor, so the
     * plugin keeps working (with the env fallback) on profiles where the
     * credentials service is not mounted.
     */
    async resolveUsageKey(envName) {
      const credentials = this.ctx.reflect?.get("credentials", false);
      if (credentials !== undefined && typeof credentials.resolve === "function") {
        const hit = await credentials.resolve(credentialRef(envName)).catch(() => undefined);
        if (typeof hit?.value === "string" && hit.value.length > 0) return hit.value;
      }
      const fromEnv = process.env[envName];
      return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
    }

    /** Replay + aggregate + price, then store the snapshot under its key. */
    async compute(signature, live, cwd, principal, principalId) {
      const rates = await this.getRates();
      const scanned = await scanSessions(this.sessionsRoot, live);
      const accountOptions = principalOptionsFor(scanned.calls, principal);
      const selectedPrincipal = principalId === null
        ? null
        : accountOptions.find((option) => option.id === principalId) ?? null;
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
      // the UI marks these rows as auto-discovered. Dedupe and canonicalize
      // by provider id (`discoverPlans`), so alias pairs like
      // `deepseek-official` / `deepseek` render ONE plan card and the
      // balance adapter / accounting / billing match on the canonical id
      // (#10).
      const discovered = new Set();
      for (const call of calls) {
        if (typeof call.provider === "string" && call.provider.length > 0) discovered.add(call.provider);
      }
      const { autoPlans, autoDiscovered } = discoverPlans(discovered, this.plans);
      const mergedPlans = [...this.plans, ...autoPlans];
      // Wallet providers whose balance the credentials seam can read (e.g.
      // `DEEPSEEK_API_KEY` in $DSH_HOME/.credentials.yaml) get a token-plan
      // card even when their provider id never appears in the session logs —
      // usage often rides under a gateway (OpenCode Go etc.) while the
      // wallet sits with the raw API vendor. The card then shows the REAL
      // account balance from the vendor (see lib/providers/balance-*.js).
      // The seen-set is canonical, so an explicit/auto plan for the same
      // provider (however it is spelled) suppresses the wallet card.
      const balanceSeen = new Set(mergedPlans.map((plan) => normalizeProvider(plan.provider)));
      for (const walletProvider of Object.keys(PROVIDER_BALANCE)) {
        if (balanceSeen.has(walletProvider)) continue;
        const envName = `${walletProvider.replaceAll("-", "_").toUpperCase()}_API_KEY`;
        const key = await this.resolveUsageKey(envName);
        if (typeof key !== "string" || key.length === 0) continue;
        mergedPlans.push({
          provider: walletProvider,
          type: "token",
          auto: true,
          label: PROVIDER_BALANCE[walletProvider].label ?? walletProvider,
          subscription: null,
          tiers: null,
        });
        autoDiscovered.push({
          provider: walletProvider,
          label: PROVIDER_BALANCE[walletProvider].label ?? walletProvider,
          type: "token",
          subscription: null,
        });
      }

      // ── auto-discovery of pricing ────────────────────────────────────────
      // Providers with an official rate table in the knowledge base get
      // pricing rows automatically; an explicit user row for the same
      // (provider, model) — or a generic model row — always wins.
      const pricing = this.pricingFor(scanned.calls);
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
      const plannedBillingParts = [];
      const usageBillingParts = [];
      for (const row of stats.byProvider) {
        const usagePart = {
          provider: row.provider,
          kind: "token",
          amount: stats.recentCostByProvider?.[row.provider] ?? row.cost,
          currency: this.currency,
          period: "30d",
        };
        usageBillingParts.push(usagePart);
        // Match by canonical provider id: `stats.byProvider` keeps the raw
        // logged ids while auto-discovered plans carry the canonical ones
        // (`deepseek-official` → `deepseek`), see #10.
        const plan = displayPlans.find((candidate) => normalizeProvider(candidate.provider) === normalizeProvider(row.provider));
        if (plan?.type === "code" && plan.subscription?.amount !== undefined && plan.subscription.amount !== null) {
          plannedBillingParts.push({
            provider: row.provider,
            kind: "subscription",
            amount: plan.subscription.amount,
            currency: plan.subscription.currency ?? "USD",
            period: plan.subscription.period ?? "month",
          });
        } else {
          // Usage-based: estimated cost of the newest 30-day window (the
          // monthly counterpart of subscription fees), not the all-time total.
          plannedBillingParts.push(usagePart);
        }
      }
      const disclosedPlanUsage = planDisclosureForPrincipal(
        principal,
        stats.plans ?? [],
        displayAutoDiscovered,
        plannedBillingParts,
        usageBillingParts,
      );
      const billingParts = disclosedPlanUsage.billingParts;
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
        // USD ↔ CNY display rates for the client-side currency switch:
        // `rates.CNY` is the live (or fixed-fallback) USD→CNY quote.
        rates,
        refreshSeconds: this.refreshSeconds,
        sessionsScanned: sessions.length,
        totalSessions,
        decodeErrors,
        // Current filter scope + the full working-directory list (the UI
        // keeps its selector stable while scoped).
        scope: { cwd },
        accountFilter: principal.role === "admin" ? {
          selectedPrincipalId: principalId,
          selected: selectedPrincipal,
          options: accountOptions,
        } : null,
        canManagePricing: principal.role === "admin",
        allCwds,
        pricing: pricingRows(displayRates.pricing, displayRates.defaultPricing),
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
        plans: disclosedPlanUsage.plans,
        autoDiscovered: disclosedPlanUsage.autoDiscovered,
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
