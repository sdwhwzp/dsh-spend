/**
 * dsh-spend host plugin.
 *
 * An authenticated Connection service (`usageStats`) that replays the durable
 * session logs under the dsh home, aggregates provider-reported token usage across
 * every dimension the web UI asks for (totals, by model, by day, by session,
 * recent calls) and prices it with the configured per-model rates to produce
 * an estimated billing amount. The web GUI reaches it through direct routes on
 * the shared `/api` channel.
 */
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { autoPlanFor, autoRatesFor, knowsProvider } from "./knowledge.js";
import { buildStats, computeSignature, localDay, pricingRows, resolvePrice, scanSessions } from "./stats.js";
import { SpendAccountingService, SpendLedger } from "./ledger.js";

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

/** Authenticated Host channel used by the Spend browser client. */
export const USAGE_STATS_CHANNEL = "/api";

/** Endpoint prefix owned by this plugin on the shared Host channel. */
export const USAGE_STATS_PREFIX = "usageStats/";

/** A malformed direct-RPC envelope from the browser client. */
class UsageStatsBadRequest extends Error {}

function usageStatsOk(value) {
  return { ok: true, value };
}

function usageStatsFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageStatsBadRequest) {
    return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
  }
  return { ok: false, error: { code: "internal", message, details: {} } };
}

/** Read the single Typert-compatible `request` argument carried by the client. */
function readUsageStatsRequest(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new UsageStatsBadRequest("payload must be an object");
  }
  const args = payload.args;
  if (args === null || typeof args !== "object" || Array.isArray(args) || !("request" in args)) {
    throw new UsageStatsBadRequest("payload.args.request is required");
  }
  return args.request;
}

/** Dispatch one direct Spend RPC with the Host-verified account principal. */
export async function dispatchUsageStatsRpc(service, endpoint, payload, principal) {
  if (principal === undefined) throw new Error("authenticated principal required");
  const request = readUsageStatsRequest(payload);
  switch (endpoint) {
    case "query":
      return service.queryForPrincipal(request, principal);
    case "catalogPricing":
      return service.catalogPricingForPrincipal(request, principal);
    case "savePricing":
      return service.savePricingForPrincipal(request, principal);
    case "deletePricing":
      return service.deletePricingForPrincipal(request, principal);
    default:
      throw new UsageStatsBadRequest(`unknown /api/${USAGE_STATS_PREFIX}${endpoint} endpoint`);
  }
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

/** Install direct Spend RPCs on the Host Connection that owns the shared `/api` route. */
function installUsageStatsRpc(owner, connection, service) {
  owner.effect(
    () => connection.rpc.intercept(
      USAGE_STATS_CHANNEL,
      (endpoint) => endpoint.startsWith(USAGE_STATS_PREFIX)
        && endpoint.length > USAGE_STATS_PREFIX.length,
      async (endpoint, payload, _signal, principal) => {
        try {
          return usageStatsOk(await dispatchUsageStatsRpc(
            service,
            endpoint.slice(USAGE_STATS_PREFIX.length),
            payload,
            principal,
          ));
        } catch (error) {
          return usageStatsFailure(error);
        }
      },
      { authority: "loopback" },
    ),
    "dsh-spend: /api/usageStats/* rpc endpoints",
  );
}

/** Register direct authenticated RPCs so linked installs do not depend on Typert marker identity. */
export function registerUsageStatsRpc(ctx, service) {
  const connection = ctx.get("connection");
  if (connection === undefined) throw new Error("dsh-spend: required Connection is unavailable");
  installUsageStatsRpc(ctx, connection, service);
}

/**
 * Aggregation service for the usage-stats dashboard.
 *
 * Registered as `ctx.usageStats`; direct Connection interceptors expose the
 * authenticated `usageStats/*` endpoints without generated descriptors.
 */
let UsageStatsService = (() => {
  let _classSuper = TypertRemoteService;
  return class UsageStatsService extends _classSuper {
    /** Required services: live sessions, authenticated transport identity and the shared Host connection. */
    static inject = ["sessions", "typertGateway", "connection"];
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
      syncIntervalHours: z.number().min(1).default(24),
      ledgerPath: z.string().default(dshHomePath("spend-ledger.sqlite")),
      usdCnyRate: z.number().min(0.000001).default(7.2),
      priceVersion: z.string().default("2026-08-27"),
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
    syncIntervalHours;
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
      this.sessionsRoot = dshHomePath("sessions");
      this.pricing = config.pricing ?? [];
      this.defaultPricing = config.defaultPricing ?? {};
      this.currency = config.currency ?? "CNY";
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
      registerUsageStatsRpc(ctx, this);
      registerDailyReconciliation(ctx, this.accounting, this.syncIntervalHours);
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

    /** Return current display-currency rates for every route in the browser's live model catalog. */
    async catalogPricingForPrincipal(request, principal) {
      if (principal === undefined) throw new Error("authenticated principal required");
      const models = normalizeCatalogModels(request);
      const routes = models.map(({ provider }) => ({ provider }));
      const pricing = this.pricingFor(routes);
      const display = pricingForDisplay(pricing, {}, this.currency, this.usdCnyRate).pricing;
      const now = Date.now();
      return {
        generatedAt: now,
        currency: this.currency,
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

    /** Replay + aggregate + price, then store the snapshot under its key. */
    async compute(signature, live, cwd, principal, principalId) {
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
        const plan = displayPlans.find((candidate) => candidate.provider === row.provider);
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
