import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client.js";
import { supabaseConfig } from "./supabase-config.js";
import { loadAccountData, saveAccountSettings, syncAccountExpenses, validateExpenses } from "./cloud-data.js";
import { pendingStorageKey, readPending as inspectPending, preserveOriginal, storageFailure } from "./pending-data.js";

const app = document.querySelector("#app");
const loadError = document.querySelector("#app-load-error");
const loadErrorMessage = document.querySelector("#app-load-error-message");
const status = document.querySelector("#cloud-status");
const guestActions = document.querySelector("#guest-account-actions");
const signedInActions = document.querySelector("#signed-in-account-actions");
const accountDescription = document.querySelector("#account-description");
const accountIdentity = document.querySelector("#account-identity");
const retryButton = document.querySelector("#retry-cloud-sync");
const discardButton = document.querySelector("#discard-pending-changes");
const importDialog = document.querySelector("#import-dialog");
const openCloudReadOnlyButton = document.querySelector("#open-cloud-read-only");
let client = null;
let baseline = [];
let queue = Promise.resolve();
let themeQueue = Promise.resolve();
let generation = 0;
let themeGeneration = 0;
let activeUser = null;
let pendingSave = null;
let pendingTheme = null;
let pendingRecoveryBlocked = false;
let pendingStorageUnavailable = false;
let pendingThemeStorageUnavailable = false;
let accountEpoch = 0;
let retryTimer = null;
let retryDelay = 1000;
let retryInFlightEpoch = null;
let expenseSyncInFlightEpoch = null;
let expenseSyncPaused = false;
let themeSyncPaused = false;
let recoverySnapshot = null;
let pendingWriteFailure = null;

const pendingThemeKey = (id) => `p-kakeibo-theme-pending:${id}`;
const offeredKey = (id) => `p-kakeibo-import-offered:${id}`;
const cloneExpenses = (items) => items.map((item) => ({ ...item }));

function setReadOnlyMode(enabled) {
  if (window.pKakeiboAuth) window.pKakeiboAuth.readOnly = enabled;
  app.dataset.readonly = String(enabled);
  const notice = document.querySelector("#readonly-mode-notice");
  notice.hidden = !enabled;
  notice.textContent = enabled
    ? "未保存データは保護されています。クラウドの記録を読み取り専用で表示中です。新規登録・編集・テーマ変更・同期は停止しています。"
    : "";
}

