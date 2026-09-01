import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { Context, Service } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { SpendAccountingService, SpendLedger, priceUsageMicros, shanghaiMonth } from "../lib/ledger.js";
import { foldSession } from "../lib/stats.js";
import { assertPricingAdministrator, callsForPrincipal, normalizeCatalogModels, normalizePricingOverride, planDisclosureForPrincipal, planForDisplay, pricingForDisplay, principalOptionsFor, registerDailyReconciliation, UsageStatsService } from "../lib/index.js";
import { autoPlanFor, autoRatesFor, normalizeProvider } from "../lib/knowledge.js";

const alice = { source: "dsh-passwords", id: "1", username: "alice", role: "user" };
const bob = { source: "dsh-passwords", id: "2", username: "bob", role: "user" };
const pricing = [{ model: "exact", inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 }];

function call(overrides = {}) {
  return {
    sessionId: "shared", turn: 1, step: 0, final: true, principal: alice,
    provider: "test", model: "exact", inputTokens: 1_000_000, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    time: Date.parse("2026-08-20T16:00:00.000Z"), ...overrides,
  };
}

test("integer pricing and Shanghai month are deterministic", () => {
  assert.deepEqual(priceUsageMicros(call(), pricing, 7.2).amountMicros, 7_200_000);
  assert.equal(shanghaiMonth(Date.parse("2026-07-31T15:59:59Z")), "2026-07");
  assert.equal(shanghaiMonth(Date.parse("2026-07-31T16:00:00Z")), "2026-08");
});

test("codex subscription calls use exact internal token rates", () => {
  assert.equal(normalizeProvider("codex"), "openai-codex");
  assert.deepEqual(autoPlanFor("codex"), {
    provider: "codex",
    type: "code",
    auto: true,
    label: "OpenAI Codex",
    subscription: { amount: 20, currency: "USD", period: "month" },
    quota: { requestsPer5h: 100, requestsPerWeek: 100 },
    quotaNote: "5h 窗口当前暂停，按周限制执行",
    quotaRequests: 100,
    quotaTokens: null,
    dollarsPerWeek: null,
    dollarsPerMonth: null,
    periodDays: 7,
    tiers: [
      { name: "Plus", default: true, subscription: { amount: 20, currency: "USD", period: "month" }, quota: { requestsPer5h: 100, requestsPerWeek: 100 }, quotaRequests: 100, periodDays: 7 },
      { name: "Pro 5x", default: false, subscription: { amount: 100, currency: "USD", period: "month" }, quota: { requestsPer5h: 500, requestsPerWeek: 500 }, quotaRequests: 500, periodDays: 7 },
      { name: "Pro 20x", default: false, subscription: { amount: 200, currency: "USD", period: "month" }, quota: { requestsPer5h: 2000, requestsPerWeek: 2000 }, quotaRequests: 2000, periodDays: 7 },
      { name: "Business", default: false, subscription: { amount: 20, currency: "USD", period: "month" }, quota: { requestsPer5h: 100, requestsPerWeek: 100 }, quotaRequests: 100, periodDays: 7 },
    ],
  });
  const codexRates = autoRatesFor("codex");
  assert.ok(codexRates.every((row) => row.provider === "codex" && row.auto === true));
  const expectedInputMicros = new Map([
    ["gpt-5.5", 36_000_000],
    ["gpt-5.4", 18_000_000],
    ["gpt-5.4-mini", 5_400_000],
    ["gpt-5.3-codex-spark", 12_600_000],
  ]);
  for (const [model, amountMicros] of expectedInputMicros) {
    assert.equal(priceUsageMicros(call({
      provider: "codex",
      model,
      inputTokens: 1_000_000,
    }), codexRates, 7.2).amountMicros, amountMicros, model);
  }
  assert.deepEqual(priceUsageMicros(call({
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    inputTokens: 1_000_000,
  }), codexRates, 7.2), {
    priced: true,
    amountMicros: 12_600_000,
    rate: {
      model: "gpt-5.3-codex-spark",
      provider: "codex",
      auto: true,
      inputPerMillion: 1.75,
      outputPerMillion: 14,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: 0,
    },
  });
});

