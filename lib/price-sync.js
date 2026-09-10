/**
 * Network price sync.
 *
 * The shipped knowledge base is a hand-verified snapshot of each vendor's rate
 * card, which goes stale between releases and knows nothing about a model that
 * appeared after the last one — such a model prices at the default row, which
 * the dashboard reports as unpriced. This module fills that gap from a public
 * catalog without ever overwriting a rate somebody verified.
 *
 * Three rules keep a fetched number from doing damage.
 *
 * FORWARD ONLY. An observation becomes a new `schedule` phase stamped with the
 * moment it was observed, never an edit to an existing one, so every call keeps
 * pricing under the table that was live at its own timestamp and no already
 * priced history changes meaning.
 *
 * NEVER OVERWRITE A VERIFIED RATE. By default a synced row is created only for
 * a model nothing else prices (`fillUnpricedOnly`). Full sync is opt-in per
 * provider, because a public catalog is not the vendor: it converts a
 * CNY-denominated card at its own exchange rate, and it can lag a
 * republication by weeks — both observed against DeepSeek on 2026-09-11.
 *
 * MANUAL ALWAYS WINS. A dashboard override suppresses sync for that exact
 * (provider, model) entirely.
 */

/** Public catalog this build knows how to read. */
export const DEFAULT_PRICE_SOURCE = "openrouter";

/** Where the default source publishes its catalog. */
export const DEFAULT_PRICE_ENDPOINT = "https://openrouter.ai/api/v1/models";

/** dsh-spend provider id → the organization prefix the catalog uses. */
const CATALOG_ORGS = {
  deepseek: "deepseek",
  zhipu: "z-ai",
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  moonshot: "moonshotai",
  qwen: "qwen",
  google: "google",
  xai: "x-ai",
  mistral: "mistralai",
  minimax: "minimax",
};

/** Catalog id suffixes that name a billing variant rather than the model. */
const VARIANT_SUFFIXES = [":batch", ":free", ":extended", ":thinking", ":online", ":nitro", ":floor"];

/** Monday-first weekday numbers, matching `peakDays` in a schedule. */
const WEEKDAY_NUMBERS = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

/** Hours the publisher's UTC clock runs behind the Asia/Shanghai one a schedule is read in. */
const SHANGHAI_UTC_OFFSET_HOURS = 8;

/** One catalog price (per token, as a decimal string) as a per-million number. */
function perMillion(value) {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  // Six decimals is the precision the shipped tables carry.
  return Math.round(parsed * 1e6 * 1e6) / 1e6;
}

/** The four billed streams off one catalog pricing block, or undefined when it prices no tokens. */
function ratesOf(pricing) {
  const input = perMillion(pricing?.prompt);
  const output = perMillion(pricing?.completion);
  if (input === undefined || output === undefined) return undefined;
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: perMillion(pricing?.input_cache_read) ?? 0,
    cacheWritePerMillion: perMillion(pricing?.input_cache_write) ?? 0,
  };
}

/** Compare two rate objects by value, so an unchanged observation appends no phase. */
function sameRates(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return a.inputPerMillion === b.inputPerMillion
    && a.outputPerMillion === b.outputPerMillion
    && a.cacheReadPerMillion === b.cacheReadPerMillion
    && a.cacheWritePerMillion === b.cacheWritePerMillion;
}

/**
 * One `HHMM` catalog boundary as an Asia/Shanghai hour, or undefined when it
 * cannot be expressed as one.
 *
 * A schedule selects its tier by whole Shanghai hours, so a boundary at some
 * minute past the hour, or a window that crosses midnight once shifted, has no
 * faithful representation and the caller falls back to the flat rate rather
 * than inventing one.
 */
function shanghaiHour(hhmm) {
  if (!Number.isInteger(hhmm) || hhmm < 0 || hhmm > 2400) return undefined;
  if (hhmm % 100 !== 0) return undefined;
  const shifted = hhmm / 100 + SHANGHAI_UTC_OFFSET_HOURS;
  return shifted <= 24 ? shifted : undefined;
}

/**
 * A catalog's time-of-day overrides as a schedule phase body, or undefined when
 * the published pattern is not a two-tier daily window.
 *
 * The catalog also uses an override to express a tier that has nothing to do
 * with the clock — a long-context surcharge carries no days and no window —
 * and reading one of those as a peak period would bill every call at the
 * higher rate. Such a set is refused, leaving the flat published rate.
 * @param pricing - the catalog entry's pricing block.
 * @returns `{ peakHours, peakDays, peak, offPeak }`, or undefined.
 */
