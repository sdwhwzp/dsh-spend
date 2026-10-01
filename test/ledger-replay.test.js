import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpendLedger } from "../lib/ledger.js";

const alice = { source: "dsh-passwords", id: "1", username: "alice", role: "user" };
const bob = { source: "dsh-passwords", id: "2", username: "bob", role: "user" };
const pricing = [{ model: "exact", inputPerMillion: 1, outputPerMillion: 2 }];
const options = (rates = pricing) => ({ pricing: rates, usdCnyRate: 7.2, priceVersion: "p1", fxVersion: "fx1" });
const usage = (overrides = {}) => ({
  sessionId: "replay", turn: 1, step: 1, final: true, principal: alice,
  provider: "test", model: "exact", inputTokens: 1_000_000, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  time: Date.parse("2026-09-30T12:00:00Z"), ...overrides,
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-ledger-replay-"));
  const opened = new Set();
  t.after(() => {
    for (const ledger of opened) ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open(config = options()) {
      const ledger = new SpendLedger(join(directory, "ledger.sqlite"), config);
      opened.add(ledger);
      return ledger;
    },
    close(ledger) { ledger.close(); opened.delete(ledger); },
  };
}

test("priced replay skips current pricing and preserves the original account after reopening", (t) => {
  const store = fixture(t);
  const first = store.open();
  assert.equal(first.ingest(usage()), true);
  const original = first.report(alice, { month: "2026-09" });
  store.close(first);
  let pricingReads = 0;
  const config = { ...options(), get pricing() { pricingReads++; return [{ model: "exact", inputPerMillion: 99 }]; } };
  const reopened = store.open(config);
  assert.equal(reopened.ingestMany([usage(), usage({ principal: bob })]), 0);
  assert.equal(pricingReads, 0);
  assert.deepEqual(reopened.report(alice, { month: "2026-09" }), original);
  assert.equal(reopened.monthlyUsedMicros(bob, "2026-09"), 0);
});

test("priced replay observes another connection's committed row without a process cache", (t) => {
  const store = fixture(t);
  let pricingReads = 0;
  const reader = store.open({ ...options(), get pricing() { pricingReads++; return pricing; } });
  const writer = store.open();
  assert.equal(writer.ingest(usage()), true);
  assert.equal(reader.ingest(usage()), false);
  assert.equal(pricingReads, 0);
  assert.equal(reader.monthlyUsedMicros(alice, "2026-09"), 7_200_000);
});

test("a failed batch leaves every row eligible for the next reconciliation", (t) => {
  const store = fixture(t);
  const ledger = store.open(options([...pricing, { model: "broken", inputPerMillion: -1 }]));
  const calls = [usage(), usage({ turn: 2, model: "broken" })];
  assert.throws(() => ledger.ingestMany(calls), /invalid non-negative decimal/);
  assert.equal(ledger.monthlyUsedMicros(alice, "2026-09"), 0);
  assert.equal(ledger.report(alice, { month: "2026-09" }).length, 0);
  ledger.setPricing([...pricing, { model: "broken", inputPerMillion: 3 }]);
  assert.equal(ledger.ingestMany(calls), 2);
  assert.equal(ledger.monthlyUsedMicros(alice, "2026-09"), 28_800_000);
  assert.equal(ledger.ingestMany(calls), 0);
});

test("unpriced replay can acquire a price from another connection without moving account ownership", (t) => {
  const store = fixture(t);
  const reader = store.open(options([]));
  const call = usage();
  assert.equal(reader.ingest(call), true);
  assert.equal(reader.monthlyUsedMicros(alice, "2026-09"), 0);
  const writer = store.open();
  assert.equal(writer.ingest({ ...call, principal: bob }), true);
  assert.equal(reader.ingest(call), false);
  assert.equal(reader.monthlyUsedMicros(alice, "2026-09"), 7_200_000);
  assert.equal(reader.monthlyUsedMicros(bob, "2026-09"), 0);
});
