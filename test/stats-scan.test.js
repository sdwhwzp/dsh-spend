/** Metadata scans overlap filesystem work while preserving each scan's current file set. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { computeSignature, scanSessions } from "../lib/stats.js";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "dsh-spend-enumeration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSession(root, workspace, entry, outputTokens, name = "session.v4.jsonl.zstd", id = entry) {
  const dir = join(root, workspace, entry);
  await fs.mkdir(dir, { recursive: true });
  const events = [
    { type: "session", id, cwd: `/synthetic/${workspace}`, createdAt: 1 },
    { type: "request/header", data: { header: { config: { provider: "deepseek", model: "synthetic" } } } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { outputTokens } } },
  ];
  const file = join(dir, name);
  await fs.writeFile(file, zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n")));
  return file;
}

// The deadline only bounds broken barriers; all overlap assertions observe held operations, never elapsed time.
test("metadata reads overlap within the existing four-operation bound", { timeout: 30000 }, async (t) => {
  for (const operation of ["scanSessions", "computeSignature"]) {
    await t.test(operation, async (t) => {
      const root = await fixture(t);
      for (let workspace = 0; workspace < 5; workspace++) {
        for (let session = 0; session < 2; session++) {
          await writeSession(root, `w${workspace}`, `s${workspace}-${session}`, 1);
        }
      }
      const cache = new Map();
      await scanSessions(root, [], cache);
      const directories = new Map();
      const metadata = new Map();
      const workspaces = await fs.readdir(root);
      directories.set(root, workspaces);
      for (const workspace of workspaces) {
        const workspaceDir = join(root, workspace);
        const entries = await fs.readdir(workspaceDir);
        directories.set(workspaceDir, entries);
        for (const entry of entries) {
          const sessionDir = join(workspaceDir, entry);
          const names = await fs.readdir(sessionDir);
          directories.set(sessionDir, names);
          for (const name of names) metadata.set(join(sessionDir, name), await fs.stat(join(sessionDir, name)));
        }
      }
      const phases = Object.fromEntries(["workspace", "session", "stat"].map(name => [name, {
        entered: Promise.withResolvers(), release: Promise.withResolvers(), active: 0, peak: 0, calls: 0,
      }]));
      let active = 0;
      let peak = 0;
      const hold = async (phase, run) => {
        phase.calls++;
        phase.active++;
        active++;
        phase.peak = Math.max(phase.peak, phase.active);
        peak = Math.max(peak, active);
        phase.entered.resolve();
        try {
          await phase.release.promise;
          return await run();
        } finally {
          phase.active--;
          active--;
        }
      };
      const originalReaddir = fs.readdir;
      const originalStat = fs.stat;
      const readdirMock = t.mock.method(fs, "readdir", async (path, ...args) => {
        const parts = relative(root, String(path)).split(sep);
        const phase = parts.length === 1 && parts[0] ? phases.workspace : parts.length === 2 ? phases.session : undefined;
        if (!directories.has(String(path))) return originalReaddir(path, ...args);
        return phase === undefined ? directories.get(String(path)) : hold(phase, () => directories.get(String(path)));
      });
      const statMock = t.mock.method(fs, "stat", (path, ...args) => metadata.has(String(path))
        ? hold(phases.stat, () => metadata.get(String(path)))
        : originalStat(path, ...args));
      const restore = () => {
        readdirMock.mock.restore();
        statMock.mock.restore();
        syncBuiltinESMExports();
      };
      t.after(restore);
      syncBuiltinESMExports();
      const pending = operation === "scanSessions" ? scanSessions(root, [], cache) : computeSignature(root);
      try {
        for (const [name, phase] of Object.entries(phases)) {
          await phase.entered.promise;
          // The fixed results leave only owned promise continuations, not filesystem completion races.
          await setImmediate();
          assert.equal(phase.active, 4, `${name} reads use the four available workers before any completes`);
          phase.release.resolve();
        }
        const result = await pending;
        assert.equal(peak, 4, "metadata enumeration does not multiply nested worker limits");
        assert.deepEqual(Object.values(phases).map(phase => phase.calls), [5, 10, 10], "every directory and current file is checked");
        if (operation === "scanSessions") assert.equal(result.calls.length, 10);
        else assert.equal(result.split("\n").length, 10);
      } finally {
        for (const phase of Object.values(phases)) phase.release.resolve();
        // Drain the scanner before restoring process-global filesystem methods, including on assertion failure.
        await pending.catch((error) => { /* The awaited operation already supplies its failure to the test. */ });
        restore();
      }
    });
  }
});

test("parallel metadata preserves generation selection, directory order and immediate cache invalidation", async (t) => {
  const root = await fixture(t);
  const latest = new Map();
  for (const [workspace, amount] of [["workspace-b", 2], ["workspace-a", 1], ["workspace-c", 3]]) {
    await writeSession(root, workspace, "shared", 99, "session.v3.jsonl.zstd", "shared");
    latest.set(workspace, await writeSession(root, workspace, "shared", amount, "session.v12.jsonl.zstd", "shared"));
    await fs.writeFile(join(root, workspace, "not-a-session"), "ignored");
    await fs.writeFile(join(root, workspace, "shared", "session.v99.jsonl"), "ignored uncompressed generation");
  }
  await fs.writeFile(join(root, "not-a-workspace"), "ignored");
  const skipped = join(root, "workspace-a", "directory-generation");
  await fs.mkdir(join(skipped, "session.v13.jsonl.zstd"), { recursive: true });
  const order = (await fs.readdir(root)).filter(workspace => latest.has(workspace));
  const cache = new Map();
  const first = await scanSessions(root, [], cache);
  assert.equal(first.totalSessions, 3);
  assert.equal(first.decodeErrors, 0);
  assert.deepEqual(first.sessions.map(session => session.cwd), order.map(workspace => `/synthetic/${workspace}`));
  assert.equal(first.calls.length, 1, "repeated Session ids keep deterministic last-workspace overwrite behavior");
  assert.equal(first.calls[0].outputTokens, { "workspace-a": 1, "workspace-b": 2, "workspace-c": 3 }[order.at(-1)]);
  assert.deepEqual([...cache.keys()].sort(), [...latest.values()].sort(), "only the newest compressed regular generation is folded");
  const expectedParts = [];
  for (const [workspace, file] of latest) {
    const handle = await fs.stat(file);
    expectedParts.push(`${workspace}/shared:${handle.dev}:${handle.ino}:${handle.size}:${handle.mtimeMs}:${handle.ctimeMs}`);
  }
  const before = await computeSignature(root);
  assert.equal(before, expectedParts.sort().join("\n"), "signature entries retain the same file identities and ordering");
  const removed = order.at(-1);
  await fs.rm(join(root, removed), { recursive: true });
  const changed = order[0];
  await writeSession(root, changed, "shared", 1000, "session.v12.jsonl.zstd", "shared");
  const after = await scanSessions(root, [], cache);
  assert.equal(after.totalSessions, 2);
  assert.equal(cache.has(latest.get(removed)), false, "deleted logs do not survive a warm scan");
  assert.equal(cache.get(latest.get(changed)).samples[0].outputTokens, 1000, "every warm scan stats changed files");
  assert.notEqual(await computeSignature(root), before);
  const successor = await writeSession(root, changed, "shared", 1001, "session.v20.jsonl.zstd", "shared");
  const migrated = await scanSessions(root, [], cache);
  assert.equal(migrated.totalSessions, 2);
  assert.equal(cache.has(latest.get(changed)), false, "a new committed generation evicts the predecessor fold");
  assert.equal(cache.get(successor).samples[0].outputTokens, 1001);
});