export function windowsOf(pricing) {
  const overrides = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
  if (overrides.length === 0) return undefined;
  const priced = overrides.map((override) => ({ override, rates: ratesOf(override) })).filter((row) => row.rates !== undefined);
  if (priced.length !== overrides.length) return undefined;

  // Exactly two tiers, or there is no peak/off-peak split to express.
  const tiers = [];
  for (const { rates } of priced) {
    if (!tiers.some((tier) => sameRates(tier, rates))) tiers.push(rates);
  }
  if (tiers.length !== 2) return undefined;
  const [first, second] = tiers;
  const peak = first.outputPerMillion >= second.outputPerMillion ? first : second;
  const offPeak = peak === first ? second : first;

  const peakRows = priced.filter((row) => sameRates(row.rates, peak));
  const peakHours = [];
  let peakDays;
  for (const { override } of peakRows) {
    const from = shanghaiHour(override.utc_start);
    const to = shanghaiHour(override.utc_end);
    // A tier that is not a clock window (a context-length surcharge) has none.
    if (from === undefined || to === undefined || from >= to) return undefined;
    peakHours.push([from, to]);
    const days = Array.isArray(override.utc_days) ? override.utc_days : [];
    const numbers = days.map((day) => WEEKDAY_NUMBERS[String(day).toLowerCase()]).filter((n) => n !== undefined);
    if (numbers.length !== days.length) return undefined;
    const key = numbers.length === 0 ? undefined : numbers.sort((a, b) => a - b).join(",");
    // Every peak window must cover the same days; a per-day table is not one
    // schedule and is left to the flat rate.
    if (peakDays === undefined) peakDays = key;
    else if (peakDays !== key) return undefined;
  }
  if (peakHours.length === 0) return undefined;
  peakHours.sort((a, b) => a[0] - b[0]);
  return {
    peakHours,
    ...peakDays === undefined ? {} : { peakDays: peakDays.split(",").map(Number) },
    peak,
    offPeak,
  };
}

/**
 * One catalog entry as the rate body of a schedule phase.
 *
 * A phase must carry both tiers — a schedule with neither falls back to the
 * row's base — so a model with no daily window publishes the same flat rate on
 * both sides with an empty peak window, which never matches.
 * @param entry - one catalog model.
 * @returns `{ peakHours, peakDays?, peak, offPeak }`, or undefined when unpriced.
 */
export function phaseBodyOf(entry) {
  const flat = ratesOf(entry?.pricing);
  if (flat === undefined) return undefined;
  const windows = windowsOf(entry?.pricing);
  if (windows !== undefined) return windows;
  return { peakHours: [], peak: flat, offPeak: flat };
}

/** Strip a billing-variant suffix so `model:batch` matches the model itself. */
function withoutVariant(id) {
  for (const suffix of VARIANT_SUFFIXES) {
    if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
  }
  return id;
}

/**
 * Index a fetched catalog by `org/model`, lowercased, variants collapsed onto
 * the plain model so a `:batch` row never shadows it.
 * @param entries - the catalog's `data` array.
 * @returns a Map from `org/model` to the entry.
 */
export function indexCatalog(entries) {
  const index = new Map();
  for (const entry of entries ?? []) {
    for (const raw of [entry?.id, entry?.canonical_slug]) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const id = withoutVariant(raw.toLowerCase());
      // A plain id wins over one recovered from a variant or a dated slug.
      if (id === raw.toLowerCase() || !index.has(id)) index.set(id, entry);
    }
  }
  return index;
}

/**
 * The catalog entry for one deployment (provider, model), or undefined.
 *
 * Vendors date and decorate their own ids — `deepseek-v4.1-flash-expires-on-0910`
 * against the catalog's `deepseek-v4.1-flash` — so an exact match is tried
 * first and then the longest catalog id the model id starts with, which keeps
 * `glm-5.3-flash` from matching a model that merely begins with `glm-5`.
 * @param provider - the deployment's provider id (already canonical).
 * @param model - the model id as the logs record it.
 * @param index - the map `indexCatalog` built.
 * @returns the matching entry, or undefined.
 */
