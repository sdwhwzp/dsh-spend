import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Context, Service } from "@deepseek-ai/cordis";

/**
 * The smallest React that runs this widget: sequential hook slots per render
 * pass, effects with dependency comparison, and class boundaries with
 * getDerivedStateFromError/componentDidCatch. It exists so the expanded
 * dashboard executes against a snapshot instead of being returned unevaluated.
 */
function makeMiniReact() {
  const hooks = [];
  let cursor = 0;
  let dirty = false;
  let lastSet = -1;
  const pendingEffects = [];
  const Fragment = Symbol("Fragment");
  const react = {
    Component: class {
      constructor(props) { this.props = props; this.state = {}; }
      setState(next) { Object.assign(this.state, typeof next === "function" ? next(this.state) : next); dirty = true; }
    },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === "function" ? initial() : initial;
      return [hooks[slot], (next) => { hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next; dirty = true; lastSet = slot; }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useCallback(fn, deps) {
      const slot = cursor++;
      const previous = hooks[slot];
      const same = previous !== undefined && deps !== undefined && deps.length === previous.deps.length && deps.every((d, i) => d === previous.deps[i]);
      if (!same) hooks[slot] = { deps: deps ?? [], fn };
      return hooks[slot].fn;
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      const previous = hooks[slot];
      const changed = previous === undefined || deps === undefined || deps.length !== previous.deps.length || deps.some((d, i) => d !== previous.deps[i]);
      if (changed) pendingEffects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps: deps ?? [], cleanup: fn() }; });
    },
  };
  const jsxRuntime = { Fragment, jsx: (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } }) };
  const caught = [];
  const hosts = [];
  const instances = new Map();
  function evaluate(node, stack) {
    if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) { for (const child of node) evaluate(child, stack); return; }
    const { type, props } = node;
    if (type === Fragment || typeof type === "string") {
      if (typeof type === "string") hosts.push(node);
      evaluate(props.children, stack);
      return;
    }
    if (typeof type === "function" && type.prototype && typeof type.prototype.render === "function") {
      let instance = instances.get(type);
      if (instance === undefined) { instance = new type(props); instances.set(type, instance); }
      instance.props = props;
      const next = [...stack, type.name];
      try {
        evaluate(instance.render(), next);
      } catch (error) {
        const componentStack = error.componentStack ?? next.map((n) => `at ${n}`).join("\n");
        Object.assign(instance.state, type.getDerivedStateFromError(error));
        instance.componentDidCatch?.(error, { componentStack });
        caught.push({ error, componentStack });
        evaluate(instance.render(), next);
      }
      return;
    }
    if (typeof type === "function") {
      const next = [...stack, type.name];
      let output;
      try {
        output = type(props);
      } catch (error) {
        if (error.componentStack === undefined) error.componentStack = next.slice().reverse().map((n) => `at ${n}`).join("\n");
        throw error;
      }
      evaluate(output, next);
      return;
    }
    throw new Error(`unrenderable node type ${String(type)}`);
  }
  let rootElement = null;
  function renderPass() {
    cursor = 0; dirty = false; hosts.length = 0;
    evaluate(rootElement, []);
    while (pendingEffects.length > 0) pendingEffects.shift()();
  }
  async function settle() {
    for (let i = 0; i < 20; i++) {
      renderPass();
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
      if (!dirty) return;
    }
    throw new Error(`render never settled; last state slot written: ${lastSet} = ${JSON.stringify(hooks[lastSet])?.slice(0, 80)}`);
  }
  const domClient = { createRoot: () => ({ render: (element) => { rootElement = element; }, unmount: () => {} }) };
  return { react, jsxRuntime, domClient, settle, hosts, caught };
}

