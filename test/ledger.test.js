import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { SpendAccountingService, SpendLedger, priceUsageMicros, shanghaiMonth } from "../lib/ledger.js";
import { foldSession } from "../lib/stats.js";
import { assertPricingAdministrator, callsForPrincipal, dispatchUsageStatsRpc, normalizePricingOverride, planForDisplay, pricingForDisplay, principalOptionsFor, UsageStatsService } from "../lib/index.js";
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
    quotaRequests: 100,
    quotaTokens: null,
    dollarsPerWeek: null,
    dollarsPerMonth: null,
    periodDays: 7,
    tiers: [
      { name: "Plus", default: true, subscription: { amount: 20, currency: "USD", period: "month" }, quotaRequests: 100, periodDays: 7 },
      { name: "Pro 5x", default: false, subscription: { amount: 100, currency: "USD", period: "month" }, quotaRequests: 500, periodDays: 7 },
      { name: "Pro 20x", default: false, subscription: { amount: 200, currency: "USD", period: "month" }, quotaRequests: 2000, periodDays: 7 },
      { name: "Business", default: false, subscription: { amount: 20, currency: "USD", period: "month" }, quotaRequests: 100, periodDays: 7 },
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

test("direct Spend RPC uses the Host principal and rejects anonymous or child mutations", async () => {
  const admin = { source: "dsh-passwords", id: "9", username: "owner", role: "admin" };
  const calls = [];
  const service = {
    queryForPrincipal: async (request, principal) => {
      calls.push(["query", request, principal]);
      return { principalId: principal.id };
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
    await dispatchUsageStatsRpc(service, "query", { args: { request: {} } }, alice),
    { principalId: alice.id },
  );
  await assert.rejects(
    dispatchUsageStatsRpc(service, "query", { args: { request: {} } }, undefined),
    /authenticated principal/,
  );
  await assert.rejects(
    dispatchUsageStatsRpc(service, "savePricing", { args: { request: {} } }, alice),
    /administrator permission/,
  );
  await dispatchUsageStatsRpc(service, "deletePricing", { args: { request: { provider: "p", model: "m" } } }, admin);
  assert.deepEqual(calls.map(([method, , principal]) => [method, principal.id]), [
    ["query", alice.id],
    ["deletePricing", admin.id],
  ]);
});

test("CNY display converts rates, schedules, subscriptions and monetary quotas", () => {
  const source = [{
    model: "exact", inputPerMillion: 1, outputPerMillion: 2,
    schedule: { peak: { inputPerMillion: 3 }, offPeak: { outputPerMillion: 4 } },
  }];
  const converted = pricingForDisplay(source, { inputPerMillion: 0.5 }, "CNY", 7.2);
  assert.equal(converted.pricing[0].inputPerMillion, 7.2);
  assert.equal(converted.pricing[0].outputPerMillion, 14.4);
  assert.equal(converted.pricing[0].schedule.peak.inputPerMillion, 21.6);
  assert.equal(converted.pricing[0].schedule.offPeak.outputPerMillion, 28.8);
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
