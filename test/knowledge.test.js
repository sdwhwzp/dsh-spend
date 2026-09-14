/**
 * Knowledge-base tests: provider-id alias normalization and canonical
 * plan discovery (regression coverage for #10 — duplicate plan cards when
 * session logs report an alias such as `deepseek-official`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverPlans, normalizeProvider, opencodeGoCaps, OPENCODE_GO_MODELS, PROVIDER_ALIASES, PROVIDER_KNOWLEDGE } from "../lib/knowledge.js";

test("normalizeProvider maps every declared alias to its canonical id", () => {
  for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
    assert.equal(normalizeProvider(alias), canonical, `${alias} → ${canonical}`);
  }
  assert.equal(normalizeProvider("deepseek"), "deepseek");
  assert.equal(normalizeProvider("opencode-go"), "opencode-go");
  assert.equal(normalizeProvider(undefined), undefined);
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider(""), "");
});

test("discoverPlans: alias pair yields exactly one canonical plan", () => {
  const { autoPlans, autoDiscovered } = discoverPlans(["deepseek-official", "deepseek"]);
  assert.equal(autoPlans.length, 1);
  assert.equal(autoPlans[0].provider, "deepseek");
  assert.equal(autoPlans[0].type, "token");
  assert.equal(autoDiscovered.length, 1);
  assert.equal(autoDiscovered[0].provider, "deepseek");
});

test("discoverPlans: explicit plan suppresses the auto one (canonical spelling)", () => {
  const { autoPlans } = discoverPlans(["deepseek-official"], [{ provider: "deepseek", type: "token" }]);
  assert.equal(autoPlans.length, 0);
});

test("discoverPlans: explicit plan suppresses the auto one (alias spelling in config)", () => {
  const { autoPlans } = discoverPlans(["deepseek"], [{ provider: "deepseek-official", type: "token" }]);
  assert.equal(autoPlans.length, 0);
});

test("discoverPlans: unknown providers are skipped", () => {
  const { autoPlans, autoDiscovered } = discoverPlans(["no-such-provider", ""]);
  assert.equal(autoPlans.length, 0);
  assert.equal(autoDiscovered.length, 0);
});

test("discoverPlans: subscription plans carry canonical id + discovery record", () => {
  const { autoPlans, autoDiscovered } = discoverPlans(["copilot"]);
  assert.equal(autoPlans.length, 1);
  assert.equal(autoPlans[0].provider, "github-copilot");
  assert.equal(autoPlans[0].type, "code");
  assert.equal(autoPlans[0].subscription.amount, 10);
  assert.equal(autoDiscovered[0].provider, "github-copilot");
});

test("CN-region provider ids normalize to their canonical plan providers", () => {
  assert.equal(normalizeProvider("minimax-cn"), "minimax");
  assert.equal(normalizeProvider("zhipu-cn"), "zhipu");
});

test("discoverPlans: minimax-cn logs yield one MiniMax CODE plan (live quota, not balance)", () => {
  const { autoPlans, autoDiscovered } = discoverPlans(["minimax-cn"]);
  assert.equal(autoPlans.length, 1);
  assert.equal(autoPlans[0].provider, "minimax");
  assert.equal(autoPlans[0].type, "code", "MiniMax Token Plan has a live usage adapter, not a balance adapter");
  assert.equal(autoPlans[0].label, "MiniMax");
  assert.equal(autoDiscovered[0].provider, "minimax");
});

test("discoverPlans: minimax-cn is deduped against an explicit minimax plan", () => {
  const { autoPlans } = discoverPlans(["minimax-cn", "minimax"], [{ provider: "minimax", type: "code" }]);
  assert.equal(autoPlans.length, 0);
});
test("OpenCode Go: per-model caps use the published tiers and window shares", () => {
  const tiers = new Set(Object.values(OPENCODE_GO_MODELS).map(entry => entry.dollarsPerMonth));
  assert.deepEqual([...tiers].sort((a, b) => a - b), [15, 30, 60], "published monthly tiers");
  for (const [id, entry] of Object.entries(OPENCODE_GO_MODELS)) {
    assert.match(id, /^[a-z0-9][a-z0-9.-]*$/u, `${id} is a log-shaped model id`);
    assert.ok(entry.label.length > 0, `${id} has a label`);
    const { per5h, perWeek, perMonth } = entry.requests;
    assert.ok(per5h > 0 && perWeek >= per5h && perMonth >= perWeek, `${id} request estimates ascend`);
  }
});

test("OpenCode Go: caps follow the model, and an unknown model gets the top tier", () => {
  assert.deepEqual(opencodeGoCaps("deepseek-v4-pro"), { dollarsPer5h: 3, dollarsPerWeek: 7.5, dollarsPerMonth: 15 });
  assert.deepEqual(opencodeGoCaps("deepseek-v4-flash"), { dollarsPer5h: 6, dollarsPerWeek: 15, dollarsPerMonth: 30 });
  assert.deepEqual(opencodeGoCaps("GLM-5.3-Flash"), { dollarsPer5h: 12, dollarsPerWeek: 30, dollarsPerMonth: 60 });
  assert.deepEqual(opencodeGoCaps("not-on-this-plan"), { dollarsPer5h: 12, dollarsPerWeek: 30, dollarsPerMonth: 60 });
  assert.deepEqual(opencodeGoCaps(), { dollarsPer5h: 12, dollarsPerWeek: 30, dollarsPerMonth: 60 });
});

test("OpenCode Go: the fallback plan row states the per-model caveat and carries no request count", () => {
  const quota = PROVIDER_KNOWLEDGE["opencode-go"].plan.quota;
  assert.deepEqual(
    { dollarsPer5h: quota.dollarsPer5h, dollarsPerWeek: quota.dollarsPerWeek, dollarsPerMonth: quota.dollarsPerMonth },
    opencodeGoCaps(),
  );
  // The retired row claimed 79,050 requests a week for every model on the plan.
  assert.equal(quota.requestsPerWeek, undefined);
  assert.match(quota.note, /\$15\/\$30\/\$60/u);
  assert.equal(PROVIDER_KNOWLEDGE["opencode-go"].plan.subscription.amount, 10);
});

test("OpenCode Go: every plan model carries a token rate, so nothing shows as unpriced", () => {
  const priced = new Map(PROVIDER_KNOWLEDGE["opencode-go"].rates.map(rate => [rate.model, rate]));
  const missing = Object.keys(OPENCODE_GO_MODELS).filter(id => !priced.has(id));
  assert.deepEqual(missing, [], "plan models without a rate row");
  // The models the dashboard reported as 未计价 on 2026-09-14.
  for (const id of ["qwen3.8-flash", "deepseek-v4-flash", "glm-5.3-flash", "hy4-preview",
    "kimi-k2.7-code", "mimo-v2.5-pro", "qwen3.8-max", "grok-4.6"]) {
    assert.ok(priced.has(id), `${id} is priced`);
  }
  for (const [id, rate] of priced) {
    for (const field of ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"]) {
      assert.equal(typeof rate[field], "number", `${id}.${field} is a number`);
      assert.ok(rate[field] >= 0, `${id}.${field} is not negative`);
    }
    assert.ok(rate.outputPerMillion >= rate.inputPerMillion, `${id} output is not cheaper than input`);
  }
});

test("OpenCode Go: rates come from the plan's own catalog, not the Zen pay-as-you-go card", () => {
  const rateOf = model => PROVIDER_KNOWLEDGE["opencode-go"].rates.find(rate => rate.model === model);
  // Pins the source: the dashboard already renders luna as ¥1.44 / ¥8.64 /
  // ¥0.144 / ¥1.80 at 7.2 CNY/USD, which is this row and not the Zen card.
  assert.deepEqual(rateOf("gpt-5.6-luna"), {
    model: "gpt-5.6-luna", inputPerMillion: 0.2, outputPerMillion: 1.2, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0.25,
  });
  // Zen sells the same model at $1.74/$3.48; the Go plan charges $0.66/$1.98.
  assert.equal(rateOf("deepseek-v4-pro").inputPerMillion, 0.66);
  assert.equal(rateOf("deepseek-v4-pro").outputPerMillion, 1.98);
});