export function matchEntry(provider, model, index) {
  const org = CATALOG_ORGS[provider];
  if (org === undefined || typeof model !== "string" || model.length === 0) return undefined;
  const wanted = model.toLowerCase();
  const exact = index.get(`${org}/${wanted}`);
  if (exact !== undefined) return exact;
  let best;
  let bestLength = 0;
  for (const [id, entry] of index) {
    if (!id.startsWith(`${org}/`)) continue;
    const tail = id.slice(org.length + 1);
    if (tail.length <= bestLength || !wanted.startsWith(tail)) continue;
    best = entry;
    bestLength = tail.length;
  }
  return best;
}

/**
 * The phase list a new observation produces, or undefined when nothing changed.
 *
 * Appending rather than replacing is what keeps priced history meaningful: the
 * previous phase stays exactly as it was and keeps pricing the calls made
 * while it was live.
 * @param phases - the phases already stored for this model.
 * @param body - the observed phase body.
 * @param observedAt - epoch ms of the observation.
 * @returns the new phase list, or undefined when the observation matches the newest phase.
 */
export function appendPhase(phases, body, observedAt) {
  const existing = Array.isArray(phases) ? phases : [];
  const newest = existing[existing.length - 1];
  if (newest !== undefined
    && sameRates(newest.peak, body.peak)
    && sameRates(newest.offPeak, body.offPeak)
    && JSON.stringify(newest.peakHours ?? []) === JSON.stringify(body.peakHours ?? [])
    && JSON.stringify(newest.peakDays ?? null) === JSON.stringify(body.peakDays ?? null)) {
    return undefined;
  }
  return [...existing, { effectiveAt: new Date(observedAt).toISOString(), ...body }];
}

/**
 * A stored synced model as a pricing row `resolvePrice` understands.
 *
 * The base fields carry the first observation so the row prices at all, and
 * every observation since sits in `schedule.phases` behind its own
 * `effectiveAt`.
 * @param row - `{ provider, model, phases }` as stored.
 * @returns a pricing row, or undefined when the row holds no phase.
 */
export function syncedRateRow(row) {
  const phases = Array.isArray(row?.phases) ? row.phases : [];
  const first = phases[0];
  if (first === undefined) return undefined;
  return {
    provider: row.provider,
    model: row.model,
    ...first.offPeak,
    schedule: { phases },
    synced: true,
  };
}

/**
 * Fetch one catalog.
 *
 * @param fetchImpl - the fetch to use.
 * @param endpoint - the catalog URL.
 * @param timeoutMs - abort after this long.
 * @returns the catalog's `data` array.
 * @throws when the response is not OK or carries no array.
 */
export async function fetchCatalog(fetchImpl, endpoint, timeoutMs) {
  const response = await fetchImpl(endpoint, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`price catalog responded ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error("price catalog carried no model array");
  return body.data;
}

/**
 * Decide what one sync pass should write.
 *
 * Pure so the decision is testable without a network or a database: the caller
 * supplies what the deployment already prices and what the catalog says, and
 * receives the rows to persist plus a per-model account of what happened.
 * @param options - `{ wanted, index, stored, priced, overridden, providers, fillUnpricedOnly, observedAt }`.
 * @returns `{ writes, skipped, unmatched, unchanged }`.
 */
export function planSync(options) {
  const {
    wanted = [], index, stored = new Map(), priced = new Set(),
    overridden = new Set(), providers = [], fillUnpricedOnly = true, observedAt = Date.now(),
  } = options;
  const allowed = new Set(providers);
  const writes = [];
  const skipped = [];
  const unmatched = [];
  const unchanged = [];
  for (const { provider, model } of wanted) {
    const key = `${provider}:${model}`;
    if (overridden.has(key)) {
      skipped.push({ provider, model, reason: "manual-override" });
      continue;
    }
    // A model something already prices is only re-priced for a provider the
    // operator put on the full-sync list.
    if (fillUnpricedOnly && priced.has(key) && !allowed.has(provider)) {
      skipped.push({ provider, model, reason: "already-priced" });
      continue;
    }
    const entry = matchEntry(provider, model, index);
    if (entry === undefined) {
      unmatched.push({ provider, model });
      continue;
    }
    const body = phaseBodyOf(entry);
    if (body === undefined) {
      unmatched.push({ provider, model });
      continue;
    }
    const phases = appendPhase(stored.get(key)?.phases, body, observedAt);
    if (phases === undefined) {
      unchanged.push({ provider, model });
      continue;
    }
    writes.push({ provider, model, phases, observedAt, catalogId: entry.id });
  }
  return { writes, skipped, unmatched, unchanged };
}