function blockReadOnlyMutation(event) {
  if (!window.pKakeiboAuth?.readOnly) return;
  const target = event.target;
  const changesRecord = event.type === "submit"
    || target.closest?.("[data-theme], .log-row .name, .log-row .delete, #edit-delete");
  if (!changesRecord) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

document.addEventListener("click", blockReadOnlyMutation, true);
document.addEventListener("submit", blockReadOnlyMutation, true);

function setStatus(message, isError = false) {
  status.textContent = message;
  status.setAttribute("aria-live", isError ? "assertive" : "polite");
  retryButton.hidden = !isError || !activeUser;
}

function showGuest() {
  clearRetry();
  accountEpoch += 1;
  setReadOnlyMode(false);
  activeUser = null;
  pendingSave = null;
  pendingTheme = null;
  pendingRecoveryBlocked = false;
  resetRecovery();
  pendingStorageUnavailable = false;
  pendingThemeStorageUnavailable = false;
  discardButton.hidden = true;
  baseline = [];
  window.pKakeiboAuth = { status: "guest", user: null };
  guestActions.hidden = false;
  signedInActions.hidden = true;
  accountDescription.textContent = "ログインしなくても使えます。記録はこのブラウザ内に保存され、ブラウザデータを削除すると失われる可能性があります。";
  accountIdentity.textContent = "";
  app.hidden = false;
  setStatus(isSupabaseConfigured()
    ? "ゲストモード：記録はこのブラウザ内だけに保存されています。"
    : "ゲストモード：クラウド保存を使うにはSupabaseの公開設定が必要です。");
}

function showSignedIn(user, restoring = false) {
  clearRetry();
  accountEpoch += 1;
  setReadOnlyMode(false);
  activeUser = user;
  pendingSave = null;
  pendingTheme = null;
  pendingRecoveryBlocked = false;
  resetRecovery();
  pendingStorageUnavailable = false;
  pendingThemeStorageUnavailable = false;
  window.pKakeiboAuth = { status: restoring ? "restoring" : "signed-in", user };
  guestActions.hidden = true;
  signedInActions.hidden = false;
  accountDescription.textContent = "このアカウントの記録はクラウドに保存され、ほかの端末と同期されます。";
  accountIdentity.textContent = `${user.email || "メールアドレス未設定"}（ログイン方法：${(user.app_metadata?.providers || []).join("・") || "不明"}）`;
}

function readPending(userId) {
  let storage;
  try {
    storage = localStorage;
  } catch (error) {
    return { state: "invalid", reason: storageFailure(error) };
  }
  return inspectPending(storage, userId);
}

const recoveryReasons = {
  json: "保存値をJSONとして解析できません。",
  structure: "未保存キューのexpensesが配列ではない、またはキューの構造が不正です。",
  expenses: "支出の必須項目・金額・日付・重複IDなどに検証エラーがあります。",
  expected: "競合判定用のexpectedに不正または欠落したID・更新日時があります。最新日時で補うと他端末の変更を上書きするため、自動補完しません。",
  generation: "保存世代generationが0以上の安全な整数ではありません。",
  version: "このアプリで対応していない保存形式のバージョンです。",
  theme: "未保存のテーマ設定が対応する4色の値ではありません。元の値を保持し、支出も送信せず停止しました。",
  account: "保存キーと記録内のアカウントが一致しません。別アカウントへの混在を防ぐため停止しました。",
  storage_access: "ブラウザの保存領域にアクセスできません。アクセス許可の回復後に再確認してください。",
  storage_quota: "保存容量が不足して原文の保護用コピーを確保できません。JSONを保存し、他の不要なデータの容量を確認してください。",
  storage_verify: "原文の保護用コピーの保存を確認できません。",
  legacy: "旧形式の記録です。競合情報がない場合は空のexpectedで復元し、既存クラウド記録と異なる内容はRPCの競合保護で停止します。元データの保護用コピーを確保してから復元します。",
};

function resetRecovery() {
  recoverySnapshot = null;
  expenseSyncPaused = false;
  themeSyncPaused = false;
  document.querySelector("#recover-legacy-pending").hidden = true;
  document.querySelector("#view-cloud-records").hidden = true;
  document.querySelector("#recovery-cloud-records").replaceChildren();
  document.querySelector("#recovery-cloud-records").hidden = true;
  document.querySelector("#recovery-cloud-status").textContent = "";
  document.querySelector("#recovery-account").textContent = "";
  document.querySelector("#recovery-detail").textContent = "";
  openCloudReadOnlyButton.hidden = true;
}

function showRecovery(result) {
  clearRetry();
  pendingRecoveryBlocked = true;
  recoverySnapshot = result;
  app.hidden = true;
  loadError.hidden = false;
  document.querySelector("#recovery-account").textContent = `復旧対象：${activeUser.email || activeUser.id}`;
  const report = result.report;
  const counts = report
    ? ` 全${report.total}件、検証通過${report.valid}件、要確認${report.total - report.valid}件。`
    : "";
  const issues = report?.issues.slice(0, 20).map((issue) => `${issue.index + 1}件目: ${issue.field}`).join(" / ");
  document.querySelector("#recovery-detail").textContent = `診断: ${result.reason} — ${recoveryReasons[result.reason] || "原因を確認できません。"}${counts}${issues ? ` ${issues}` : ""}`;
  document.querySelector("#recover-legacy-pending").hidden = result.reason !== "legacy";
  document.querySelector("#view-cloud-records").hidden = false;
  openCloudReadOnlyButton.hidden = false;
  loadErrorMessage.textContent = `端末内の未保存データの安全な復元を確認できません。元データは削除せず残しています。上書きを防ぐため同期を停止しました。${counts}`;
  setStatus("未保存データを保護しています。理由を確認し、元データをバックアップしてください。", true);
}

function protectPending(userId, result) {
  const protection = preserveOriginal(localStorage, userId, result.raw);
  if (!protection.ok) showRecovery({ ...result, reason: protection.reason });
  return protection.ok;
}

function writePending(userId, pending) {
  try {
    localStorage.setItem(pendingStorageKey(userId), JSON.stringify(pending));
    pendingWriteFailure = null;
    return true;
  } catch (error) {
    pendingWriteFailure = storageFailure(error);
    return false;
  }
}

function isCurrentAccount(userId, epoch) {
  return activeUser?.id === userId && accountEpoch === epoch;
}

function isConflict(error) {
  return error?.code === "40001"
    || (typeof error?.message === "string" && error.message.includes("sync_conflict"));
}

function errorDetail(error) {
  const stages = {
    local_validation: "端末内の入力検証（RPC送信前）",
    rpc_transport: "p_kakeibo_sync_expenses RPC通信（送信・応答受信の結果は不明）",
    rpc_response: "p_kakeibo_sync_expenses RPC応答受信済み",
    response_parse: "p_kakeibo_sync_expenses RPC成功応答の解析",
    response_verification: "保存結果の照合",
  };
  const diagnostic = [];
  if (stages[error?.syncStage]) diagnostic.push(`段階: ${stages[error.syncStage]}`);
  if (Number.isFinite(error?.status)) diagnostic.push(`HTTP ${error.status}`);
  if (typeof error?.code === "string") diagnostic.push(`Supabase/PostgreSQL code ${error.code}`);
  const rawMessage = [error?.message, error?.details, error?.hint]
    .filter((part) => typeof part === "string" && part)
    .join(" / ");
  const message = rawMessage
    ? rawMessage.replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\bsb_publishable_[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/[\r\n\t]+/g, " ").slice(0, 240)
    : "詳細はブラウザーの通信状態とSupabase設定を確認してください";
  return `${diagnostic.length ? `${diagnostic.join(" / ")}: ` : ""}${message}`;
}

function isRetryable(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (["local_validation", "response_parse", "response_verification"].includes(error?.syncStage)
    || isConflict(error) || error?.code === "42501"
    || ["invalid_expenses", "sync_verification", "sync_response_invalid"].includes(code)
    || ["42P01", "42883"].includes(code)
    || code.startsWith("22") || code.startsWith("23")) return false;
  if (error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return false;
  return true;
}

function scheduleRetry() {
  if (retryTimer || !activeUser || pendingRecoveryBlocked || navigator.onLine === false) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 300000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retrySave(false);
  }, delay);
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 1000;
}

