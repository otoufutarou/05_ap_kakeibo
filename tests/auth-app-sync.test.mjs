import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { validateExpenses } from "../cloud-data.js";
import { pendingStorageKey, readPending as inspectPending, preserveOriginal, storageFailure } from "../pending-data.js";
import { collectBackup } from "../storage-backup.js";

class Element {
  hidden = false;
  textContent = "";
  dataset = {};
  listeners = new Map();
  attributes = new Map();
  children = [];

  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function createApp({ pendingValue, sync, storageBlocked = false, readBlocked = false,
  onLine = true, accountExpenses = [], confirmResult = false, storedEntries = [], load, fakeTimers = false } = {}) {
  const elements = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const storage = new Map([["p-kakeibo-v1", "[]"], ...storedEntries]);
  const user = { id: "user-1", email: "user@example.test", app_metadata: { providers: ["email"] } };
  if (pendingValue !== undefined) storage.set("p-kakeibo-cloud-pending:user-1", pendingValue);
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const expensesShown = [];
  const syncCalls = [];
  const timers = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user } }, error: null }),
      onAuthStateChange(callback) {
        this.callback = callback;
      },
    },
  };
  const source = (await readFile(new URL("../auth-app.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "");
  const context = {
    document: {
      querySelector: getElement,
      createElement: () => new Element(),
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
      visibilityState: "visible",
    },
    window: {
      pKakeiboApp: {
        setExpenses(items) {
          expensesShown.push(items);
        },
        applyTheme() {},
        showSettings() {},
      },
      addEventListener(type, listener) {
        windowListeners.set(type, listener);
      },
    },
    location: { hash: "" },
    navigator: { onLine },
    localStorage: {
      getItem(key) {
        if (readBlocked) throw new DOMException("denied", "SecurityError");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageBlocked) throw new DOMException("quota_exceeded", "QuotaExceededError");
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    getSupabaseClient: async () => client,
    isSupabaseConfigured: () => true,
    loadAccountData: load || (async () => ({ expenses: accountExpenses, settings: { theme: "purple" } })),
    saveAccountSettings: async () => {},
    syncAccountExpenses: async (_client, expenses, expected) => {
      syncCalls.push({ expenses, expected });
      return sync ? sync(expenses, expected) : expenses;
    },
    validateExpenses, pendingStorageKey, inspectPending, preserveOriginal, storageFailure,
    supabaseConfig: { url: "https://example.test", publishableKey: "public" },
    setTimeout: fakeTimers ? (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; } : setTimeout,
    clearTimeout: fakeTimers ? (timer) => { timer.cancelled = true; } : clearTimeout,
    confirm: () => confirmResult,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return {
    client,
    context,
    documentListeners,
    elements,
    expensesShown,
    storage,
    syncCalls,
    windowListeners,
    timers,
  };
}

test("restored pending expenses are synchronized automatically", async () => {
  const pending = JSON.stringify({ generation: 3, expenses: [], expected: [] });
  const app = await createApp({ pendingValue: pending });

  assert.equal(app.syncCalls.length, 1);
  assert.equal(app.storage.has("p-kakeibo-cloud-pending:user-1"), false);
  assert.match(app.elements.get("#cloud-status").textContent, /同期済み/);
});

test("offline failures retry after the browser reports connectivity", async () => {
  let attempts = 0;
  const pending = JSON.stringify({ generation: 1, expenses: [], expected: [] });
  const app = await createApp({
    pendingValue: pending,
    onLine: false,
    sync: async (expenses) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return expenses;
    },
  });

  assert.equal(attempts, 1);
  assert.match(app.elements.get("#cloud-status").textContent, /Failed to fetch/);
  app.context.navigator.onLine = true;
  app.windowListeners.get("online")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.equal(app.storage.has("p-kakeibo-cloud-pending:user-1"), false);
});

test("corrupt pending data is preserved and blocks cloud writes", async () => {
  const corrupt = "{invalid-json";
  const app = await createApp({ pendingValue: corrupt });

  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get("p-kakeibo-cloud-pending:user-1"), corrupt);
  assert.equal(app.elements.get("#app").hidden, true);
  assert.match(app.elements.get("#app-load-error-message").textContent, /元データは削除せず残しています/);
});

test("storage quota errors are reported and do not silently skip an immediate cloud save", async () => {
  let attempts = 0;
  const app = await createApp({
    storageBlocked: true,
    onLine: false,
    sync: async (expenses) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return expenses;
    },
  });
  app.windowListeners.get("p-kakeibo-data-changed")({
    detail: { expenses: [{ id: "expense-1", name: "test", amount: 100, date: "2026-11-03" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.syncCalls.length, 1);
  assert.match(app.elements.get("#cloud-status").textContent, /画面を閉じると失われる可能性/);
  app.elements.get("#retry-cloud-sync").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.match(app.elements.get("#cloud-status").textContent, /クラウド保存済み/);
});

test("an old account response cannot replace the newly active guest data", async () => {
  let resolveSync;
  const pending = JSON.stringify({ generation: 1, expenses: [], expected: [] });
  const app = await createApp({
    pendingValue: pending,
    sync: (expenses) => new Promise((resolve) => {
      resolveSync = () => resolve(expenses);
    }),
  });

  app.client.auth.callback("SIGNED_OUT", null);
  resolveSync();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.expensesShown.length, 2);
  assert.equal(app.context.window.pKakeiboAuth.status, "guest");
  assert.equal(app.elements.get("#cloud-status").textContent.startsWith("ゲストモード"), true);
});

const expense = { id: "expense-1", name: "なにか", amount: 100, date: "2026-11-03" };
const pendingKey = "p-kakeibo-cloud-pending:user-1";
const originalKey = "p-kakeibo-pending-original:user-1";
const snapshot = (expenses = [expense], extra = {}) => JSON.stringify({ generation: 1, expenses, expected: [], ...extra });

test("no pending data opens the normal home without cloud writes", async () => {
  const app = await createApp();
  assert.equal(app.elements.get("#app").hidden, false);
  assert.equal(app.elements.get("#app-load-error").hidden, true);
  assert.equal(app.syncCalls.length, 0);
});

test("a temporary cloud-load failure still opens a valid account-scoped pending snapshot", async () => {
  const raw = snapshot();
  const app = await createApp({
    fakeTimers: true,
    pendingValue: raw,
    load: async () => { throw new TypeError("Failed to fetch"); },
    sync: async () => { throw new TypeError("Failed to fetch"); },
  });

  assert.equal(app.elements.get("#app").hidden, false);
  assert.equal(app.elements.get("#app-load-error").hidden, true);
  assert.equal(app.expensesShown.at(-1)[0].id, expense.id);
  assert.match(app.elements.get("#cloud-status").textContent, /クラウド保存に失敗しました/);
  assert.deepEqual(JSON.parse(app.storage.get(pendingKey)).expenses, [expense]);
  assert.equal(app.syncCalls.length, 1);
});

test("historical writer formats restore all records and preserve their exact original", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/pending-history.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const raw = JSON.stringify(fixture.pending);
    const app = await createApp({ pendingValue: raw });
    assert.equal(app.elements.get("#app").hidden, false, fixture.revision);
    assert.deepEqual(app.syncCalls[0].expenses, fixture.pending.expenses);
    assert.deepEqual(app.syncCalls[0].expected, fixture.pending.expected);
    assert.equal(app.storage.get(originalKey), raw);
    assert.equal(app.expensesShown.at(-1).length, fixture.pending.expenses.length);
    const reloaded = await createApp({ storedEntries: [...app.storage], accountExpenses: app.expensesShown.at(-1) });
    assert.equal(reloaded.syncCalls.length, 0);
    assert.equal(reloaded.elements.get("#app").hidden, false);
    assert.equal(reloaded.expensesShown.at(-1).length, fixture.pending.expenses.length);
  }
});

test("legacy missing concurrency information requires approval and is never rebased to current cloud timestamps", async () => {
  const raw = JSON.stringify({ expenses: [expense], expected: null, legacyEnvelope: { keep: true } });
  const app = await createApp({ pendingValue: raw, accountExpenses: [{ ...expense, updatedAt: "2026-11-04T00:00:00Z" }], confirmResult: true });
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get(pendingKey), raw);
  assert.equal(app.elements.get("#recover-legacy-pending").hidden, false);
  await app.elements.get("#recover-legacy-pending").listeners.get("click")();
  await settle();
  assert.deepEqual(Array.from(app.syncCalls[0].expected), []);
  assert.deepEqual(app.syncCalls[0].expenses, [expense]);
  assert.equal(app.storage.get(originalKey), raw);
  assert.equal(app.elements.get("#app").hidden, false);
});

test("unapproved legacy recovery performs no changes", async () => {
  const raw = JSON.stringify({ expenses: [expense] });
  const app = await createApp({ pendingValue: raw });
  await app.elements.get("#recover-legacy-pending").listeners.get("click")();
  assert.equal(app.storage.get(pendingKey), raw);
  assert.equal(app.storage.has(originalKey), false);
  assert.equal(app.syncCalls.length, 0);
});

test("partial invalid records report counts and are never filtered or automatically sent", async () => {
  const raw = snapshot([expense, { ...expense, id: "bad", amount: "100" }]);
  const app = await createApp({ pendingValue: raw });
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get(pendingKey), raw);
  assert.match(app.elements.get("#recovery-detail").textContent, /全2件、検証通過1件、要確認1件/);
  assert.match(app.elements.get("#recovery-detail").textContent, /2件目: amount/);
  for (let index = 0; index < 3; index += 1) {
    await app.elements.get("#retry-app-load").listeners.get("click")();
    await settle();
    assert.equal(app.storage.get(pendingKey), raw);
    assert.equal(app.syncCalls.length, 0);
  }
});

