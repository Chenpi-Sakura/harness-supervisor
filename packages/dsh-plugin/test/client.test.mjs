import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

for (const [carrier, location] of [["Web", { origin: "http://127.0.0.1:3080" }], ["Desktop", { origin: "null", protocol: "dsh-app:", host: "app" }]]) test(`DSH ${carrier} client opens the human global Browser with an optional preferred session and no model turn`, async () => {
  const registered = [], opened = [], called = [], cleanups = [];
  const ctx = {
    connection: { rpc: { call: async (...args) => { called.push(args); return { ok: true, value: { url: "http://127.0.0.1:9999/#token=secret" } }; } } },
    sidebarRight: { openTab: (...args) => opened.push(args) },
    commandUi: { register: (value) => { registered.push(value); return () => {}; } },
    slots: { inject: (_, fn) => fn(), register: () => () => {} },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  };
  const exports = {};
  const sandbox = { exports, require: (name) => { assert.equal(name, "react"); return { createElement() {} }; },
    window: { location, alert() {} }, crypto: webcrypto, AbortController, URL };
  vm.runInNewContext(await readFile(new URL("../src/client.cjs", import.meta.url), "utf8"), sandbox);
  exports.apply(ctx);
  registered[0].ui.run({ sessionId: "session-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called[0][0], "/api");
  assert.equal(called[0][1], "harness-supervisor/open-ui");
  assert.equal(called[0][2].sessionId, "session-a");
  assert.equal(called[0][2].applicationOrigin, carrier === "Desktop" ? "dsh-app://app" : location.origin);
  assert.equal(Object.hasOwn(called[0][2], "viewKey"), false);
  assert.equal(Object.hasOwn(called[0][2], "viewGeneration"), false, "independent Browser entries do not replace a panel lease");
  assert.equal(opened[0][0], "browser");
  assert.equal(opened[0][1].params.url, "http://127.0.0.1:9999/#token=secret");
  assert.equal(called.length, 1);
  assert.equal(registered[0].available({}), false, "the official Browser carrier still requires a DSH session");
  cleanups.forEach((cleanup) => cleanup());
});

// Exercise the public slot and async component lifecycle without a browser or
// any model calls. State updates after unmount are treated as test failures.
function mountComponent(Component, props, React) {
  const cells = [], effects = [];
  let cursor, tree, dirty = true, unmounted = false;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = initial;
    return [cells[index], (next) => {
      assert.equal(unmounted, false, "late reply must not update an unmounted session");
      cells[index] = typeof next === "function" ? next(cells[index]) : next;
      dirty = true;
    }];
  };
  const useEffect = (fn, deps) => {
    const index = cursor++, previous = cells[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      effects.push(() => { previous?.cleanup?.(); cells[index] = { deps, cleanup: fn() }; });
    }
  };
  const useRef = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = { current: initial };
    return cells[index];
  };
  const render = () => {
    Object.assign(React, { useState, useEffect, useRef });
    while (dirty) {
      dirty = false; cursor = 0; tree = Component(props);
      effects.splice(0).forEach((run) => run());
    }
    return tree;
  };
  render();
  return { render, rerender() { dirty = true; return render(); }, unmount() { cells.forEach((cell) => cell?.cleanup?.()); unmounted = true; } };
}

function descendants(tree) {
  return tree && typeof tree === "object" ? [tree, ...(tree.children || []).flatMap(descendants)] : [];
}

