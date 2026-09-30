import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { Context } from "@deepseek-ai/cordis";
import { registerDailyReconciliation, UsageStatsService } from "../lib/index.js";
import { SpendAccountingService } from "../lib/ledger.js";
import { FOLD_VERSION, scanSessions } from "../lib/stats.js";

const time = Date.parse("2026-08-20T16:00:00Z");
const month = "2026-08";
const alice = { source: "dsh-passwords", id: "1", username: "alice", role: "user" };
const bob = { ...alice, id: "2", username: "bob" };
const pricing = [{ model: "exact", inputPerMillion: 1, outputPerMillion: 2 }];

function events(id, principal = alice, turn = 0, final = true) {
  return [
    { type: "session", id, cwd: "/workspace", createdAt: time },
    { type: "request/header", time, data: { header: { config: { provider: "test", model: "exact" } } } },
    { type: "turn/start", time, data: { turn, principal } },
    { type: "step/start", time, data: { turn, step: 0, principal } },
    final
      ? { type: "assistant/message", time, data: { turn, step: 0, usage: { inputTokens: 1_000_000 } } }
      : { type: "assistant/chunk", time, data: { turn, step: 0, chunk: { type: "usage", usage: { inputTokens: 1_000_000 } } } },
  ];
}

const encode = (records) => zstdCompressSync(Buffer.from(`${records.map((event) => JSON.stringify(event)).join("\n")}\n`));

async function fixture(t, live = []) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-spend-reconcile-"));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  ctx.provide("sessions", { list: () => live });
  const previousDshHome = process.env.DSH_HOME;
  let service;
  process.env.DSH_HOME = directory;
  try {
    service = new UsageStatsService(ctx, {
      ledgerPath: join(directory, "ledger.sqlite"), pricing, usdCnyRate: 7.2, liveRate: false,
    });
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
  }
  service.sessionsRoot = join(directory, "sessions");
  service.scanCacheFile = null;
  await service.accounting.reconcile();
  return { service, directory, live };
}

async function durable(service, id, records) {
  const directory = join(service.sessionsRoot, "workspace", id);
  await mkdir(directory, { recursive: true });
  const file = join(directory, "session.v3.jsonl.zstd");
  await writeFile(file, encode(records));
  return file;
}

test("quota reconciliation validates cold logs once and reuses unchanged folds", async (t) => {
  const { service } = await fixture(t);
  const file = await durable(service, "cold", events("cold"));
  const handle = await stat(file);
  // A dashboard cache is never sufficient evidence for the first quota check.
  service.scanCache.set(file, {
    fold: FOLD_VERSION, size: handle.size, mtimeMs: handle.mtimeMs,
    ctimeMs: handle.ctimeMs, dev: handle.dev, ino: handle.ino,
    meta: { id: "cold", createdAt: time }, samples: [], decodeError: false,
  });
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 7_200_000);
  const cached = service.accountingScanCache.get(file);
  assert.ok(cached);
  assert.equal(cached.samples.length, 1);
  await service.accounting.reconcile();
  assert.strictEqual(service.accountingScanCache.get(file), cached, "unchanged cold history is not decoded again");
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 7_200_000);

  await durable(service, "new", events("new", bob));
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(bob, month), 7_200_000);
  await rm(file);
  await service.accounting.reconcile();
  assert.equal(service.accountingScanCache.has(file), false, "removed logs leave no retained fold");
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 7_200_000, "deleting a log cannot refund recorded spend");
});

test("quota reconciliation charges new live final usage before the next model step", async (t) => {
  let records = events("live", alice, 0, false);
  const live = [{ id: "live", header: { cwd: "/workspace", createdAt: time }, snapshotEvents: () => records }];
  const { service } = await fixture(t, live);
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 0, "streaming estimates are not charged");
  records = events("live");
  await service.accounting.reconcile();
  assert.equal(service.accounting.budgetStatus(alice, 7_200_000, month).exhausted, true);
  records = [...records, ...events("live", bob, 1).slice(1)];
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 7_200_000);
  assert.equal(service.accounting.monthlyUsedMicros(bob, month), 7_200_000);
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(bob, month), 7_200_000, "live replay stays idempotent");
});

test("quota reconciliation retains the legacy live events interface", async (t) => {
  const live = [{ id: "legacy", header: { cwd: "/workspace", createdAt: time }, events: events("legacy", bob) }];
  const { service } = await fixture(t, live);
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(bob, month), 7_200_000);
});