test("zai provider prices every GLM model visible on server 28", () => {
  assert.equal(normalizeProvider("zai"), "zhipu");
  assert.equal(normalizeProvider("z-ai"), "zhipu");
  const rates = autoRatesFor("zai");
  assert.ok(rates.every((row) => row.provider === "zai" && row.auto === true));
  const expected = new Map([
    ["glm-5-turbo", { input: 1.2, cacheRead: 0.24, output: 4 }],
    ["glm-5.1", { input: 1.4, cacheRead: 0.26, output: 4.4 }],
    ["glm-5.2", { input: 1.4, cacheRead: 0.26, output: 4.4 }],
    ["glm-5v-turbo", { input: 1.2, cacheRead: 0.24, output: 4 }],
    ["GLM-5.3-Flash", { input: 0.075, cacheRead: 0.015, output: 0.25 }],
  ]);
  for (const [model, price] of expected) {
    const row = rates.find((candidate) => candidate.model === model);
    assert.ok(row, model);
    assert.deepEqual({
      input: row.inputPerMillion,
      cacheRead: row.cacheReadPerMillion,
      cacheWrite: row.cacheWritePerMillion,
      output: row.outputPerMillion,
    }, { ...price, cacheWrite: 0 }, model);
  }
  assert.equal(priceUsageMicros(call({
    provider: "zai",
    model: "GLM-5.3-Flash",
    time: Date.parse("2026-09-09T23:59:59+08:00"),
  }), rates, 7.2).amountMicros, 540_000);
  assert.equal(priceUsageMicros(call({
    provider: "zai",
    model: "GLM-5.3-Flash",
    time: Date.parse("2026-09-10T00:00:00+08:00"),
  }), rates, 7.2).amountMicros, 1_080_000);
});

test("DeepSeek vision experimental calls use the V4 Pro internal rate", () => {
  const rates = autoRatesFor("deepseek-official");
  const pro = rates.find((row) => row.model === "deepseek-v4-pro");
  const vision = rates.find((row) => row.model === "deepseek-v4-flash-vision-exp");
  assert.ok(pro);
  assert.ok(vision);
  assert.deepEqual(
    { ...vision, model: "deepseek-v4-pro" },
    pro,
  );

  for (const time of [
    Date.parse("2026-08-16T12:00:00+08:00"),
    Date.parse("2026-08-20T10:00:00+08:00"),
    Date.parse("2026-08-20T20:00:00+08:00"),
  ]) {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, time };
    assert.equal(
      priceUsageMicros(call({ ...usage, provider: "deepseek-official", model: vision.model }), rates, 7.2).amountMicros,
      priceUsageMicros(call({ ...usage, provider: "deepseek-official", model: pro.model }), rates, 7.2).amountMicros,
    );
  }
});

test("durable turn/step principals survive shared-session folding", () => {
  const events = [
    { type: "turn/start", time: 1, data: { turn: 1, principal: alice } },
    { type: "step/start", time: 2, data: { turn: 1, step: 0, principal: alice } },
    { type: "request/header", time: 3, data: { header: { config: { provider: "test", model: "exact" } } } },
    { type: "assistant/message", time: 4, data: { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 2 } } },
    { type: "turn/start", time: 5, data: { turn: 2, principal: bob } },
    { type: "step/start", time: 6, data: { turn: 2, step: 0, principal: bob } },
    { type: "assistant/message", time: 7, data: { turn: 2, step: 0, usage: { inputTokens: 20, outputTokens: 3 } } },
  ];
  const calls = foldSession(events, { id: "shared", createdAt: 1 });
  assert.deepEqual(calls.map((entry) => [entry.turn, entry.principal.id, entry.final]), [[1, "1", true], [2, "2", true]]);
});