test("conversation tab captures the preferred session and aborts stale replies when reopening the global UI", async () => {
  const slots = [], calls = [], cleanups = [];
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const ctx = {
    connection: { rpc: { call: (...args) => new Promise((resolve) => calls.push({ args, resolve })) } },
    commandUi: { register: () => () => {} }, sidebarRight: { openTab() { assert.fail("tab must not open the sidebar"); } },
    slots: { inject: (_, fn) => fn(), register: (entry, Component) => { slots.push({ entry, Component }); return () => {}; } },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  };
  const exports = {};
  vm.runInNewContext(await readFile(new URL("../src/client.cjs", import.meta.url), "utf8"), {
    exports, require: () => React, window: { location: { origin: "null", protocol: "dsh-app:", host: "app" } }, crypto: webcrypto, URL, AbortController,
  });
  exports.apply(ctx);
  const { entry, Component } = slots.find(({ entry }) => entry.name === "conversation.view");
  assert.equal(entry.id, "harness-supervisor");
  assert.equal(entry.label(), "Harness Supervisor");
  const first = Component({ sessionId: "session-a" });
  const second = Component({ sessionId: "session-b" });
  assert.notEqual(first.props.key, second.props.key, "a session change must remove the old frame before rendering");
  const a = mountComponent(first.type, first.props, React);
  assert.equal(calls[0].args[2].sessionId, "session-a");
  assert.equal(calls[0].args[2].applicationOrigin, "dsh-app://app");
  assert.equal(calls[0].args[2].viewGeneration, 1);
  a.unmount();
  assert.equal(calls[0].args[3].aborted, true);
  const b = mountComponent(second.type, second.props, React);
  assert.equal(calls[1].args[2].viewKey, calls[0].args[2].viewKey);
  assert.equal(calls[1].args[2].viewGeneration, 2, "changing the preferred session advances the same panel generation");
  calls[0].resolve({ ok: true, value: { url: "http://127.0.0.1:9999/view/a/#launch=old" } });
  calls[1].resolve({ ok: true, value: { url: "http://127.0.0.1:9999/view/b/#launch=new" } });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = descendants(b.render()).find(({ type }) => type === "iframe");
  assert.equal(frame.props.src, "http://127.0.0.1:9999/view/b/#launch=new");
  assert.equal(frame.props.title, "Harness Supervisor · 全局 Worker");
  assert.equal(frame.props.sandbox, "allow-scripts allow-same-origin");
  assert.equal(frame.props.referrerPolicy, "no-referrer");
  assert.equal(descendants(b.render()).some(({ type }) => type === "button"), false, "a connected panel has no separate reconnect toolbar");
  b.unmount();
  const reopened = mountComponent(second.type, second.props, React);
  assert.equal(descendants(reopened.render()).some(({ type }) => type === "iframe"), false, "reopening starts with a fresh entry instead of a consumed link");
  assert.equal(calls[2].args[2].sessionId, "session-b");
  assert.equal(calls[2].args[2].viewKey, calls[0].args[2].viewKey, "the same host panel replaces its own prior session credential");
  assert.equal(calls[2].args[2].viewGeneration, 3, "reopening advances the generation after an aborted or completed entry");
  reopened.unmount();
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(calls[2].args[3].aborted, true);
});

