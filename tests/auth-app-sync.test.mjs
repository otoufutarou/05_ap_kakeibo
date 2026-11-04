import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

class Element {
  hidden = false;
  textContent = "";
  dataset = {};
  listeners = new Map();
  attributes = new Map();

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

async function createApp({ pendingValue, sync, storageBlocked = false, onLine = true } = {}) {
  const elements = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const storage = new Map([["p-kakeibo-v1", "[]"]]);
  const user = { id: "user-1", email: "user@example.test", app_metadata: { providers: ["email"] } };
  if (pendingValue !== undefined) storage.set("p-kakeibo-cloud-pending:user-1", pendingValue);
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const expensesShown = [];
  const syncCalls = [];
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
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageBlocked) throw new Error("quota_exceeded");
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    getSupabaseClient: async () => client,
    isSupabaseConfigured: () => true,
    loadAccountData: async () => ({ expenses: [], settings: { theme: "purple" } }),
    saveAccountSettings: async () => {},
    syncAccountExpenses: async (_client, expenses, expected) => {
      syncCalls.push({ expenses, expected });
      return sync ? sync(expenses, expected) : expenses;
    },
    validateExpenses(value) {
      if (!Array.isArray(value)) throw new Error("invalid_expenses");
      return value;
    },
    supabaseConfig: { url: "https://example.test", publishableKey: "public" },
    setTimeout,
    clearTimeout,
    confirm: () => false,
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
