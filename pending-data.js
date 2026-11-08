import { inspectExpenses, validateExpenses, isValidExpected } from "./cloud-data.js";

export const pendingStorageKey = (id) => `p-kakeibo-cloud-pending:${id}`;
export const originalStorageKey = (id) => `p-kakeibo-pending-original:${id}`;

export function storageFailure(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
    ? "storage_quota" : "storage_access";
}

export function readPending(storage, userId) {
  let raw;
  try {
    raw = storage.getItem(pendingStorageKey(userId));
  } catch (error) {
    return { state: "invalid", reason: storageFailure(error) };
  }
  if (raw === null) return { state: "none" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "invalid", reason: "json", raw };
  }
  const invalid = (reason, report) => ({ state: "invalid", reason, raw, report });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.expenses)) return invalid("structure");
  if (parsed.version !== undefined && parsed.version !== 1) return invalid("version");
  if (parsed.userId !== undefined && parsed.userId !== userId) return invalid("account");
  if (parsed.generation !== undefined
    && (!Number.isSafeInteger(parsed.generation) || parsed.generation < 0)) return invalid("generation");
  const report = inspectExpenses(parsed.expenses);
  if (report.issues.length) return invalid("expenses", report);
  if (parsed.expected != null && !isValidExpected(parsed.expected)) return invalid("expected", report);
  return {
    state: "valid",
    raw,
    legacy: parsed.expected == null || parsed.generation === undefined,
    pending: {
      ...parsed,
      generation: parsed.generation ?? 0,
      expenses: validateExpenses(parsed.expenses),
      // Missing concurrency tokens never authorize overwriting existing cloud rows.
      expected: parsed.expected ?? [],
    },
  };
}

export function preserveOriginal(storage, userId, raw) {
  const key = originalStorageKey(userId);
  try {
    const existing = storage.getItem(key);
    if (existing === raw) return { ok: true };
    // Keep every distinct recovered snapshot verbatim, not just the latest one.
    const target = existing === null ? key : `${key}:${crypto.randomUUID()}`;
    storage.setItem(target, raw);
    if (storage.getItem(target) !== raw) return { ok: false, reason: "storage_verify" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: storageFailure(error) };
  }
}
