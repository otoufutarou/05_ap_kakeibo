import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { inspectExpenses, validateExpenses, syncAccountExpenses } from "../cloud-data.js";
import { readPending, preserveOriginal } from "../pending-data.js";
import { collectBackup, downloadBackup } from "../storage-backup.js";

const expense = { id: "legacy-id", name: "なにか", amount: 120, date: "2026-11-04", category: { old: true }, extra: [1, 2] };
const rawStorage = (raw) => ({ getItem: () => raw });
const envelope = (extra = {}) => ({ generation: 1, expenses: [expense], expected: [], ...extra });

test("absent, malformed JSON, structure, generation, version and expected failures are distinct", () => {
  assert.equal(readPending(rawStorage(null), "a").state, "none");
  const cases = [
    ["", "json"], ["{broken", "json"], ["null", "structure"], ["[]", "structure"],
    [JSON.stringify({ expenses: {} }), "structure"],
    [JSON.stringify(envelope({ generation: -1 })), "generation"],
    [JSON.stringify(envelope({ generation: 1.5 })), "generation"],
    [JSON.stringify(envelope({ generation: "1" })), "generation"],
    [JSON.stringify(envelope({ version: 2 })), "version"],
    [JSON.stringify(envelope({ expected: {} })), "expected"],
    [JSON.stringify(envelope({ expected: [{ id: "a" }] })), "expected"],
    [JSON.stringify(envelope({ expected: [{ id: "a", updatedAt: "invalid" }] })), "expected"],
    [JSON.stringify(envelope({ expenses: [{ ...expense, amount: 0 }] })), "expenses"],
  ];
  for (const [raw, reason] of cases) {
    const result = readPending(rawStorage(raw), "a");
    assert.equal(result.reason, reason);
    assert.equal(result.raw, raw);
  }
});

test("non-UUID IDs, default names, missing timestamps, legacy category and metadata remain compatible", () => {
  const input = [expense, { ...expense, id: "another-id", date: "2024-02-29", category: 3 }];
  assert.deepEqual(validateExpenses(input), input);
  assert.equal(inspectExpenses(input).valid, 2);
});

test("invalid amounts, calendar dates, names, IDs, timestamps and duplicate IDs are not filtered", () => {
  for (const change of [
    { amount: "120" }, { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 },
    { date: "2026-02-29" }, { date: "2026-11-31" }, { date: "2026-1-01" },
    { name: "" }, { name: " ".repeat(2) }, { name: "x".repeat(101) }, { id: "" }, { id: 12 },
    { createdAt: "invalid" },
  ]) {
    const input = [expense, { ...expense, id: "second", ...change }];
    const before = JSON.stringify(input);
    assert.throws(() => validateExpenses(input));
    assert.equal(JSON.stringify(input), before);
    assert.equal(inspectExpenses(input).total, 2);
  }
  assert.match(inspectExpenses([expense, expense]).issues[0].field, /duplicate_id/);
});

test("original snapshots remain verbatim and cannot be overwritten by later recoveries", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(preserveOriginal(storage, "a", " original 1 ").ok, true);
  assert.equal(preserveOriginal(storage, "a", " original 1 ").ok, true);
  assert.equal(preserveOriginal(storage, "a", "original 2").ok, true);
  assert.deepEqual([...values.values()], [" original 1 ", "original 2"]);
});

test("backup failure is explicit, produces no partial success, and never invokes storage writes", () => {
  let writes = 0;
  const storage = {
    length: 1, key: () => "p-kakeibo-cloud-pending:a",
    getItem: () => { throw new DOMException("denied", "SecurityError"); },
    setItem: () => { writes += 1; },
  };
  assert.throws(() => collectBackup(storage), /denied/);
  assert.throws(() => downloadBackup(storage), /denied/);
  assert.equal(writes, 0);
});

