/**
 * Aggregation tests: canonical provider-id matching in plan accounting
 * (regression coverage for #10 — usage reported under an alias must land
 * in the plan card and count toward the token-plan used cost).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStats, costOf, foldSession } from "../lib/stats.js";

const now = Date.now();
const Flash = {
  model: "deepseek-v4-flash",
  inputPerMillion: 1,
  outputPerMillion: 1,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
};
const sample = (provider, model = "deepseek-v4-flash", outputTokens = 1000) => ({
  sessionId: "s1",
  cwd: "/w",
  createdAt: now,
  time: now,
  provider,
  model,
  turn: 0,
  step: 0,
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

test("token plan: alias-reported usage lands on the canonical plan card", () => {
  const stats = buildStats([sample("deepseek-official")], [Flash], {}, {
    plans: [{ provider: "deepseek", type: "token", balance: 100 }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "deepseek");
  assert.equal(stats.plans[0].type, "token");
  // 1000 output tokens at $1/M → $0.001, counted through the alias.
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.001) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
  assert.ok(Math.abs(stats.plans[0].remaining - (100 - 0.001)) < 1e-9);
});

test("token plan: usage from BOTH spellings of one provider adds up once", () => {
  const stats = buildStats(
    [sample("deepseek-official", "deepseek-v4-flash", 1000), sample("deepseek", "deepseek-v4-flash", 1000)],
    [Flash],
    {},
    { plans: [{ provider: "deepseek", type: "token", balance: 100 }] },
  );
  assert.equal(stats.plans.length, 1);
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.002) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
});

test("code plan: quota windows accumulate alias-reported usage", () => {
  const stats = buildStats([sample("glm"), sample("glm")], [], {}, {
    plans: [{ provider: "zhipu", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "zhipu");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("non-alias providers keep their exact match behavior", () => {
  const stats = buildStats([sample("opencode-go"), sample("opencode-go")], [], {}, {
    plans: [{ provider: "opencode-go", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "opencode-go");
  assert.equal(stats.plans[0].usedRequests, 2);
});

test("minimax-cn alias usage lands on the minimax code plan windows", () => {
  const stats = buildStats([sample("minimax-cn"), sample("minimax-cn")], [], {}, {
    plans: [{ provider: "minimax", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "minimax");
  assert.equal(stats.plans[0].type, "code");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});
/**
 * Auxiliary web searches: the DeepSeek provider bills a search as ordinary
 * tokens on the serving model and logs only the request, so the dispatch is
 * the sole countable unit and the rate is the deployment's per-search average.
 */
const searchEvents = (model = "deepseek-v4-flash") => [
  { type: "turn/start", time: 1, data: { turn: 1 } },
  { type: "step/start", time: 2, data: { turn: 1, step: 1 } },
  // The dispatches follow the step's own `assistant/message`, exactly as the
  // tool loop writes them: the step is already closed when they arrive.
  {
    type: "assistant/message",
    time: 3,
    data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 0 }, message: {} },
  },
  { type: "tool/call", time: 4, data: { turn: 1, step: 1, name: "web_search" } },
  { type: "web/deepseek-search-llm-request", time: 5, data: { endpoint: "e", apiVersion: "v", body: { model } } },
  { type: "web/deepseek-search-llm-request", time: 6, data: { endpoint: "e", apiVersion: "v", body: { model } } },
  { type: "tool/result", time: 7, data: { turn: 1, step: 1 } },
];

test("counts auxiliary search dispatches on the step whose tool loop issued them", () => {
  const [call] = foldSession(searchEvents(), { id: "s1", cwd: "/w", createdAt: 0 });
  assert.equal(call.searchCalls, 2);
  assert.equal(call.searchModel, "deepseek-v4-flash");
});

test("a step with no auxiliary search carries no search fields", () => {
  const [call] = foldSession([
    { type: "turn/start", time: 1, data: { turn: 1 } },
    { type: "step/start", time: 2, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 3, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 }, message: {} } },
  ], { id: "s1", cwd: "/w", createdAt: 0 });
  assert.equal(call.searchCalls, undefined);
  assert.equal(call.searchModel, undefined);
});

test("searches price against their own serving model, and an unset rate costs nothing", () => {
  const priced = [{ model: "deepseek-v4-flash", inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0, searchPerCall: 0.5 }];
  const unpriced = [{ model: "deepseek-v4-flash", inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }];
  const call = {
    model: "some-other-model", provider: undefined, time: now,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    searchCalls: 3, searchModel: "deepseek-v4-flash",
  };
  const zero = { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
  assert.equal(costOf(call, priced, zero).costSearch, 1.5);
  assert.equal(costOf(call, priced, zero).cost, 1.5);
  assert.equal(costOf(call, unpriced, zero).costSearch, 0);
});