test("legacy logs recover each step owner from its authenticated user message", () => {
  const events = [
    { type: "turn/start", time: 1, data: { turn: 1 } },
    { type: "step/start", time: 2, data: { turn: 1, step: 0 } },
    { type: "user/message", time: 3, data: { role: "user", principal: alice, content: [] } },
    { type: "assistant/message", time: 4, data: { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 2 } } },
    { type: "turn/start", time: 5, data: { turn: 2 } },
    { type: "step/start", time: 6, data: { turn: 2, step: 0 } },
    { type: "user/message", time: 7, data: { role: "user", principal: bob, content: [] } },
    { type: "assistant/message", time: 8, data: { turn: 2, step: 0, usage: { inputTokens: 20, outputTokens: 3 } } },
  ];
  const calls = foldSession(events, { id: "legacy-shared", createdAt: 1 });
  assert.deepEqual(calls.map((entry) => [entry.turn, entry.principal.id]), [[1, "1"], [2, "2"]]);
});

test("dashboard call scopes cannot be widened by an ordinary user", () => {
  const calls = [call({ turn: 1, principal: alice }), call({ turn: 2, principal: bob })];
  assert.deepEqual(callsForPrincipal(calls, alice, "2").map((entry) => entry.turn), [1]);
  assert.deepEqual(callsForPrincipal(calls, { ...alice, role: "admin" }, "2").map((entry) => entry.turn), [2]);
  assert.deepEqual(callsForPrincipal(calls, { ...alice, role: "admin" }).map((entry) => entry.turn), [1, 2]);
  assert.throws(() => callsForPrincipal(calls, undefined), /authenticated principal/);
});

test("administrator account options include self and distinct durable principals", () => {
  const admin = { source: "dsh-passwords", id: "9", username: "owner", role: "admin" };
  const calls = [
    call({ turn: 1, principal: bob }),
    call({ turn: 2, principal: alice }),
    call({ turn: 3, principal: bob }),
  ];
  assert.deepEqual(principalOptionsFor(calls, admin), [admin, alice, bob]);
  assert.deepEqual(principalOptionsFor(calls, alice), []);
  assert.throws(() => principalOptionsFor(calls, undefined), /authenticated principal/);
});

test("only administrators can normalize durable display-currency price overrides", () => {
  const admin = { source: "dsh-passwords", id: "9", username: "owner", role: "admin" };
  assert.doesNotThrow(() => assertPricingAdministrator(admin));
  assert.throws(() => assertPricingAdministrator(alice), /administrator permission/);
  assert.throws(() => assertPricingAdministrator(undefined), /authenticated principal/);
  assert.deepEqual(normalizePricingOverride({
    provider: " custom ", model: " model ", currency: "CNY",
    inputPerMillion: 7.2, outputPerMillion: 14.4,
    cacheReadPerMillion: 0.72, cacheWritePerMillion: 9,
  }, 7.2, 1234), {
    provider: "custom", model: "model",
    inputPerMillion: 1, outputPerMillion: 2,
    cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25,
    priceVersion: "custom-1234", updatedAt: 1234, custom: true,
  });
  assert.throws(() => normalizePricingOverride({ provider: "custom", model: "model", currency: "CNY" }, 7.2), /inputPerMillion/);
});

test("pricing mutation endpoints enforce admin authority and refresh accounting", async () => {
  const request = {
    provider: "private", model: "new-model", currency: "CNY",
    inputPerMillion: 7.2, outputPerMillion: 14.4,
    cacheReadPerMillion: 0.72, cacheWritePerMillion: 9,
  };
  const rejected = {
    usdCnyRate: 7.2,
  };
  await assert.rejects(
    UsageStatsService.prototype.savePricingForPrincipal.call(rejected, request, alice),
    /administrator permission/,
  );
  await assert.rejects(
    UsageStatsService.prototype.deletePricingForPrincipal.call(rejected, request, alice),
    /administrator permission/,
  );

  let saved;
  let deleted;
  let reconciled = 0;
  const admin = { source: "dsh-passwords", id: "9", username: "owner", role: "admin" };
  const service = {
    usdCnyRate: 7.2,
    currency: "CNY",
    cache: new Map([["old", {}]]),
    ledger: {
      savePricingOverride: (row) => { saved = row; return row; },
      deletePricingOverride: (provider, model) => { deleted = [provider, model]; return true; },
    },
    accounting: { reconcile: async () => { reconciled++; } },
  };
  const result = await UsageStatsService.prototype.savePricingForPrincipal.call(service, request, admin);
  assert.equal(saved.provider, "private");
  assert.equal(saved.inputPerMillion, 1);
  assert.equal(result.inputPerMillion, 7.2);
  assert.equal(reconciled, 1);
  assert.equal(service.cache.size, 0);
  assert.deepEqual(
    await UsageStatsService.prototype.deletePricingForPrincipal.call(service, request, admin),
    { removed: true },
  );
  assert.deepEqual(deleted, ["private", "new-model"]);
  assert.equal(reconciled, 2);
});