test("RPC receives preserved legacy metadata, stable IDs and exact microsecond concurrency tokens", async () => {
  let request;
  const timestamp = "2026-11-01T00:00:00.123456+00:00";
  const client = { rpc: async (name, args) => { request = { name, args }; return { data: [], error: null }; } };
  await syncAccountExpenses(client, [expense], [{ id: expense.id, updatedAt: timestamp }]);
  assert.equal(request.name, "p_kakeibo_sync_expenses");
  assert.equal(request.args.p_expected[0].updated_at, timestamp);
  assert.equal(request.args.p_expenses[0].source_expense_id, expense.id);
  assert.deepEqual(request.args.p_expenses[0].metadata, { category: expense.category, extra: expense.extra });
});

test("sync diagnostics distinguish local validation, transport, RPC response, and response parsing", async () => {
  const valid = [{ id: "expense", name: "test", amount: 10, date: "2026-11-04" }];
  const expected = [];
  const notCalled = { rpc: async () => assert.fail("invalid inputs must not call the RPC") };
  await assert.rejects(syncAccountExpenses(notCalled, [{ ...valid[0], amount: 0 }], expected),
    (error) => error.syncStage === "local_validation" && error.code === "invalid_expenses");

  await assert.rejects(syncAccountExpenses({
    rpc: async () => { throw new TypeError("Failed to fetch"); },
  }, valid, expected), (error) => error.syncStage === "rpc_transport" && error.message === "Failed to fetch");

  await assert.rejects(syncAccountExpenses({
    rpc: async () => ({
      data: null,
      status: 400,
      error: { code: "22023", message: "invalid_sync_request", details: "bad input", hint: "check shape" },
    }),
  }, valid, expected), (error) => error.syncStage === "rpc_response"
    && error.status === 400 && error.code === "22023"
    && error.details === "bad input" && error.hint === "check shape");

  await assert.rejects(syncAccountExpenses({
    rpc: async () => ({ data: null, error: null }),
  }, valid, expected), (error) => error.syncStage === "response_parse" && error.code === "sync_response_invalid");
});

test("invalid concurrency IDs and timestamps stop before RPC without modifying the input", async () => {
  const client = { rpc: async () => assert.fail("invalid concurrency data must never be sent") };
  const timestamp = "2026-11-08T00:00:00.123456+00:00";
  for (const expected of [
    [{ id: expense.id }], [{ id: expense.id, updatedAt: null }],
    [{ id: expense.id, updatedAt: "invalid" }], [{ id: "", updatedAt: timestamp }],
    [{ id: 1, updatedAt: timestamp }],
    [{ id: expense.id, updatedAt: timestamp }, { id: expense.id, updatedAt: timestamp }],
  ]) {
    const before = JSON.stringify(expected);
    await assert.rejects(syncAccountExpenses(client, [expense], expected),
      (error) => error.code === "invalid_expected" && error.syncStage === "local_validation");
    assert.equal(JSON.stringify(expected), before);
  }
});

test("successful RPC rows without concurrency tokens cannot become a new baseline", async () => {
  const client = { rpc: async () => ({
    data: [{ source_expense_id: expense.id, name: expense.name, amount: expense.amount, expense_date: expense.date }],
    error: null,
  }) };
  await assert.rejects(syncAccountExpenses(client, [expense], []),
    (error) => error.code === "sync_response_invalid" && error.syncStage === "response_parse");
});

test("the real home renderer tolerates missing createdAt and boots without storage access or writes", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const element = () => ({
    dataset: {}, value: "", classList: { toggle() {} },
    addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {},
  });
  const elements = new Map();
  const context = {
    document: {
      querySelector: (key) => { if (!elements.has(key)) elements.set(key, element()); return elements.get(key); },
      querySelectorAll: () => [],
      createElement: element, createElementNS: element, body: element(),
    },
    localStorage: {
      getItem() { throw new DOMException("denied", "SecurityError"); },
      setItem() { assert.fail("boot must not mutate local data"); },
    },
    window: {}, crypto, CustomEvent, Date,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.window.pKakeiboApp.setExpenses([expense, { ...expense, id: "second" }]);
  assert.equal(context.window.pKakeiboApp.getExpenses().length, 2);
  assert.equal(elements.get("#month-total").textContent.startsWith("¥ "), true);
});