test("same-size replacements with restored mtime invalidate the folded file", async (t) => {
  const { service } = await fixture(t);
  const bySize = new Map();
  let pair;
  for (let turn = 1; turn <= 100; turn++) {
    const buffer = encode(events("replaced", alice, turn));
    const previous = bySize.get(buffer.length);
    if (previous !== undefined) { pair = [previous, { turn, buffer }]; break; }
    bySize.set(buffer.length, { turn, buffer });
  }
  assert.ok(pair, "fixture has distinct equal-size compressed logs");
  const file = await durable(service, "replaced", []);
  await writeFile(file, pair[0].buffer);
  const fixed = new Date(time);
  await utimes(file, fixed, fixed);
  await service.accounting.reconcile();
  const before = await stat(file);
  const replacement = `${file}.replacement`;
  await writeFile(replacement, pair[1].buffer);
  await utimes(replacement, fixed, fixed);
  await rename(replacement, file);
  const after = await stat(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.ino, before.ino);
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 14_400_000, "new final step cannot be hidden by restored mtime");
});

test("fold caches missing file identity or using an earlier fold version are re-read", async (t) => {
  const { service } = await fixture(t);
  const file = await durable(service, "versioned", events("versioned"));
  const cache = new Map();
  await scanSessions(service.sessionsRoot, [], cache);
  for (const field of ["ctimeMs", "dev", "ino", "fold"]) {
    const stale = { ...cache.get(file), samples: [] };
    delete stale[field];
    cache.set(file, stale);
    const scanned = await scanSessions(service.sessionsRoot, [], cache);
    assert.equal(scanned.calls.length, 1, `missing ${field} invalidates the cache`);
  }
});

test("live delegated usage keeps the spawning session's account", async (t) => {
  const parent = { id: "parent", header: { cwd: "/workspace", createdAt: time }, snapshotEvents: () => events("parent") };
  const childRecords = events("child").map((event) => event.data?.principal === undefined
    ? event
    : { ...event, data: { ...event.data, principal: undefined } });
  const child = { id: "child", header: { cwd: "/workspace", createdAt: time, parentSession: "parent" }, snapshotEvents: () => childRecords };
  const { service } = await fixture(t, [parent, child]);
  await service.accounting.reconcile();
  assert.equal(service.accounting.monthlyUsedMicros(alice, month), 14_400_000);
  assert.equal(service.accounting.monthlyUsedMicros(bob, month), 0);
});

test("transient decode failures never suppress a later quota scan", async (t) => {
  const { service } = await fixture(t);
  const file = await durable(service, "recovered", events("recovered"));
  const cache = new Map();
  await scanSessions(service.sessionsRoot, [], cache);
  cache.set(file, { ...cache.get(file), samples: [], meta: undefined, decodeError: true });
  const recovered = await scanSessions(service.sessionsRoot, [], cache);
  assert.equal(recovered.calls.length, 1);
  assert.equal(recovered.decodeErrors, 0);

  // An invalid zstd frame must be retried, not retained.
  const broken = Buffer.alloc(64, 0xff);
  broken.set([0x28, 0xb5, 0x2f, 0xfd]);
  await writeFile(file, broken);
  const failed = await scanSessions(service.sessionsRoot, [], cache);
  assert.equal(failed.decodeErrors, 1);
  assert.equal(cache.has(file), false);
});

test("activation warms the quota scan and concurrent gates receive failures before retrying", async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  let reject;
  const pending = new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
  const accounting = new SpendAccountingService(ctx, {}, () => {
    calls++;
    return calls === 1 ? pending : Promise.resolve();
  });
  let dispose;
  const timer = {};
  registerDailyReconciliation({ effect: (activate) => { dispose = activate(); } }, accounting, 24, {
    setInterval: () => timer,
    clearInterval: (value) => assert.strictEqual(value, timer),
  });
  t.after(() => dispose());
  assert.equal(calls, 1, "activation starts the scan without waiting for a model step");
  const gate = accounting.reconcile();
  assert.equal(calls, 1, "a concurrent quota gate shares the initial scan");
  reject(new Error("synthetic reconciliation failure"));
  await assert.rejects(gate, /synthetic reconciliation failure/);
  await accounting.reconcile();
  assert.equal(calls, 2, "a failed initial scan is retried, never treated as reconciled");
});