test("storage access failures are distinguished from malformed JSON even without cloud connectivity", async () => {
  const app = await createApp({ readBlocked: true, load: async () => { throw new Error("offline"); } });
  assert.match(app.elements.get("#recovery-detail").textContent, /保存領域にアクセスできません/);
  assert.equal(app.syncCalls.length, 0);
});

test("failure to preserve original stops restoration before any overwrite or network write", async () => {
  const raw = snapshot();
  const app = await createApp({ pendingValue: raw, storageBlocked: true });
  assert.equal(app.storage.get(pendingKey), raw);
  assert.equal(app.syncCalls.length, 0);
  assert.match(app.elements.get("#recovery-detail").textContent, /保存容量が不足/);
});

test("valid unknown pending-envelope and expense fields survive failed synchronization", async () => {
  const item = { ...expense, category: 9, extra: { values: [1, 2] } };
  const raw = snapshot([item], { extension: { keep: true } });
  const app = await createApp({ pendingValue: raw, onLine: false, sync: async () => { throw new TypeError("offline"); } });
  const restored = JSON.parse(app.storage.get(pendingKey));
  assert.deepEqual(restored.expenses, [item]);
  assert.deepEqual(restored.extension, { keep: true });
  assert.equal(app.storage.get(originalKey), raw);
});