test("catalog pricing covers every visible model and marks unknown routes unpriced", async () => {
  assert.deepEqual(normalizeCatalogModels({ models: [
    { provider: " codex ", model: "gpt-5.6-sol" },
    { provider: "codex", model: "gpt-5.6-sol" },
    { provider: "private", model: "unknown" },
  ] }), [
    { provider: "codex", model: "gpt-5.6-sol" },
    { provider: "private", model: "unknown" },
  ]);
  assert.throws(() => normalizeCatalogModels({ models: [{ provider: "", model: "x" }] }), /provider/);

  const service = {
    currency: "CNY",
    usdCnyRate: 7.2,
    syncIntervalHours: 24,
    pricingFor: () => [{
      provider: "codex", model: "gpt-5.6-sol",
      inputPerMillion: 5, outputPerMillion: 30,
      cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25,
    }],
  };
  const result = await UsageStatsService.prototype.catalogPricingForPrincipal.call(service, {
    models: [
      { provider: "codex", model: "gpt-5.6-sol" },
      { provider: "private", model: "unknown" },
    ],
  }, alice);
  assert.equal(result.currency, "CNY");
  assert.equal(result.syncIntervalHours, 24);
  assert.deepEqual(result.models, [
    {
      provider: "codex", model: "gpt-5.6-sol", priced: true,
      inputPerMillion: 36, outputPerMillion: 216,
      cacheReadPerMillion: 3.6, cacheWritePerMillion: 45,
    },
    { provider: "private", model: "unknown", priced: false },
  ]);
  await assert.rejects(
    UsageStatsService.prototype.catalogPricingForPrincipal.call(service, { models: [] }, undefined),
    /authenticated principal/,
  );
});

test("daily reconciliation repeats every 24 hours and disposes with the plugin", async () => {
  let reconcileCount = 0;
  let intervalCallback;
  let intervalMs;
  let cleared = false;
  let unrefCount = 0;
  let disposer;
  const timer = { unref: () => { unrefCount++; } };
  const timers = {
    setInterval: (callback, milliseconds) => {
      intervalCallback = callback;
      intervalMs = milliseconds;
      return timer;
    },
    clearInterval: (value) => {
      assert.equal(value, timer);
      cleared = true;
    },
  };
  const ctx = {
    effect: (activate, label) => {
      assert.equal(label, "dsh-spend: daily model usage reconciliation");
      disposer = activate();
    },
  };
  registerDailyReconciliation(ctx, { reconcile: async () => { reconcileCount++; } }, 24, timers);
  await Promise.resolve();
  assert.equal(reconcileCount, 0);
  assert.equal(intervalMs, 24 * 60 * 60 * 1_000);
  assert.equal(unrefCount, 1);
  intervalCallback();
  await Promise.resolve();
  assert.equal(reconcileCount, 1);
  disposer();
  assert.equal(cleared, true);
});

test("browser client synchronizes catalog prices and decorates every model-menu row", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /await ctx\.remote\.\$mount\(USAGE_STATS_REMOTE\)/);
  assert.match(source, /ctx\.remote\.session\.modelCatalog\(\)/);
  assert.match(source, /ctx\.inject\(\["remote", "remote\.usageStats"\]/);
  assert.doesNotMatch(source, /ctx\.remote\.usageStats/);
  assert.match(source, /usageStats\[method\]\(request\)/);
  assert.doesNotMatch(source, /ctx\.connection/);
  assert.match(source, /callUsageStats\(usageStats, "catalogPricing", \{ models \}\)/);
  assert.match(source, /MutationObserver\(decorate\)/);
  assert.match(source, /data-dsh-spend-model-price/);
  assert.match(source, /MODEL_PRICE_SYNC_DEFAULT_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /MODEL_PRICE_SYNC_RETRY_MS = 30 \* 1000/);
  assert.match(source, /pricing\.modelUnpriced/);
});