test("left navigation and embedded settings open the human global UI with separate leases", async () => {
  const slots = [], calls = [], cleanups = [];
  let binding = {};
  const current = { subscribe: () => () => {}, getSnapshot: () => binding };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      assert.equal(subscribe, current.subscribe);
      assert.equal(getSnapshot, current.getSnapshot);
      return getSnapshot();
    },
  };
  const ctx = {
    connection: { rpc: { call: (...args) => new Promise((resolve) => calls.push({ args, resolve })) } },
    commandUi: { register: () => () => {} }, sidebarRight: { openTab() { assert.fail("main panel must not open the browser sidebar"); } },
    uiSession: { current },
    slots: { inject: (_, fn) => fn(), register: (entry, Component) => { slots.push({ entry, Component }); return () => {}; } },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  };
  const exports = {};
  vm.runInNewContext(await readFile(new URL("../src/client.cjs", import.meta.url), "utf8"), {
    exports, require: (name) => { assert.equal(name, "react"); return React; },
    window: { location: { origin: "null", protocol: "dsh-app:", host: "app" } }, crypto: webcrypto, URL, AbortController,
  });
  exports.apply(ctx);
  const navigation = slots.find(({ entry }) => entry.name === "sidebar.panellist");
  const main = slots.find(({ entry }) => entry.name === "main");
  const conversation = slots.find(({ entry }) => entry.name === "conversation.view");
  const settings = slots.find(({ entry }) => entry.name === "settings.section");
  assert.equal(navigation.entry.id, "harness-supervisor");
  assert.equal(main.entry.key, navigation.entry.id, "the native navigation id must address the main keyed entry");
  assert.equal(navigation.entry.label(), "Harness Supervisor");
  for (const size of [16, 18]) {
    const icon = navigation.Component({ size });
    assert.equal(icon.type, "svg");
    assert.equal(icon.props.width, size);
    assert.equal(icon.props.height, size);
    assert.equal(icon.props["aria-hidden"], true);
    assert.equal(descendants(icon).some(({ type }) => type === "button"), false, "DSH owns the entry button and selection");
  }
  const empty = main.Component({});
  const globalPanel = mountComponent(empty.type, empty.props, React);
  assert.equal(calls[0].args[1], "harness-supervisor/open-ui");
  assert.equal(Object.hasOwn(calls[0].args[2], "sessionId"), false, "without a conversation the human entry remains usable");
  assert.equal(calls[0].args[2].viewGeneration, 1);
  globalPanel.unmount();

  binding = { key: "session-from-current-binding" };
  const selected = main.Component({});
  assert.equal(selected.props.sessionId, binding.key);
  assert.equal(selected.props.key, binding.key);
  const panel = mountComponent(selected.type, selected.props, React);
  const panelTree = panel.render();
  assert.equal(panelTree.props["data-conversation-composer-overlay"], undefined);
  assert.equal(panelTree.props.style.paddingBottom, undefined, "a global main panel has no conversation composer to reserve");
  assert.equal(calls[1].args[2].sessionId, binding.key);
  assert.match(calls[1].args[2].viewKey, /:sidebar$/);
  assert.equal(calls[1].args[2].viewKey, calls[0].args[2].viewKey);
  assert.equal(calls[1].args[2].viewGeneration, 2, "the sidebar generation survives changes to its preferred session");
  calls[1].resolve({ ok: true, value: { url: "http://127.0.0.1:9999/view/main/#launch=main" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(descendants(panel.render()).find(({ type }) => type === "iframe").props.src, "http://127.0.0.1:9999/view/main/#launch=main");
  panel.unmount();

  const tab = conversation.Component({ sessionId: binding.key });
  const tabPanel = mountComponent(tab.type, tab.props, React);
  assert.match(calls[2].args[2].viewKey, /:conversation$/);
  assert.equal(calls[2].args[2].viewGeneration, 1, "another surface begins its own generation sequence");
  assert.notEqual(calls[2].args[2].viewKey, calls[1].args[2].viewKey, "left main and conversation panels must not revoke each other's credentials");
  assert.equal(tabPanel.render().props["data-conversation-composer-overlay"], "");
  assert.match(tabPanel.render().props.style.paddingBottom, /--dsh-composer-height/);
  tabPanel.unmount();
  assert.equal(calls[2].args[3].aborted, true);

  const settingsPanel = mountComponent(settings.Component, {}, React);
  const settingsTree = settingsPanel.render();
  assert.equal(settingsTree.props.style.maxWidth, undefined, "the embedded WebUI uses the settings area's full width");
  const embedded = descendants(settingsTree).find(({ props }) => props?.surface === "settings");
  assert.equal(embedded.props.sessionId, binding.key);
  const viewport = descendants(settingsTree).find(({ children }) => children?.includes(embedded));
  assert.equal(viewport.props.style.height, "70vh");
  assert.equal(viewport.props.style.minHeight, 520);
  const embeddedPanel = mountComponent(embedded.type, embedded.props, React);
  const settingsCall = calls.find(({ args }) => args[1] === "harness-supervisor/open-ui" && args[2].viewKey.endsWith(":settings"));
  assert.equal(settingsCall.args[2].sessionId, binding.key);
  assert.equal(settingsCall.args[2].viewGeneration, 1);
  assert.equal(new Set([calls[1].args[2].viewKey, calls[2].args[2].viewKey, settingsCall.args[2].viewKey]).size, 3, "each human surface replaces only its own lease");
  settingsCall.resolve({ ok: true, value: { url: "http://127.0.0.1:9999/view/settings/#launch=settings" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(descendants(embeddedPanel.render()).find(({ type }) => type === "iframe").props.title, "Harness Supervisor · 全局 Worker");
  embeddedPanel.unmount();
  binding = {};
  const unboundEmbedded = descendants(settingsPanel.rerender()).find(({ props }) => props?.surface === "settings");
  assert.notEqual(unboundEmbedded.props.key, embedded.props.key, "changing the preferred conversation rebuilds the settings frame");
  const unboundPanel = mountComponent(unboundEmbedded.type, unboundEmbedded.props, React);
  const unboundCall = calls.at(-1);
  assert.equal(unboundCall.args[1], "harness-supervisor/open-ui");
  assert.equal(Object.hasOwn(unboundCall.args[2], "sessionId"), false);
  assert.equal(unboundCall.args[2].viewKey, settingsCall.args[2].viewKey);
  assert.equal(unboundCall.args[2].viewGeneration, 2, "settings keeps its counter when the preferred session becomes absent");
  unboundPanel.unmount();
  settingsPanel.unmount();
  cleanups.forEach((cleanup) => cleanup());
});