test("a synchronization in progress retains its queue until verified success", async () => {
  let finish;
  const app = await createApp({ pendingValue: snapshot(), sync: (expenses) => new Promise((resolve) => { finish = () => resolve(expenses); }) });
  assert.equal(app.storage.has(pendingKey), true);
  finish();
  await settle();
  assert.equal(app.storage.has(pendingKey), false);
});

test("an incomplete success response never removes the pending queue", async () => {
  const app = await createApp({ pendingValue: snapshot(), sync: async () => [], fakeTimers: true });
  assert.equal(app.storage.has(pendingKey), true);
  assert.match(app.elements.get("#cloud-status").textContent, /保存結果の件数・内容を確認できません/);
  assert.equal(app.timers.length, 0);
});

test("automatic retries use bounded backoff and eventually save without duplicating IDs", async () => {
  const rows = new Map();
  let attempts = 0;
  const app = await createApp({
    pendingValue: snapshot(), fakeTimers: true,
    sync: async (items) => {
      for (const item of items) rows.set(item.id, item);
      if (++attempts < 12) throw new TypeError("response lost");
      return [...rows.values()];
    },
  });
  for (let index = 0; index < 11; index += 1) {
    const timer = app.timers[index];
    assert.ok(timer.delay <= 300000);
    timer.callback();
    await settle();
  }
  assert.equal(attempts, 12);
  assert.equal(rows.size, 1);
  assert.equal(app.storage.has(pendingKey), false);
  assert.equal(app.timers.at(-1).delay, 300000);
});

