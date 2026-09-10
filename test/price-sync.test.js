/**
 * Network price sync: reading a public catalog, mapping its time windows onto
 * a schedule, and deciding what one pass may write. The rules under test are
 * the ones that keep a fetched number from damaging a verified table.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPhase,
  fetchCatalog,
  indexCatalog,
  matchEntry,
  phaseBodyOf,
  planSync,
  syncedRateRow,
  windowsOf,
} from "../lib/price-sync.js";
import { resolvePrice } from "../lib/stats.js";

/** The DeepSeek Flash entry as the catalog publishes it: weekday peak windows in UTC. */
const FLASH_ENTRY = {
  id: "deepseek/deepseek-v4.1-flash",
  canonical_slug: "deepseek/deepseek-v4.1-flash-20260910",
  pricing: {
    prompt: "0.00000015",
    completion: "0.0000006",
    input_cache_read: "0.000000003",
    overrides: [
      { utc_days: ["saturday", "sunday"], prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
      { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 0, utc_end: 100, prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
      { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 100, utc_end: 400, prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" },
      { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 600, utc_end: 1000, prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" },
    ],
  },
};

/** A long-context surcharge: an override that is a tier, not a time of day. */
const CONTEXT_TIER_ENTRY = {
  id: "openai/gpt-6-astra",
  pricing: {
    prompt: "0.00001", completion: "0.00005", input_cache_read: "0.000001",
    overrides: [{ utc_days: [], prompt: "0.00002", completion: "0.000075", input_cache_read: "0.000002" }],
  },
};

const FLAT_ENTRY = {
  id: "z-ai/glm-5v-turbo",
  pricing: { prompt: "0.0000012", completion: "0.000004", input_cache_read: "0.00000024" },
};

test("a weekday peak window maps onto Shanghai hours", () => {
  const windows = windowsOf(FLASH_ENTRY.pricing);
  // UTC 01:00-04:00 and 06:00-10:00 are Beijing 09:00-12:00 and 14:00-18:00.
  assert.deepEqual(windows.peakHours, [[9, 12], [14, 18]]);
  assert.deepEqual(windows.peakDays, [1, 2, 3, 4, 5]);
  assert.equal(windows.peak.outputPerMillion, 1.2);
  assert.equal(windows.offPeak.outputPerMillion, 0.6);
  assert.equal(windows.peak.cacheReadPerMillion, 0.006);
});

test("a tier that is not a time of day is refused rather than read as a peak", () => {
  // The surcharge applies to long context, not to a clock window; treating it
  // as a peak period would bill every call at the higher rate.
  assert.equal(windowsOf(CONTEXT_TIER_ENTRY.pricing), undefined);
  const body = phaseBodyOf(CONTEXT_TIER_ENTRY);
  assert.deepEqual(body.peakHours, []);
  assert.equal(body.offPeak.inputPerMillion, 10);
  assert.equal(body.peak.inputPerMillion, 10);
});

test("patterns a schedule cannot express fall back to the flat rate", () => {
  const half = { prompt: "0.000001", completion: "0.000002", input_cache_read: "0" };
  const full = { prompt: "0.000002", completion: "0.000004", input_cache_read: "0" };
  const third = { prompt: "0.000003", completion: "0.000006", input_cache_read: "0" };
  // Three tiers.
  assert.equal(windowsOf({ ...half, overrides: [{ ...half }, { ...full }, { ...third }] }), undefined);
  // A boundary that is not a whole hour.
  assert.equal(windowsOf({ ...half, overrides: [{ ...half }, { ...full, utc_start: 130, utc_end: 400 }] }), undefined);
  // A window that crosses midnight once shifted into Shanghai time.
  assert.equal(windowsOf({ ...half, overrides: [{ ...half }, { ...full, utc_start: 1700, utc_end: 2000 }] }), undefined);
  // Peak windows that cover different days are not one schedule.
  assert.equal(windowsOf({
    ...half,
    overrides: [
      { ...half },
      { ...full, utc_days: ["monday"], utc_start: 100, utc_end: 400 },
      { ...full, utc_days: ["tuesday"], utc_start: 600, utc_end: 1000 },
    ],
  }), undefined);
});

test("a dated vendor id matches the catalog's plain one, and a variant never shadows it", () => {
  const index = indexCatalog([
    FLASH_ENTRY,
    { id: "deepseek/deepseek-v4.1-flash:batch", pricing: { prompt: "0", completion: "0" } },
    FLAT_ENTRY,
    { id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.00000015", completion: "0.0000005" } },
  ]);
  // The deployment's id carries the vendor's expiry decoration.
  assert.equal(matchEntry("deepseek", "deepseek-v4.1-flash-expires-on-0910", index).id, "deepseek/deepseek-v4.1-flash");
  assert.equal(matchEntry("deepseek", "deepseek-v4.1-flash", index).id, "deepseek/deepseek-v4.1-flash");
  assert.equal(matchEntry("zhipu", "glm-5v-turbo", index).id, "z-ai/glm-5v-turbo");
  // A prefix that is not a catalog id must not match a shorter neighbour.
  assert.equal(matchEntry("zhipu", "glm-6-turbo", index), undefined);
  // A provider with no catalog organization never matches.
  assert.equal(matchEntry("mac-qwen", "qwen3.8-27b-q4", index), undefined);
});

test("an unchanged observation appends nothing; a changed one appends a phase", () => {
  const body = phaseBodyOf(FLAT_ENTRY);
  const first = appendPhase(undefined, body, Date.parse("2026-09-11T00:00:00Z"));
  assert.equal(first.length, 1);
  assert.equal(first[0].effectiveAt, "2026-09-11T00:00:00.000Z");

  assert.equal(appendPhase(first, body, Date.parse("2026-09-12T00:00:00Z")), undefined, "same price, no phase");

  const dearer = phaseBodyOf({ pricing: { prompt: "0.0000024", completion: "0.000008", input_cache_read: "0.00000048" } });
  const second = appendPhase(first, dearer, Date.parse("2026-09-12T00:00:00Z"));
  assert.equal(second.length, 2);
  // The earlier phase is untouched, which is what keeps priced history meaning
  // what it meant.
  assert.deepEqual(second[0], first[0]);
});

test("a synced row prices each call under the phase live at its own time", () => {
  const body = phaseBodyOf(FLAT_ENTRY);
  const dearer = phaseBodyOf({ pricing: { prompt: "0.0000024", completion: "0.000008", input_cache_read: "0.00000048" } });
  let phases = appendPhase(undefined, body, Date.parse("2026-09-01T00:00:00Z"));
  phases = appendPhase(phases, dearer, Date.parse("2026-09-11T00:00:00Z"));
  const row = syncedRateRow({ provider: "zhipu", model: "glm-5v-turbo", phases });
  const at = (iso) => resolvePrice("glm-5v-turbo", "zhipu", [row], undefined, Date.parse(iso));

  assert.equal(at("2026-09-05T10:00:00Z").outputPerMillion, 4, "a call under the first phase keeps the first price");
  assert.equal(at("2026-09-12T10:00:00Z").outputPerMillion, 8, "a later call takes the newer phase");
});

test("a synced weekday schedule prices peak and off-peak apart", () => {
  const phases = appendPhase(undefined, phaseBodyOf(FLASH_ENTRY), Date.parse("2026-09-01T00:00:00Z"));
  const row = syncedRateRow({ provider: "deepseek", model: "deepseek-flash", phases });
  const at = (iso) => resolvePrice("deepseek-flash", "deepseek", [row], undefined, Date.parse(iso));
  assert.equal(at("2026-09-11T10:00:00+08:00").outputPerMillion, 1.2, "weekday peak hour");
  assert.equal(at("2026-09-11T20:00:00+08:00").outputPerMillion, 0.6, "weekday off-peak hour");
  assert.equal(at("2026-09-12T10:00:00+08:00").outputPerMillion, 0.6, "the same hour on a Saturday");
});

test("a pass never touches a manual override or a verified table", () => {
  const index = indexCatalog([FLASH_ENTRY, FLAT_ENTRY]);
  const wanted = [
    { provider: "deepseek", model: "deepseek-v4.1-flash-expires-on-0910" },
    { provider: "zhipu", model: "glm-5v-turbo" },
  ];
  const plan = planSync({
    wanted,
    index,
    priced: new Set(["zhipu:glm-5v-turbo"]),
    overridden: new Set(["deepseek:deepseek-v4.1-flash-expires-on-0910"]),
    observedAt: Date.parse("2026-09-11T00:00:00Z"),
  });
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.skipped.map((row) => row.reason).sort(), ["already-priced", "manual-override"]);
});

test("a pass fills a model nothing prices, which is what an unpriced row is", () => {
  const index = indexCatalog([FLASH_ENTRY, FLAT_ENTRY]);
  const plan = planSync({
    wanted: [{ provider: "deepseek", model: "deepseek-v4.1-flash-expires-on-0910" }],
    index,
    priced: new Set(),
    observedAt: Date.parse("2026-09-11T00:00:00Z"),
  });
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].catalogId, "deepseek/deepseek-v4.1-flash");
  assert.equal(plan.writes[0].phases.length, 1);
});

test("full sync is opt-in per provider and then does re-price a known model", () => {
  const index = indexCatalog([FLAT_ENTRY]);
  const wanted = [{ provider: "zhipu", model: "glm-5v-turbo" }];
  const priced = new Set(["zhipu:glm-5v-turbo"]);
  const observedAt = Date.parse("2026-09-11T00:00:00Z");

  assert.deepEqual(planSync({ wanted, index, priced, observedAt }).writes, [], "off by default");
  const opted = planSync({ wanted, index, priced, providers: ["zhipu"], observedAt });
  assert.equal(opted.writes.length, 1);
  // Even opted in, an administrator's own price still wins.
  const overridden = planSync({ wanted, index, priced, providers: ["zhipu"], overridden: new Set(["zhipu:glm-5v-turbo"]), observedAt });
  assert.deepEqual(overridden.writes, []);
});

test("a model the catalog does not carry is reported, not guessed at", () => {
  const plan = planSync({
    wanted: [{ provider: "deepseek", model: "deepseek-unreleased" }],
    index: indexCatalog([FLAT_ENTRY]),
    observedAt: Date.now(),
  });
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.unmatched, [{ provider: "deepseek", model: "deepseek-unreleased" }]);
});

test("a refusing or malformed catalog fails loudly rather than writing nothing quietly", async () => {
  await assert.rejects(
    fetchCatalog(async () => ({ ok: false, status: 503 }), "https://example.invalid", 1000),
    /responded 503/,
  );
  await assert.rejects(
    fetchCatalog(async () => ({ ok: true, json: async () => ({}) }), "https://example.invalid", 1000),
    /carried no model array/,
  );
  const data = await fetchCatalog(async () => ({ ok: true, json: async () => ({ data: [FLAT_ENTRY] }) }), "https://example.invalid", 1000);
  assert.equal(data.length, 1);
});