test("browser client resolves the mounted usageStats namespace through an exact Cordis v4 inject", async () => {
  let registration;
  const document = {
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, remove: () => {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  class TestMutationObserver {
    observe() {}
    disconnect() {}
  }
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    clearTimeout: () => {},
    console,
    document,
    HTMLElement: class {},
    MutationObserver: TestMutationObserver,
    setTimeout: () => 1,
    window: { __ModuleLoader__: { load: (value) => { registration = value; } } },
  });
  assert.equal(registration?.id, "dsh-spend");
  let renderCount = 0;
  const browser = registration.factory((id) => {
    if (id === "react") return {};
    if (id === "react/jsx-runtime") return { Fragment: Symbol("Fragment"), jsx: (type, props) => ({ type, props }) };
    if (id === "react-dom/client") {
      return { createRoot: () => ({ render: () => { renderCount++; }, unmount: () => {} }) };
    }
    throw new Error(`unexpected browser dependency ${id}`);
  });
  assert.deepEqual([...browser.inject], ["locale", "remote", "remote.session"]);
  assert.equal(browser.inject.includes("remote.usageStats"), false);

  let catalogPricingCalls = 0;
  const usageStats = {
    catalogPricing: async () => {
      catalogPricingCalls++;
      return { ok: true, value: { currency: "USD", models: [], syncIntervalHours: 24 } };
    },
  };
  let mounted = false;
  let disposed = false;
  class TestRemote extends Service {
    constructor(ctx) {
      super(ctx, "remote");
    }

    async $mount(contribution) {
      assert.equal(contribution.package, "dsh-spend");
      mounted = true;
      const child = this.ctx.plugin({
        name: "remote.usageStats",
        apply: (ctx) => { ctx.provide("remote.usageStats", usageStats); },
      });
      await child.await();
      return async () => {
        disposed = true;
        await child.dispose();
      };
    }
  }
  class TestLocale extends Service {
    constructor(ctx) {
      super(ctx, "locale");
    }

    register() {
      return () => {};
    }

    bind() {
      return (key) => key;
    }
  }

  const ctx = new Context();
  new TestRemote(ctx);
  new TestLocale(ctx);
  const session = ctx.plugin({
    name: "remote.session",
    apply: (scope) => {
      scope.provide("remote.session", {
        modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
      });
    },
  });
  await session.await();
  const fiber = ctx.plugin({
    inject: browser.inject,
    apply: async (scope) => {
      const disposeRemote = await browser.apply(scope);
      assert.equal(mounted, true);
      assert.throws(
        () => scope.remote.usageStats,
        /cannot get property "remote\.usageStats" without inject/,
      );
      return disposeRemote;
    },
  });
  await fiber.await();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(catalogPricingCalls, 1);
  assert.equal(renderCount, 1);
  assert.equal(disposed, false);
  await fiber.dispose();
  assert.equal(disposed, true);
  await session.dispose();
});

test("package and lockfile versions stay synchronized", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(packageJson.version, "0.6.3");
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages[""].version, packageJson.version);
});