function clearRetryIfIdle() {
  if (!pendingSave && !pendingTheme) clearRetry();
}

async function flushPending(pending, userId, epoch) {
  if (!client || !isCurrentAccount(userId, epoch) || pendingRecoveryBlocked || expenseSyncPaused) return;
  if (pendingSave?.generation !== pending.generation) return;
  pending.expected ??= [];
  if (pendingSave?.generation === pending.generation && isCurrentAccount(userId, epoch)) {
    pendingStorageUnavailable = !writePending(userId, pending);
  }
  setStatus("クラウドへ保存しています…");
  expenseSyncInFlightEpoch = epoch;
  try {
    const saved = await syncAccountExpenses(client, pending.expenses, pending.expected);
    if (!isCurrentAccount(userId, epoch)) return;
    if (pending.expenses.some((expense) => !saved.some((item) => item.id === expense.id
      && item.name === expense.name.trim() && item.amount === expense.amount && item.date === expense.date))) {
      const error = new Error("保存結果の件数・内容を確認できません。未保存キューを保持しています。");
      error.code = "sync_verification";
      error.syncStage = "response_verification";
      throw error;
    }
    baseline = saved;
    if (pendingSave?.generation === pending.generation) {
      pendingSave = null;
      pendingStorageUnavailable = false;
      window.pKakeiboApp.setExpenses(saved);
      try {
        localStorage.removeItem(pendingStorageKey(userId));
      } catch {
        // Keep the successfully saved account usable if local cleanup is blocked.
      }
      clearRetryIfIdle();
      setStatus(pendingTheme ? "記録は同期済みですが、テーマ設定は未保存です。" : "クラウド保存済み・同期済み", Boolean(pendingTheme));
    } else {
      if (pendingSave) {
        pendingSave.expected = baseline.map((item) => ({ id: item.id, updatedAt: item.updatedAt }));
        pendingStorageUnavailable = !writePending(userId, pendingSave);
      }
      setStatus("変更を順番にクラウドへ保存しています…");
    }
  } catch (error) {
    if (!isCurrentAccount(userId, epoch)) return;
    if (pendingSave?.generation === pending.generation) {
      pendingSave = pending;
      pendingStorageUnavailable = !writePending(userId, pending);
    }
    const conflict = isConflict(error);
    expenseSyncPaused = !isRetryable(error);
    discardButton.hidden = !conflict;
    setStatus(conflict
      ? `別の端末で記録が更新されています。新しい内容を確認してから同期してください。${pendingStorageUnavailable ? "未保存データはこの画面を閉じると失われる可能性があります。" : ""}`
      : `クラウド保存に失敗しました（${errorDetail(error)}）。${pendingStorageUnavailable ? `未保存データはこの画面を閉じると失われる可能性があります（${pendingWriteFailure}）。` : "未保存データはこの端末に保持されています。"}${expenseSyncPaused ? "形式・権限・保存結果の確認が必要なため自動再試行を停止しました。" : "通信を確認してください。自動再試行します。"}`, true);
    if (isRetryable(error)) scheduleRetry();
  } finally {
    if (expenseSyncInFlightEpoch === epoch) expenseSyncInFlightEpoch = null;
  }
}

