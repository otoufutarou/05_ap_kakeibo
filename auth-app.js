import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client.js";
import { supabaseConfig } from "./supabase-config.js";
import { loadAccountData, saveAccountSettings, syncAccountExpenses, validateExpenses } from "./cloud-data.js";

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

const pendingStorageKey = (id) => `p-kakeibo-cloud-pending:${id}`;
const pendingThemeKey = (id) => `p-kakeibo-theme-pending:${id}`;
const offeredKey = (id) => `p-kakeibo-import-offered:${id}`;
const cloneExpenses = (items) => items.map((item) => ({ ...item }));

function setStatus(message, isError = false) {
  status.textContent = message;
  status.setAttribute("aria-live", isError ? "assertive" : "polite");
  retryButton.hidden = !isError || !activeUser;
}

function showGuest() {
  clearRetry();
  accountEpoch += 1;
  activeUser = null;
  pendingSave = null;
  pendingTheme = null;
  pendingRecoveryBlocked = false;
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
  activeUser = user;
  pendingSave = null;
  pendingTheme = null;
  pendingRecoveryBlocked = false;
  pendingStorageUnavailable = false;
  pendingThemeStorageUnavailable = false;
  window.pKakeiboAuth = { status: restoring ? "restoring" : "signed-in", user };
  guestActions.hidden = true;
  signedInActions.hidden = false;
  accountDescription.textContent = "このアカウントの記録はクラウドに保存され、ほかの端末と同期されます。";
  accountIdentity.textContent = `${user.email || "メールアドレス未設定"}（ログイン方法：${(user.app_metadata?.providers || []).join("・") || "不明"}）`;
}

function readPending(userId) {
  try {
    const raw = localStorage.getItem(pendingStorageKey(userId));
    if (raw === null) return { state: "none" };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.expenses)
      || (parsed.expected !== null && parsed.expected !== undefined
        && (!Array.isArray(parsed.expected) || parsed.expected.some((item) =>
          !item || typeof item.id !== "string" || typeof item.updatedAt !== "string")))) {
      throw new Error("invalid_pending_data");
    }
    return {
      state: "valid",
      pending: {
        generation: Number.isSafeInteger(parsed.generation) ? parsed.generation : 0,
        expenses: validateExpenses(parsed.expenses),
        expected: Array.isArray(parsed.expected) ? parsed.expected : null,
      },
    };
  } catch {
    return { state: "invalid" };
  }
}