test("Remote entrypoints use the Gateway principal and reject anonymous or child mutations", async () => {
  const admin = { source: "dsh-passwords", id: "9", username: "owner", role: "admin" };
  const calls = [];
  let principal = alice;
  const service = {
    ctx: { typertGateway: { currentPrincipal: () => principal } },
    queryForPrincipal: async (request, principal) => {
      if (principal === undefined) {
        return UsageStatsService.prototype.queryForPrincipal.call(service, request, principal);
      }
      calls.push(["query", request, principal]);
      return { principalId: principal.id };
    },
    catalogPricingForPrincipal: async (request, principal) => {
      calls.push(["catalogPricing", request, principal]);
      return { models: request.models };
    },
    savePricingForPrincipal: async (request, principal) => {
      assertPricingAdministrator(principal);
      calls.push(["savePricing", request, principal]);
      return request;
    },
    deletePricingForPrincipal: async (request, principal) => {
      assertPricingAdministrator(principal);
      calls.push(["deletePricing", request, principal]);
      return request;
    },
  };

  assert.deepEqual(
    await UsageStatsService.prototype.query.call(service, {}),
    { principalId: alice.id },
  );
  principal = undefined;
  await assert.rejects(
    UsageStatsService.prototype.query.call(service, {}),
    /authenticated principal/,
  );
  principal = alice;
  assert.deepEqual(
    await UsageStatsService.prototype.catalogPricing.call(service, { models: [] }),
    { models: [] },
  );
  await assert.rejects(
    UsageStatsService.prototype.savePricing.call(service, {}),
    /administrator permission/,
  );
  principal = admin;
  await UsageStatsService.prototype.deletePricing.call(service, { provider: "p", model: "m" });
  assert.deepEqual(calls.map(([method, , principal]) => [method, principal.id]), [
    ["query", alice.id],
    ["catalogPricing", alice.id],
    ["deletePricing", admin.id],
  ]);
});

test("Spend exposes all four alpha.1 source-mode Remote markers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-spend-remote-"));
  const ctx = new Context();
  try {
    const service = new UsageStatsService(ctx, {
      ledgerPath: join(directory, "ledger.sqlite"),
      liveRate: false,
    });
    assert.equal(service.typertRemote.service, service);
    assert.equal(service.typertRemote.serviceKey, "usageStats");
    assert.equal(service.typertRemote.namespace, "usageStats");
    assert.deepEqual(remoteMethods(service), [
      { method: "query", invocation: { kind: "direct" } },
      { method: "catalogPricing", invocation: { kind: "direct" } },
      { method: "savePricing", invocation: { kind: "direct" } },
      { method: "deletePricing", invocation: { kind: "direct" } },
    ]);
  } finally {
    await ctx.fiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CNY display converts rates, schedules, subscriptions and monetary quotas", () => {
  const source = [{
    model: "exact", inputPerMillion: 1, outputPerMillion: 2,
    schedule: {
      peak: { inputPerMillion: 3 },
      offPeak: { outputPerMillion: 4 },
      after: { cacheReadPerMillion: 0.25 },
    },
  }];
  const converted = pricingForDisplay(source, { inputPerMillion: 0.5 }, "CNY", 7.2);
  assert.equal(converted.pricing[0].inputPerMillion, 7.2);
  assert.equal(converted.pricing[0].outputPerMillion, 14.4);
  assert.equal(converted.pricing[0].schedule.peak.inputPerMillion, 21.6);
  assert.equal(converted.pricing[0].schedule.offPeak.outputPerMillion, 28.8);
  assert.equal(converted.pricing[0].schedule.after.cacheReadPerMillion, 1.8);
  assert.equal(converted.defaultPricing.inputPerMillion, 3.6);
  assert.equal(source[0].inputPerMillion, 1);

  const plan = planForDisplay({
    subscription: { amount: 10, currency: "USD", period: "month" },
    dollarsPerMonth: 15,
    tiers: [{ name: "Pro", subscription: { amount: 20, currency: "USD" } }],
  }, "CNY", 7.2);
  assert.deepEqual(plan.subscription, { amount: 72, currency: "CNY", period: "month" });
  assert.equal(plan.dollarsPerMonth, 108);
  assert.deepEqual(plan.tiers[0].subscription, { amount: 144, currency: "CNY" });
});

test("subscription plan usage is disclosed only to administrators", () => {
  const admin = { ...alice, role: "admin" };
  const plans = [{ provider: "codex", type: "code", subscription: { amount: 144, currency: "CNY" } }];
  const autoDiscovered = [{ provider: "codex", label: "OpenAI Codex", type: "code" }];
  const plannedBillingParts = [{ provider: "codex", kind: "subscription", amount: 144, currency: "CNY" }];
  const usageBillingParts = [{ provider: "codex", kind: "token", amount: 3.6, currency: "CNY" }];

  assert.deepEqual(
    planDisclosureForPrincipal(admin, plans, autoDiscovered, plannedBillingParts, usageBillingParts),
    { plans, autoDiscovered, billingParts: plannedBillingParts },
  );
  assert.deepEqual(
    planDisclosureForPrincipal(alice, plans, autoDiscovered, plannedBillingParts, usageBillingParts),
    { plans: [], autoDiscovered: [], billingParts: usageBillingParts },
  );
});