test("conflicts and permission failures stop automatic retries and preserve old concurrency tokens", async () => {
  for (const code of ["40001", "42501", "22023"]) {
    const expected = [{ id: expense.id, updatedAt: "2026-11-01T00:00:00.123456Z" }];
    const app = await createApp({ pendingValue: snapshot([expense], { expected }), fakeTimers: true,
      sync: async () => { throw { code, message: "blocked" }; } });
    assert.equal(app.timers.length, 0);
    app.windowListeners.get("online")();
    app.documentListeners.get("visibilitychange")();
    await settle();
    assert.equal(app.syncCalls.length, 1);
    assert.deepEqual(JSON.parse(app.storage.get(pendingKey)).expected, expected);
    assert.equal(app.elements.get("#discard-pending-changes").hidden, code !== "40001");
  }
});

test("RPC errors show HTTP status, database code, message, details, and hint", async () => {
  const app = await createApp({
    pendingValue: snapshot(),
    fakeTimers: true,
    sync: async () => {
      throw {
        status: 403,
        code: "42501",
        message: "permission denied",
        details: "RPC execute privilege is missing",
        hint: "grant execute",
      };
    },
  });
  const status = app.elements.get("#cloud-status").textContent;
  assert.match(status, /HTTP 403/);
  assert.match(status, /code 42501/);
  assert.match(status, /permission denied/);
  assert.match(status, /RPC execute privilege is missing/);
  assert.match(status, /grant execute/);
});

test("another user's pending queue is neither displayed nor synchronized", async () => {
  const otherRaw = snapshot([{ ...expense, id: "other-expense" }]);
  const app = await createApp({ storedEntries: [["p-kakeibo-cloud-pending:user-2", otherRaw]] });
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.expensesShown.at(-1).length, 0);
  assert.equal(app.storage.get("p-kakeibo-cloud-pending:user-2"), otherRaw);
});

test("an explicit account mismatch blocks all writes", async () => {
  const raw = snapshot([expense], { userId: "user-2" });
  const app = await createApp({ pendingValue: raw });
  assert.match(app.elements.get("#recovery-detail").textContent, /アカウントが一致しません/);
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get(pendingKey), raw);
});

test("cloud preview is read-only and does not replace pending or guest data", async () => {
  const raw = "{broken";
  const app = await createApp({ pendingValue: raw, accountExpenses: [expense] });
  const before = [...app.storage];
  await app.elements.get("#view-cloud-records").listeners.get("click")();
  assert.equal(app.elements.get("#recovery-cloud-records").children.length, 1);
  assert.equal(app.expensesShown.length, 0);
  assert.deepEqual([...app.storage], before);
  assert.equal(app.syncCalls.length, 0);
});

test("cloud preview refuses a session for a different account", async () => {
  const app = await createApp({ pendingValue: "{broken", accountExpenses: [expense] });
  app.client.auth.getSession = async () => ({ data: { session: { user: { id: "user-2" } } } });
  await app.elements.get("#view-cloud-records").listeners.get("click")();
  assert.equal(app.elements.get("#recovery-cloud-records").hidden, true);
  assert.match(app.elements.get("#recovery-cloud-status").textContent, /アカウントが一致しません/);
});

test("invalid pending data can open verified cloud records in read-only mode", async () => {
  const raw = "{broken";
  const app = await createApp({ pendingValue: raw, accountExpenses: [expense] });
  await app.elements.get("#open-cloud-read-only").listeners.get("click")();

  assert.equal(app.elements.get("#app").hidden, false);
  assert.equal(app.elements.get("#app-load-error").hidden, true);
  assert.equal(app.elements.get("#app").dataset.readonly, "true");
  assert.equal(app.context.window.pKakeiboAuth.readOnly, true);
  assert.equal(app.expensesShown.at(-1)[0].id, expense.id);
  assert.equal(app.storage.get(pendingKey), raw);
  assert.equal(app.syncCalls.length, 0);

  let prevented = false;
  app.documentListeners.get("submit")({
    type: "submit",
    preventDefault() { prevented = true; },
    stopImmediatePropagation() {},
  });
  assert.equal(prevented, true);
  app.windowListeners.get("p-kakeibo-data-changed")({ detail: { expenses: [] } });
  await settle();
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get(pendingKey), raw);
});

test("late cloud preview responses cannot display an old account's records", async () => {
  let finish;
  const app = await createApp({ pendingValue: "{broken", load: () => new Promise((resolve) => { finish = resolve; }) });
  const preview = app.elements.get("#view-cloud-records").listeners.get("click")();
  await settle();
  app.client.auth.callback("SIGNED_OUT", null);
  finish({ expenses: [expense], settings: { theme: "purple" } });
  await preview;
  assert.equal(app.elements.get("#recovery-cloud-records").children.length, 0);
  assert.equal(app.elements.get("#recovery-cloud-records").hidden, true);
});