function queueSave(expenses) {
  if (!activeUser || pendingRecoveryBlocked) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  const item = {
    ...pendingSave,
    generation: ++generation,
    expenses: cloneExpenses(expenses),
    expected: pendingSave?.expected ?? baseline.map((expense) => ({ id: expense.id, updatedAt: expense.updatedAt })),
  };
  pendingSave = item;
  pendingStorageUnavailable = !writePending(userId, item);
  queue = queue.catch(() => {}).then(() => flushPending(item, userId, epoch));
}

async function retrySave(manual = true) {
  if (!activeUser || pendingRecoveryBlocked || retryInFlightEpoch === accountEpoch
    || expenseSyncInFlightEpoch === accountEpoch) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  if (manual) {
    expenseSyncPaused = false;
    themeSyncPaused = false;
  }
  retryInFlightEpoch = epoch;
  try {
    if (!pendingSave) {
      const restored = readPending(userId);
      if (restored.state === "invalid" || restored.legacy) {
        showRecovery(restored.legacy ? { ...restored, reason: "legacy" } : restored);
        return;
      }
      if (restored.state === "valid") {
        if (!protectPending(userId, restored)) return;
        pendingSave = restored.pending;
      }
    }
    if (pendingSave && !expenseSyncPaused) {
      const item = { ...pendingSave, generation: ++generation };
      pendingSave = item;
      pendingStorageUnavailable = !writePending(userId, item);
      queue = queue.catch(() => {}).then(() => flushPending(item, userId, epoch));
      await queue;
    }
    if (pendingTheme && !themeSyncPaused && isCurrentAccount(userId, epoch)) {
      queueThemeSave(pendingTheme);
      await themeQueue;
    }
  } finally {
    if (retryInFlightEpoch === epoch) retryInFlightEpoch = null;
  }
}