test("personal budget resolvers expose current remaining CNY allowance", async () => {
  const ctx = new Context();
  const service = new SpendAccountingService(ctx, {
    monthlyUsedMicros: (principal) => principal.id === alice.id ? 250_000 : 0,
    report: () => [],
  });
  const dispose = service.registerBudgetResolver((principal) => principal.source === "dsh-passwords" ? 1_000_000 : undefined);
  assert.deepEqual(service.personalBudgetStatus(alice), {
    month: shanghaiMonth(), usedMicros: 250_000, budgetMicros: 1_000_000,
    remainingMicros: 750_000, ratio: 0.25, warning: false, exhausted: false,
  });
  dispose();
  assert.equal(service.personalBudgetStatus(alice), null);
  await ctx.fiber.dispose();
});

test("final step replay is idempotent and principal reports are isolated", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-spend-ledger-"));
  try {
    const ledger = new SpendLedger(join(directory, "ledger.sqlite"), {
      pricing, usdCnyRate: 7.2, priceVersion: "p1", fxVersion: "fx1",
    });
    assert.equal(ledger.ingestMany([call(), call()]), 1);
    assert.equal(ledger.monthlyUsedMicros(alice, "2026-08"), 7_200_000);
    assert.equal(ledger.monthlyUsedMicros(bob, "2026-08"), 0);
    ledger.ingest(call({ turn: 2, principal: bob, inputTokens: 500_000 }));
    assert.equal(ledger.report(alice, { principalId: "2", month: "2026-08" }).length, 1);
    assert.equal(ledger.report({ ...alice, role: "admin" }, { month: "2026-08" }).length, 2);
    ledger.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown models stay unpriced and can be priced later without repricing history", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-spend-reprice-"));
  const path = join(directory, "ledger.sqlite");
  try {
    const unknown = call({ model: "new-model" });
    const first = new SpendLedger(path, { pricing, usdCnyRate: 7.2, priceVersion: "p1", fxVersion: "fx1" });
    first.ingest(unknown);
    assert.equal(first.monthlyUsedMicros(alice, "2026-08"), 0);
    first.close();
    const second = new SpendLedger(path, {
      pricing: [...pricing, { model: "new-model", inputPerMillion: 3 }],
      usdCnyRate: 7.2, priceVersion: "p2", fxVersion: "fx1",
    });
    second.ingest(unknown);
    assert.equal(second.monthlyUsedMicros(alice, "2026-08"), 21_600_000);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("administrator price overrides persist and stamp their own price version", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-spend-custom-price-"));
  const path = join(directory, "ledger.sqlite");
  const custom = normalizePricingOverride({
    provider: "private-provider", model: "private-model", currency: "USD",
    inputPerMillion: 1, outputPerMillion: 2,
    cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25,
  }, 7.2, 4567);
  try {
    const first = new SpendLedger(path, { pricing: [], usdCnyRate: 7.2, priceVersion: "base", fxVersion: "fx1" });
    first.savePricingOverride(custom);
    first.setPricing(first.pricingOverrides());
    first.ingest(call({ provider: "private-provider", model: "private-model" }));
    assert.equal(first.monthlyUsedMicros(alice, "2026-08"), 7_200_000);
    assert.equal(first.report(alice, { month: "2026-08" })[0].price_version, "custom-4567");
    first.close();

    const second = new SpendLedger(path, { pricing: [], usdCnyRate: 7.2, priceVersion: "base", fxVersion: "fx1" });
    assert.deepEqual(second.pricingOverrides(), [{ ...custom }]);
    assert.equal(second.deletePricingOverride("private-provider", "private-model"), true);
    assert.deepEqual(second.pricingOverrides(), []);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