test("a successful backup contains all raw values across accounts and performs no writes", async () => {
  const app = await createApp({
    pendingValue: "{invalid-json",
    storedEntries: [
      ["p-kakeibo-theme", "blue"],
      ["p-kakeibo-theme-pending:user-1", "green"],
      ["p-kakeibo-cloud-pending:user-2", snapshot()],
      ["p-kakeibo-theme-pending:user-2", "yellow"],
      ["p-kakeibo-pending-original:user-2", "{older"],
      ["sb-example-auth-token", "must-not-export"],
      ["password", "must-not-export"],
    ],
  });
  const before = [...app.storage];
  const backup = collectBackup({ get length() { return app.storage.size; }, key: (index) => [...app.storage.keys()][index], getItem: (key) => app.storage.get(key) ?? null });
  assert.deepEqual([...app.storage], before);
  assert.equal(backup.entries.length, 7);
  assert.equal(backup.entries.find((item) => item.key === pendingKey).raw, "{invalid-json");
  assert.equal(JSON.stringify(backup).includes("must-not-export"), false);
});

test("editing a restored conflict cannot replace its original tokens with the newer loaded baseline", async () => {
  const expected = [{ id: expense.id, updatedAt: "2026-11-01T00:00:00Z" }];
  const app = await createApp({
    pendingValue: snapshot([expense], { expected, extension: { keep: true } }),
    accountExpenses: [{ ...expense, amount: 300, updatedAt: "2026-11-04T00:00:00Z" }],
    sync: async () => { throw { code: "40001", message: "sync_conflict" }; },
  });
  app.windowListeners.get("p-kakeibo-data-changed")({ detail: { expenses: [{ ...expense, amount: 200 }] } });
  await settle();
  const restored = JSON.parse(app.storage.get(pendingKey));
  assert.deepEqual(restored.expected, expected);
  assert.deepEqual(restored.extension, { keep: true });
  assert.equal(app.syncCalls.length, 1);
});

test("confirmed conflict discard resumes normal automatic synchronization for subsequent entries", async () => {
  let attempts = 0;
  const app = await createApp({
    pendingValue: snapshot(), confirmResult: true,
    sync: async (items) => {
      if (++attempts === 1) throw { code: "40001", message: "sync_conflict" };
      return items;
    },
  });
  await app.elements.get("#discard-pending-changes").listeners.get("click")();
  app.windowListeners.get("p-kakeibo-data-changed")({ detail: { expenses: [expense] } });
  await settle();
  assert.equal(attempts, 2);
  assert.equal(app.storage.has(pendingKey), false);
});

test("rapid edits coalesce to the latest full snapshot while an earlier save is in flight", async () => {
  let finish;
  let attempts = 0;
  const app = await createApp({
    sync: async (items) => {
      attempts += 1;
      if (attempts === 1) await new Promise((resolve) => { finish = resolve; });
      return items.map((item) => ({ ...item, updatedAt: "2026-11-04T00:00:00Z" }));
    },
  });
  const change = (amount) => app.windowListeners.get("p-kakeibo-data-changed")({ detail: { expenses: [{ ...expense, amount }] } });
  change(100);
  await settle();
  change(200);
  change(300);
  finish();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(app.syncCalls[1].expenses[0].amount, 300);
  assert.equal(app.syncCalls[1].expected[0].updatedAt, "2026-11-04T00:00:00Z");
  assert.equal(app.expensesShown.at(-1)[0].amount, 300);
  assert.equal(app.storage.has(pendingKey), false);
});

test("invalid pending theme is preserved and blocks partial expense synchronization", async () => {
  const raw = snapshot();
  const app = await createApp({ pendingValue: raw, storedEntries: [["p-kakeibo-theme-pending:user-1", "unknown"]] });
  assert.equal(app.syncCalls.length, 0);
  assert.equal(app.storage.get(pendingKey), raw);
  assert.equal(app.storage.get("p-kakeibo-theme-pending:user-1"), "unknown");
  assert.match(app.elements.get("#recovery-detail").textContent, /4色/);
});