function queueThemeSave(theme) {
  if (!activeUser || !client || pendingRecoveryBlocked) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  const version = ++themeGeneration;
  pendingTheme = theme;
  pendingThemeStorageUnavailable = false;
  try {
    localStorage.setItem(pendingThemeKey(userId), theme);
  } catch {
    pendingThemeStorageUnavailable = true;
  }
  themeQueue = themeQueue.catch(() => {}).then(async () => {
    if (!isCurrentAccount(userId, epoch) || version !== themeGeneration || pendingRecoveryBlocked || themeSyncPaused) return;
    try {
      await saveAccountSettings(client, userId, theme);
      if (!isCurrentAccount(userId, epoch) || version !== themeGeneration) return;
      pendingTheme = null;
      pendingThemeStorageUnavailable = false;
      try {
        localStorage.removeItem(pendingThemeKey(userId));
      } catch {
        // The remote setting is verified even if local cleanup is unavailable.
      }
      clearRetryIfIdle();
      setStatus(pendingSave ? "テーマ設定は同期済みです。支出記録に未保存の変更があります。" : "テーマ設定をクラウドに保存しました。", Boolean(pendingSave));
    } catch (error) {
      if (isCurrentAccount(userId, epoch) && version === themeGeneration) {
        themeSyncPaused = !isRetryable(error);
        setStatus(`テーマ設定の保存に失敗しました（${errorDetail(error)}）。${pendingThemeStorageUnavailable ? "未保存の設定はこの画面を閉じると失われる可能性があります。" : "未保存の設定はこの端末に保持されています。"}${themeSyncPaused ? "権限・形式を確認してください。自動再試行を停止しました。" : "通信を確認してください。自動再試行します。"}`, true);
        if (isRetryable(error)) scheduleRetry();
      }
    }
  });
}

function offerLocalImport(user, localExpenses) {
  if (!localExpenses.length) return;
  try {
    if (localStorage.getItem(offeredKey(user.id))) return;
    localStorage.setItem(offeredKey(user.id), "shown");
  } catch {
    // The explicit import prompt can still be shown for this visit.
  }
  document.querySelector("#import-account").textContent = `移行先：${user.email || "このアカウント"}`;
  document.querySelector("#import-feedback").textContent = `${localExpenses.length}件の端末内記録が見つかりました。`;
  importDialog.showModal();
}