async function mountWidget(snapshot, options = {}) {
  const mini = makeMiniReact();
  let registration;
  // A browser-shaped storage the test can read back, seeded per case.
  const stored = new Map(Object.entries(options.storage ?? {}));
  const listeners = new Map();
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    innerWidth: 1440,
    innerHeight: 900,
    clearInterval: () => {},
    clearTimeout: () => {},
    console: { ...console, error: () => {} },
    document: {
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
      createElement: () => ({ dataset: {}, style: {}, remove: () => {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    HTMLElement: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => { stored.set(key, String(value)); },
    },
    setInterval: () => 1,
    setTimeout: () => 1,
    window: { __ModuleLoader__: { load: (value) => { registration = value; } }, addEventListener: () => {}, removeEventListener: () => {} },
  });
  const browser = registration.factory((id) => {
    if (id === "react") return mini.react;
    if (id === "react/jsx-runtime") return mini.jsxRuntime;
    if (id === "react-dom/client") return mini.domClient;
    throw new Error(`unexpected browser dependency ${id}`);
  });
  const reports = [];
  const usageStats = {
    query: async () => ({ ok: true, value: snapshot }),
    catalogPricing: async () => ({ ok: true, value: { currency: "USD", models: [], syncIntervalHours: 24 } }),
    reportRenderFailure: async (payload) => { reports.push(payload); return { ok: true, value: { recorded: true } }; },
  };
  class TestRemote extends Service {
    constructor(ctx) { super(ctx, "remote"); }
    async $mount() {
      const child = this.ctx.plugin({ name: "remote.usageStats", apply: (ctx) => { ctx.provide("remote.usageStats", usageStats); } });
      await child.await();
      return async () => { await child.dispose(); };
    }
  }
  class TestLocale extends Service {
    constructor(ctx) { super(ctx, "locale"); }
    register() { return () => {}; }
    bind() { return (key) => key; }
  }
  const ctx = new Context();
  new TestRemote(ctx);
  new TestLocale(ctx);
  const session = ctx.plugin({ name: "remote.session", apply: (scope) => { scope.provide("remote.session", { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }); } });
  await session.await();
  const fiber = ctx.plugin({ inject: browser.inject, apply: (scope) => browser.apply(scope) });
  await fiber.await();
  await mini.settle();
  return {
    ...mini,
    reports,
    stored,
    listeners,
    hostByClass: (className) => mini.hosts.find((h) => h.props.className === className),
    // The root gains `dsu-dragging` mid-gesture, so it is found by its first class.
    widgetRoot: () => mini.hosts.find((h) => String(h.props.className ?? "").split(" ")[0] === "dsu-widget"),
    hostByKey: (key) => mini.hosts.find((h) => h.props.key === key),
    dispose: async () => { await fiber.dispose(); await session.dispose(); },
  };
}

const codePlanWithoutLivePayload = {
  currency: "USD", usdCnyRate: 7.2, refreshSeconds: 60, callCount: 3,
  totals: { cost: 1.5, calls: 3, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, searches: 0 },
  personalBudget: null, accountFilter: { options: [] },
  byProvider: [], byModel: [], byDay: [], byHour: [], bySession: [], bySessionModel: [], pricing: [], defaultPricing: {},
  autoDiscovered: [], billingParts: [],
  // A code plan for a provider with no usage adapter: the server leaves the
  // row without providerUsage, which is exactly what the dashboard received
  // in the deployment where clicking the pill emptied the widget.
  plans: [{
    provider: "kimi-coding", displayName: "Kimi", type: "code", periodDays: 7, autoDiscovered: false,
    usedRequests: 2, quotaRequests: null, usedTokens: 100, quotaTokens: null, usedCost: 0.4,
    remainingRequests: null, remainingTokens: null, usedPct: null, limits: [],
    subscription: null, tiers: null, dollarsPerMonth: null, quotaNote: null, quota: null,
  }],
};

test("expanding the dashboard renders a code plan that has no live provider payload", async () => {
  const widget = await mountWidget(codePlanWithoutLivePayload);
  try {
    const pill = widget.hostByClass("dsu-pill");
    assert.ok(pill, "the collapsed pill rendered");
    pill.props.onClick();
    await widget.settle();
    assert.deepEqual(widget.caught, [], "the boundary caught nothing");
    assert.deepEqual(widget.reports, []);
    assert.ok(widget.hostByKey("plan-code-kimi-coding"), "the plan card rendered inside the expanded panel");
  } finally {
    await widget.dispose();
  }
});

test("a render failure is kept inside the widget and reported to the server", async () => {
  // A live payload whose windows cannot be read throws inside the plan card:
  // the boundary must render in place and the failure must reach the server.
  const providerUsage = { get windows() { throw new TypeError("windows unreadable"); } };
  const broken = { ...codePlanWithoutLivePayload, plans: [{ ...codePlanWithoutLivePayload.plans[0], providerUsage }] };
  const widget = await mountWidget(broken);
  try {
    widget.hostByClass("dsu-pill").props.onClick();
    await widget.settle();
    assert.equal(widget.caught.length, 1);
    assert.equal(widget.reports.length, 1);
    assert.equal(widget.reports[0].message, "windows unreadable");
    assert.match(widget.reports[0].componentStack, /PlansSection/);
    assert.ok(widget.hostByClass("dsu-popTitle"), "the boundary's own panel replaced the widget");
  } finally {
    await widget.dispose();
  }
});

/** A pointer event as the pill's handlers read one, with a capture-capable target. */
function pointer(x, y, pointerId = 1) {
  const captured = [];
  return {
    button: 0,
    pointerId,
    clientX: x,
    clientY: y,
    captured,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    currentTarget: {
      setPointerCapture: (id) => captured.push(["set", id]),
      releasePointerCapture: (id) => captured.push(["release", id]),
    },
  };
}

test("the widget can be dragged off its corner and stays where it is put", async () => {
  const widget = await mountWidget(codePlanWithoutLivePayload);
  try {
    const pill = widget.hostByClass("dsu-pill");
    assert.deepEqual({ ...widget.widgetRoot().props.style }, { right: "20px", bottom: "20px" });

    // Drag up and to the left: pointer travel toward the top-left GROWS the
    // right/bottom offsets the widget is anchored by.
    pill.props.onPointerDown(pointer(1000, 800));
    pill.props.onPointerMove(pointer(960, 770));
    await widget.settle();
    const root = widget.widgetRoot();
    assert.deepEqual({ ...root.props.style }, { right: "60px", bottom: "50px" });
    assert.ok(root.props.className.includes("dsu-dragging"), "the drag is visible while it lasts");

    const release = pointer(960, 770);
    pill.props.onPointerUp(release);
    await widget.settle();
    assert.deepEqual(release.captured, [["release", 1]]);
    // The corner survives a reload.
    assert.equal(widget.stored.get("dsh-spend:position"), JSON.stringify({ right: 60, bottom: 50 }));
  } finally {
    await widget.dispose();
  }
});

test("a remembered corner is restored, and one off screen is pulled back", async () => {
  const placed = await mountWidget(codePlanWithoutLivePayload, {
    storage: { "dsh-spend:position": JSON.stringify({ right: 300, bottom: 120 }) },
  });
  try {
    assert.deepEqual({ ...placed.widgetRoot().props.style }, { right: "300px", bottom: "120px" });
  } finally {
    await placed.dispose();
  }

  // A corner further out than the window is wide would leave the widget
  // unreachable; the window is 1440x900 in this harness.
  const escaped = await mountWidget(codePlanWithoutLivePayload, {
    storage: { "dsh-spend:position": JSON.stringify({ right: 9000, bottom: -50 }) },
  });
  try {
    assert.deepEqual({ ...escaped.widgetRoot().props.style }, { right: "1432px", bottom: "8px" });
  } finally {
    await escaped.dispose();
  }

  // A value written by something else never breaks the mount.
  const junk = await mountWidget(codePlanWithoutLivePayload, { storage: { "dsh-spend:position": "not json" } });
  try {
    assert.deepEqual({ ...junk.widgetRoot().props.style }, { right: "20px", bottom: "20px" });
  } finally {
    await junk.dispose();
  }
});

test("a press that does not travel still opens the dashboard", async () => {
  const widget = await mountWidget(codePlanWithoutLivePayload);
  try {
    const pill = widget.hostByClass("dsu-pill");
    pill.props.onPointerDown(pointer(1000, 800));
    // Two pixels of hand tremor is not a drag.
    pill.props.onPointerMove(pointer(1001, 801));
    pill.props.onPointerUp(pointer(1001, 801));
    await widget.settle();
    assert.deepEqual({ ...widget.widgetRoot().props.style }, { right: "20px", bottom: "20px" });
    assert.equal(widget.stored.has("dsh-spend:position"), false, "an unmoved widget stores nothing");

    const click = pointer(1001, 801);
    pill.props.onClickCapture(click);
    assert.equal(click.defaultPrevented, false, "the click is not swallowed");
    pill.props.onClick();
    await widget.settle();
    assert.ok(widget.hostByKey("plan-code-kimi-coding"), "the dashboard opened");
  } finally {
    await widget.dispose();
  }
});

test("a drag does not also open the dashboard", async () => {
  const widget = await mountWidget(codePlanWithoutLivePayload);
  try {
    const pill = widget.hostByClass("dsu-pill");
    pill.props.onPointerDown(pointer(1000, 800));
    pill.props.onPointerMove(pointer(900, 700));
    await widget.settle();
    const click = widget.hostByClass("dsu-pill").props.onClickCapture;
    const event = pointer(900, 700);
    click(event);
    assert.equal(event.defaultPrevented, true, "the drag's click is swallowed");
  } finally {
    await widget.dispose();
  }
});
