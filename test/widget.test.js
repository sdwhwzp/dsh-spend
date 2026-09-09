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

async function mountWidget(snapshot) {
  const mini = makeMiniReact();
  let registration;
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
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
    localStorage: { getItem: () => null, setItem: () => {} },
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
    hostByClass: (className) => mini.hosts.find((h) => h.props.className === className),
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