function writePending(userId, pending) {
  try {
    localStorage.setItem(pendingStorageKey(userId), JSON.stringify(pending));
    return true;
  } catch {
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
  const code = typeof error?.code === "string" ? error.code
    : Number.isFinite(error?.status) ? `HTTP ${error.status}` : "不明";
  const rawMessage = [error?.message, error?.details, error?.hint]
    .filter((part) => typeof part === "string" && part)
    .join(" / ");
  const message = rawMessage
    ? rawMessage.replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\bsb_publishable_[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/[\r\n\t]+/g, " ").slice(0, 240)
    : "詳細はブラウザーの通信状態とSupabase設定を確認してください";
  return `${code}: ${message}`;
}

function isRetryable(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (isConflict(error) || error?.code === "42501"
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
    retrySave();
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
  if (!client || !isCurrentAccount(userId, epoch) || pendingRecoveryBlocked) return;
  pending.expected ??= baseline.map((item) => ({ id: item.id, updatedAt: item.updatedAt }));
  if (pendingSave?.generation === pending.generation && isCurrentAccount(userId, epoch)) {
    pendingStorageUnavailable = !writePending(userId, pending);
  }
  setStatus("クラウドへ保存しています…");
  expenseSyncInFlightEpoch = epoch;
  try {
    const saved = await syncAccountExpenses(client, pending.expenses, pending.expected);
    if (!isCurrentAccount(userId, epoch)) return;
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
    discardButton.hidden = !conflict;
    setStatus(conflict
      ? `別の端末で記録が更新されています。新しい内容を確認してから同期してください。${pendingStorageUnavailable ? "未保存データはこの画面を閉じると失われる可能性があります。" : ""}`
      : `クラウド保存に失敗しました（${errorDetail(error)}）。${pendingStorageUnavailable ? "未保存データはこの画面を閉じると失われる可能性があります。" : "未保存データはこの端末に保持されています。"}通信・Supabase設定を確認し、自動再試行または手動同期をお待ちください。`, true);
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
    generation: ++generation,
    expenses: cloneExpenses(expenses),
    expected: baseline.map((expense) => ({ id: expense.id, updatedAt: expense.updatedAt })),
  };
  pendingSave = item;
  pendingStorageUnavailable = !writePending(userId, item);
  queue = queue.catch(() => {}).then(() => flushPending(item, userId, epoch));
}

async function retrySave() {
  if (!activeUser || pendingRecoveryBlocked || retryInFlightEpoch === accountEpoch
    || expenseSyncInFlightEpoch === accountEpoch) return;
  const userId = activeUser.id;
  const epoch = accountEpoch;
  retryInFlightEpoch = epoch;
  try {
    if (!pendingSave) {
      const restored = readPending(userId);
      if (restored.state === "invalid") {
        pendingRecoveryBlocked = true;
        app.hidden = true;
        loadError.hidden = false;
        loadErrorMessage.textContent = "端末内の未保存データを読み取れません。元データは削除せず残しています。上書きを防ぐため同期を停止しました。";
        setStatus("未保存データの形式を確認できません。元データを保護するため自動同期を停止しました。", true);
        return;
      }
      if (restored.state === "valid") pendingSave = restored.pending;
    }
    if (pendingSave) {
      const item = { ...pendingSave, generation: ++generation };
      pendingSave = item;
      pendingStorageUnavailable = !writePending(userId, item);
      queue = queue.catch(() => {}).then(() => flushPending(item, userId, epoch));
      await queue;
    }
    if (pendingTheme && isCurrentAccount(userId, epoch)) {
      queueThemeSave(pendingTheme);
      await themeQueue;
    }
  } finally {
    if (retryInFlightEpoch === epoch) retryInFlightEpoch = null;
  }
}

function queueThemeSave(theme) {
  if (!activeUser || !client) return;
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
    if (!isCurrentAccount(userId, epoch) || version !== themeGeneration) return;
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
        setStatus(`テーマ設定の保存に失敗しました（${errorDetail(error)}）。${pendingThemeStorageUnavailable ? "未保存の設定はこの画面を閉じると失われる可能性があります。" : "未保存の設定はこの端末に保持されています。"}通信を確認し、自動再試行または手動同期をお待ちください。`, true);
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

async function activateUser(user) {
  window.pKakeiboAuth = { status: "restoring", user };
  showSignedIn(user, true);
  const epoch = accountEpoch;
  app.hidden = true;
  setStatus("クラウドの記録を確認しています…");
  try {
    const account = await loadAccountData(client);
    if (!isCurrentAccount(user.id, epoch)) return;
    baseline = account.expenses;
    const storedPending = readPending(user.id);
    if (storedPending.state === "invalid") {
      pendingRecoveryBlocked = true;
      loadError.hidden = false;
      loadErrorMessage.textContent = "端末内の未保存データを読み取れません。元データは削除せず残しています。上書きを防ぐため同期を停止しました。";
      setStatus("未保存データの形式を確認できません。元データを保護するため自動同期を停止しました。", true);
      return;
    }
    const pending = storedPending.state === "valid" ? storedPending.pending : null;
    pendingSave = pending;
    discardButton.hidden = true;
    try {
      const savedTheme = localStorage.getItem(pendingThemeKey(user.id));
      pendingTheme = ["purple", "blue", "green", "yellow"].includes(savedTheme) ? savedTheme : null;
    } catch {
      pendingTheme = null;
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
    if (pending || pendingTheme) retrySave();
  } catch (error) {
    if (!isCurrentAccount(user.id, epoch)) return;
    window.pKakeiboApp.setExpenses([]);
    app.hidden = true;
    loadError.hidden = false;
    loadErrorMessage.textContent = `クラウドの記録を読み込めません（${errorDetail(error)}）。安全のため端末内の別の記録は表示していません。通信と設定を確認してください。`;
    setStatus("クラウドの記録を読み込めません。端末内の別の記録は表示せず、通信と設定を確認してください。", true);
  }
}

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
  window.pKakeiboApp.applyTheme(theme);
  delete app.dataset.owner;
}

document.querySelector("#retry-cloud-sync").addEventListener("click", retrySave);
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
    discardButton.hidden = true;
    setStatus("クラウドの最新記録に切り替えました。");
  } catch {
    setStatus("クラウドの最新記録を読み込めません。未保存の変更は保持されています。", true);
  }
});
document.querySelector("#retry-app-load").addEventListener("click", () => {
  if (activeUser) activateUser(activeUser);
  else start();
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
  retrySave();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && activeUser && !pendingRecoveryBlocked) retrySave();
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
    window.pKakeiboApp.setExpenses([]);
    app.hidden = true;
    loadError.hidden = false;
    loadErrorMessage.textContent = "認証状態を確認できません。安全のため記録は表示していません。通信を確認して再読み込みしてください。";
    setStatus("認証状態を確認できません。安全のため端末内の記録は表示していません。通信を確認して再読み込みしてください。", true);
  }
}

start();