function readLocalExpenses() {
  try {
    const raw = JSON.parse(localStorage.getItem("p-kakeibo-v1") || "[]");
    return Array.isArray(raw)
      ? raw.filter((item) => item && typeof item.name === "string" && Number.isFinite(item.amount)
        && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
      : [];
  } catch {
    return [];
  }
}

async function activateUser(user, approvedLegacyRaw) {
  window.pKakeiboAuth = { status: "restoring", user };
  showSignedIn(user, true);
  const epoch = accountEpoch;
  let storedPending = null;
  app.hidden = true;
  document.querySelector("#view-cloud-records").hidden = false;
  setStatus("クラウドの記録を確認しています…");
  try {
    storedPending = readPending(user.id);
    if (storedPending.state === "invalid") {
      showRecovery(storedPending);
      return;
    }
    if (storedPending.legacy && approvedLegacyRaw !== storedPending.raw) {
      showRecovery({ ...storedPending, reason: "legacy" });
      return;
    }
    if (storedPending.state === "valid" && !protectPending(user.id, storedPending)) return;
    const account = await loadAccountData(client);
    if (!isCurrentAccount(user.id, epoch)) return;
    baseline = account.expenses;
    const pending = storedPending.state === "valid" ? storedPending.pending : null;
    pendingSave = pending;
    discardButton.hidden = true;
    try {
      const savedTheme = localStorage.getItem(pendingThemeKey(user.id));
      if (savedTheme !== null && !["purple", "blue", "green", "yellow"].includes(savedTheme)) {
        showRecovery({ reason: "theme" });
        return;
      }
      pendingTheme = ["purple", "blue", "green", "yellow"].includes(savedTheme) ? savedTheme : null;
    } catch (error) {
      showRecovery({ reason: storageFailure(error) });
      return;
    }
    window.pKakeiboApp.setExpenses(pending?.expenses || account.expenses);
    window.pKakeiboApp.applyTheme(pendingTheme || account.settings.theme);
    window.pKakeiboAuth = { status: "signed-in", user };
    app.hidden = false;
    loadError.hidden = true;
    if (location.hash === "#settings") window.pKakeiboApp.showSettings();
    setStatus(pending || pendingTheme
      ? "前回の未保存変更を確認しました。クラウドへ自動再送信しています。"
      : "クラウド保存済み・同期済み", Boolean(pending || pendingTheme));
    document.querySelector("#app").dataset.owner = user.id;
    if (!pending) offerLocalImport(user, readLocalExpenses());
    if (pending || pendingTheme) retrySave(false);
  } catch (error) {
    if (!isCurrentAccount(user.id, epoch)) return;
    if (storedPending?.state === "valid") {
      let savedTheme;
      try {
        savedTheme = localStorage.getItem(pendingThemeKey(user.id));
      } catch (storageError) {
        showRecovery({ reason: storageFailure(storageError) });
        return;
      }
      if (savedTheme !== null && !["purple", "blue", "green", "yellow"].includes(savedTheme)) {
        showRecovery({ reason: "theme" });
        return;
      }
      pendingSave = storedPending.pending;
      pendingTheme = savedTheme;
      expenseSyncPaused = !isRetryable(error);
      window.pKakeiboApp.setExpenses(pendingSave.expenses);
      window.pKakeiboApp.applyTheme(savedTheme || "purple", false);
      window.pKakeiboAuth = { status: "signed-in", user };
      app.hidden = false;
      loadError.hidden = true;
      setStatus(`クラウドを読み込めません（${errorDetail(error)}）。端末内の未保存記録を表示しています。${expenseSyncPaused ? "エラーを確認するまで自動送信を停止しました。" : "記録を保持し、自動再送信します。"}`, true);
      if (!expenseSyncPaused) retrySave(false);
      return;
    }
    app.hidden = true;
    loadError.hidden = false;
    openCloudReadOnlyButton.hidden = false;
    document.querySelector("#recovery-detail").textContent = "クラウドへの通信・権限・設定を確認してください。端末内の原本は変更しません。";
    loadErrorMessage.textContent = `クラウドの記録を読み込めません（${errorDetail(error)}）。安全のため端末内の別の記録は表示していません。通信と設定を確認してください。`;
    setStatus("クラウドの記録を読み込めません。端末内の別の記録は表示せず、通信と設定を確認してください。", true);
  }
}

openCloudReadOnlyButton.addEventListener("click", async () => {
  if (!activeUser || !client) return;
  const user = activeUser;
  const epoch = accountEpoch;
  const feedback = document.querySelector("#recovery-cloud-status");
  openCloudReadOnlyButton.disabled = true;
  feedback.textContent = "このアカウントのクラウド記録を確認しています…";
  try {
    const before = await client.auth.getSession();
    if (!isCurrentAccount(user.id, epoch)) return;
    if (before.error || before.data.session?.user.id !== user.id) {
      throw new Error("ログイン中のアカウントを確認できません。");
    }
    const account = await loadAccountData(client);
    if (!isCurrentAccount(user.id, epoch)) return;
    const after = await client.auth.getSession();
    if (!isCurrentAccount(user.id, epoch)) return;
    if (after.error || after.data.session?.user.id !== user.id) {
      throw new Error("読み込み中にアカウントが変わったため表示を停止しました。");
    }
    baseline = account.expenses;
    window.pKakeiboApp.setExpenses(account.expenses);
    window.pKakeiboApp.applyTheme(account.settings.theme, false);
    setReadOnlyMode(true);
    app.hidden = false;
    loadError.hidden = true;
    setStatus("クラウド記録を表示中（読み取り専用）。未保存データは保持され、同期していません。", true);
  } catch (error) {
    if (!isCurrentAccount(user.id, epoch)) return;
    feedback.textContent = `クラウド記録を開けません（${errorDetail(error)}）。未保存データは保持しています。`;
  } finally {
    openCloudReadOnlyButton.disabled = false;
  }
});

function activateGuest() {
  clearRetry();
  showGuest();
  loadError.hidden = true;
  window.pKakeiboApp.setExpenses(readLocalExpenses());
  let theme = "purple";
  try {
    theme = localStorage.getItem("p-kakeibo-theme") || "purple";
  } catch {
    // The application can still run with its default theme.
  }
  window.pKakeiboApp.applyTheme(theme, false);
  delete app.dataset.owner;
}

document.querySelector("#retry-cloud-sync").addEventListener("click", () => retrySave());
discardButton.addEventListener("click", async () => {
  if (!activeUser || !client) return;
  if (!confirm("この端末の未保存変更（支出・テーマ）を破棄し、クラウドの最新内容に切り替えます。よろしいですか？")) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  try {
    const account = await loadAccountData(client);
    if (!isCurrentAccount(userId, epoch)) return;
    baseline = account.expenses;
    pendingSave = null;
    discardButton.hidden = true;
    pendingTheme = null;
    localStorage.removeItem(pendingStorageKey(activeUser.id));
    localStorage.removeItem(pendingThemeKey(activeUser.id));
    window.pKakeiboAuth.status = "restoring";
    window.pKakeiboApp.setExpenses(account.expenses);
    window.pKakeiboApp.applyTheme(account.settings.theme);
    window.pKakeiboAuth.status = "signed-in";
    expenseSyncPaused = false;
    themeSyncPaused = false;
    clearRetry();
    discardButton.hidden = true;
    setStatus("クラウドの最新記録に切り替えました。");
  } catch {
    setStatus("クラウドの最新記録を読み込めません。未保存の変更は保持されています。", true);
  }
});
document.querySelector("#retry-app-load").addEventListener("click", () => {
  if ((pendingSave || pendingTheme) && !pendingRecoveryBlocked) {
    setStatus("画面内の未保存変更を保持しています。設定画面から同期を再試行してください。", true);
    return;
  }
  if (activeUser) activateUser(activeUser);
  else start();
});
document.querySelector("#recover-legacy-pending").addEventListener("click", () => {
  if (!activeUser || recoverySnapshot?.reason !== "legacy") return;
  if (!confirm("JSONバックアップが端末に保存されていることを確認してください。原文の保護用コピーを端末に確保し、全件を復元して自動同期します。既存クラウド記録と競合した場合は停止します。続けますか？")) return;
  activateUser(activeUser, recoverySnapshot.raw);
});
document.querySelector("#view-cloud-records").addEventListener("click", async () => {
  if (!activeUser || !client) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  const feedback = document.querySelector("#recovery-cloud-status");
  const records = document.querySelector("#recovery-cloud-records");
  records.replaceChildren();
  records.hidden = true;
  feedback.textContent = "このアカウントのクラウド記録を読み込んでいます…";
  try {
    const { data, error } = await client.auth.getSession();
    if (!isCurrentAccount(userId, epoch)) return;
    if (error || data.session?.user.id !== userId) throw new Error("アカウントが一致しません。再ログインして確認してください。");
    const account = await loadAccountData(client);
    if (!isCurrentAccount(userId, epoch)) return;
    const verified = await client.auth.getSession();
    if (!isCurrentAccount(userId, epoch)) return;
    if (verified.error || verified.data.session?.user.id !== userId) throw new Error("アカウントが変わったため表示を停止しました。");
    for (const expense of account.expenses) {
      const row = document.createElement("p");
      row.textContent = `${expense.date} / ${expense.name} / ${expense.amount}円`;
      records.append(row);
    }
    records.hidden = false;
    feedback.textContent = `${account.expenses.length}件取得（読み取り専用）。サーバーの返却上限により全件ではない場合があります。端末内の記録は変更していません。`;
  } catch (error) {
    if (isCurrentAccount(userId, epoch)) feedback.textContent = `クラウド記録を確認できません（${errorDetail(error)}）。原本は保持しています。`;
  }
});
document.querySelector("#logout").addEventListener("click", async () => {
  if (!client || !activeUser) return;
  if (pendingSave || pendingTheme || pendingRecoveryBlocked || readPending(activeUser.id).state !== "none") {
    setStatus("未保存の変更があります。先に同期を完了してください。", true);
    return;
  }
  if (!confirm("ログアウトしますか？クラウド上の記録は削除されません。")) return;
  const { error } = await client.auth.signOut();
  if (error) {
    setStatus("ログアウトできませんでした。通信を確認して再試行してください。", true);
    return;
  }
  activateGuest();
});

document.querySelector("#delete-account").addEventListener("click", async () => {
  if (!client || !activeUser) return;
  if (pendingSave || pendingTheme || pendingRecoveryBlocked || readPending(activeUser.id).state !== "none") {
    setStatus("未保存の変更があります。先に同期を完了してください。", true);
    return;
  }
  if (!confirm("アカウントとクラウド上の記録を削除します。この操作は原則として元に戻せません。続けますか？")) return;
  setStatus("アカウントを削除しています…");
  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session?.access_token) throw new Error("ログイン状態を確認できません。");
    const response = await fetch(`${supabaseConfig.url}/functions/v1/delete-account`, {
      method: "POST",
      headers: {
        apikey: supabaseConfig.publishableKey,
        authorization: "Bearer " + session.access_token,
      },
    });
    const result = await response.json();
    if (!response.ok || result.deleted !== true) throw new Error(result.error || "削除を確認できませんでした。");
    try {
      localStorage.removeItem(pendingStorageKey(activeUser.id));
      localStorage.removeItem(pendingThemeKey(activeUser.id));
      localStorage.removeItem(offeredKey(activeUser.id));
    } catch {
      // Continue after remote deletion; no authentication cache is exposed in the UI.
    }
    await client.auth.signOut();
    activateGuest();
    setStatus("アカウントとクラウド上の記録を削除しました。");
  } catch (error) {
    setStatus(error.message || "削除を確認できませんでした。再試行してください。", true);
  }
});

