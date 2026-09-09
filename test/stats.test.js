/**
 * Aggregation tests: canonical provider-id matching in plan accounting
 * (regression coverage for #10 — usage reported under an alias must land
 * in the plan card and count toward the token-plan used cost).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { buildStats, costOf, foldSession, scanSessions } from "../lib/stats.js";

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

test("scanSessions streams zstd frames and reuses unchanged durable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-stats-"));
  const sessionDir = join(root, "workspace", "s1");
  const file = join(sessionDir, "session.jsonl.zstd");
  const now = Date.now();
  const writeSession = async (outputTokens) => {
    const frames = [
      [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
      ],
      [
        { type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "usage", usage: { outputTokens: outputTokens - 1 } } } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens } } },
      ],
    ];
    await writeFile(
      file,
      Buffer.concat(frames.map((events) => zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)))),
    );
  };

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeSession(2);
    const fileCache = new Map();
    const first = await scanSessions(root, [], fileCache);
    assert.equal(first.totalSessions, 1);
    assert.equal(first.decodeErrors, 0);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].outputTokens, 2);

    const reused = await scanSessions(root, [], fileCache);
    assert.deepEqual(reused.calls, first.calls);
    assert.equal(fileCache.size, 1);

    await writeSession(3);
    const changedAt = new Date(Date.now() + 2000);
    await utimes(file, changedAt, changedAt);
    const updated = await scanSessions(root, [], fileCache);
    assert.equal(updated.totalSessions, 1);
    assert.equal(updated.decodeErrors, 0);
    assert.equal(updated.calls.length, 1);
    assert.equal(updated.calls[0].outputTokens, 3);

    // A live session already owns the complete event snapshot. Its durable
    // file may still be mid-write, so the scanner must not decode it again.
    await writeFile(file, Buffer.from("incomplete zstd frame"));
    const live = await scanSessions(root, [{
      id: "s1",
      events: [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens: 4 } } },
      ],
      header: { cwd: "/workspace", createdAt: now },
    }], fileCache);
    assert.equal(live.totalSessions, 1);
    assert.equal(live.decodeErrors, 0);
    assert.equal(live.calls.length, 1);
    assert.equal(live.calls[0].outputTokens, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Delegated sessions: a subagent's own turns carry no principal, so its calls
 * are unowned unless ownership resolves through the session that spawned it.
 */
test("a delegated session's calls inherit the spawning session's owner", async () => {
  const { scanSessions } = await import("../lib/stats.js");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const alice = { source: "dsh-passwords", id: "3", username: "u3", role: "user" };
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-delegated-"));
  const { zstdCompressSync } = await import("node:zlib");
  const write = async (dir, header, events, name = "session.v3.jsonl.zstd") => {
    await mkdir(join(root, "ws", dir), { recursive: true });
    const body = [header, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(root, "ws", dir, name), zstdCompressSync(Buffer.from(body)));
  };
  const turn = (principal) => [
    { type: "request/header", time: 1, data: { header: { config: { provider: "p", model: "m" } } } },
    { type: "step/start", time: 2, data: { turn: 1, step: 1, ...(principal ? { principal } : {}) } },
    { type: "assistant/message", time: 3, data: { turn: 1, step: 1, usage: { outputTokens: 10 } } },
  ];
  await write("parent", { type: "session", id: "parent", cwd: "/w", createdAt: 1 }, turn(alice));
  await write("child", { type: "session", id: "child", cwd: "/w", createdAt: 2, parentSession: "parent" }, turn(undefined));
  await write("grandchild", { type: "session", id: "gc", cwd: "/w", createdAt: 3, parentSession: "child" }, turn(undefined));
  // An orphan names a parent this scan never saw: it stays unowned rather
  // than being attributed to whoever happened to run nearby.
  await write("orphan", { type: "session", id: "orphan", cwd: "/w", createdAt: 4, parentSession: "missing" }, turn(undefined));

  const { calls } = await scanSessions(root, []);
  const bySession = new Map(calls.map((c) => [c.sessionId, c]));
  assert.equal(bySession.get("parent").principal.id, "3");
  assert.equal(bySession.get("parent").principalInherited, undefined);
  // One hop and two hops both resolve to the owner at the top of the chain.
  assert.equal(bySession.get("child").principal.id, "3");
  assert.equal(bySession.get("child").principalInherited, true);
  assert.equal(bySession.get("gc").principal.id, "3");
  assert.equal(bySession.get("gc").principalInherited, true);
  assert.equal(bySession.get("orphan").principal, undefined);
});

test("a migrated session reads its newest generation, not the name it was born with", async () => {
  const { scanSessions } = await import("../lib/stats.js");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { zstdCompressSync } = await import("node:zlib");
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-generation-"));
  const dir = join(root, "ws", "s1");
  await mkdir(dir, { recursive: true });
  const body = (outputTokens, id = "s1") => zstdCompressSync(Buffer.from([
    { type: "session", id, cwd: "/w", createdAt: 1 },
    { type: "request/header", time: 1, data: { header: { config: { provider: "p", model: "m" } } } },
    { type: "step/start", time: 2, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 3, data: { turn: 1, step: 1, usage: { outputTokens } } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n"));

  // A migration adds the successor beside the predecessor and never rewrites
  // it, so the older file stays behind with the older totals.
  await writeFile(join(dir, "session.jsonl.zstd"), body(1));
  await writeFile(join(dir, "session.v2.jsonl.zstd"), body(2));
  await writeFile(join(dir, "session.v3.jsonl.zstd"), body(3));
  const migrated = await scanSessions(root, []);
  assert.equal(migrated.calls.length, 1);
  assert.equal(migrated.calls[0].outputTokens, 3);

  // A session that never migrated still reads generation zero.
  const plain = join(root, "ws", "s2");
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, "session.jsonl.zstd"), body(7, "s2"));
  const both = await scanSessions(root, []);
  assert.deepEqual(both.calls.map((c) => c.outputTokens).sort((a, b) => a - b), [3, 7]);
});
