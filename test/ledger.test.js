import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { SpendAccountingService, SpendLedger, priceUsageMicros, shanghaiMonth } from "../lib/ledger.js";
import { foldSession } from "../lib/stats.js";
import { callsForPrincipal, planForDisplay, pricingForDisplay } from "../lib/index.js";

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