document.querySelector("#import-later").addEventListener("click", () => {
  try {
    if (activeUser) localStorage.removeItem(offeredKey(activeUser.id));
  } catch {
    // The prompt can be deferred even if browser storage is restricted.
  }
  importDialog.close();
});
document.querySelector("#import-confirm").addEventListener("click", async () => {
  if (!activeUser || !client) return;
  const button = document.querySelector("#import-confirm");
  button.disabled = true;
  try {
    const local = validateExpenses(JSON.parse(localStorage.getItem("p-kakeibo-v1") || "[]"));
    const existingIds = new Set(baseline.map((item) => item.id));
    const merged = [...baseline, ...local.filter((item) => !existingIds.has(item.id))];
    const imported = await syncAccountExpenses(client, merged, baseline);
    const importedIds = new Set(imported.map((item) => item.id));
    const missing = local.filter((item) => !importedIds.has(item.id));
    if (missing.length) throw new Error("一部の記録を確認できませんでした。元の記録は保持されています。");
    baseline = imported;
    window.pKakeiboApp.setExpenses(imported);
    importDialog.close();
    setStatus(`${local.length}件の記録を確認して引き継ぎました。端末内の元データは残しています。`);
  } catch (error) {
    document.querySelector("#import-feedback").textContent = error.message || "引き継ぎに失敗しました。元の記録は保持されています。";
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("p-kakeibo-data-changed", (event) => {
  if (activeUser) queueSave(event.detail.expenses);
});
window.addEventListener("p-kakeibo-theme-changed", async (event) => {
  queueThemeSave(event.detail.theme);
});

window.addEventListener("online", () => {
  if (!activeUser || pendingRecoveryBlocked) return;
  clearRetry();
  retrySave(false);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && activeUser && !pendingRecoveryBlocked) retrySave(false);
});

async function start() {
  try {
    client = await getSupabaseClient();
    if (!client) {
      activateGuest();
      return;
    }
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (data.session?.user) await activateUser(data.session.user);
    else activateGuest();
    client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        activateGuest();
      } else if (event === "SIGNED_IN" && session?.user && session.user.id !== activeUser?.id) {
        setTimeout(() => activateUser(session.user), 0);
      }
    });
  } catch {
    window.pKakeiboAuth = { status: "failed", user: null };
    setReadOnlyMode(false);
    window.pKakeiboApp.setExpenses([]);
    app.hidden = true;
    loadError.hidden = false;
    loadErrorMessage.textContent = "認証状態を確認できません。安全のため記録は表示していません。通信を確認して再読み込みしてください。";
    setStatus("認証状態を確認できません。安全のため端末内の記録は表示していません。通信を確認して再読み込みしてください。", true);
  }
}

start();
