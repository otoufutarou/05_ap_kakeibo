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
  activeUser = null;
  pendingSave = null;
  pendingTheme = null;
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
  activeUser = user;
  window.pKakeiboAuth = { status: restoring ? "restoring" : "signed-in", user };
  guestActions.hidden = true;
  signedInActions.hidden = false;
  accountDescription.textContent = "このアカウントの記録はクラウドに保存され、ほかの端末と同期されます。";
  accountIdentity.textContent = `${user.email || "メールアドレス未設定"}（ログイン方法：${(user.app_metadata?.providers || []).join("・") || "不明"}）`;
}

function readPending(userId) {
  try {
    const raw = localStorage.getItem(pendingStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      generation: parsed.generation,
      expenses: validateExpenses(parsed.expenses),
      expected: Array.isArray(parsed.expected) ? parsed.expected : null,
    };
  } catch {
    return null;
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

async function flushPending(pending) {
  if (!client || !activeUser) return;
  pending.expected ??= baseline.map((item) => ({ id: item.id, updatedAt: item.updatedAt }));
  if (pendingSave?.generation === pending.generation) writePending(activeUser.id, pending);
  setStatus("クラウドへ保存しています…");
  try {
    const saved = await syncAccountExpenses(client, pending.expenses, pending.expected);
    baseline = saved;
    if (pendingSave?.generation === pending.generation) {
      pendingSave = null;
      window.pKakeiboApp.setExpenses(saved);
      try {
        localStorage.removeItem(pendingStorageKey(activeUser.id));
      } catch {
        // Keep the successfully saved account usable if local cleanup is blocked.
      }
      setStatus(pendingTheme ? "記録は同期済みですが、テーマ設定は未保存です。" : "クラウド保存済み・同期済み", Boolean(pendingTheme));
    } else {
      if (pendingSave) {
        pendingSave.expected = baseline.map((item) => ({ id: item.id, updatedAt: item.updatedAt }));
        writePending(activeUser.id, pendingSave);
      }
      setStatus("変更を順番にクラウドへ保存しています…");
    }
  } catch (error) {
    if (pendingSave?.generation === pending.generation) {
      pendingSave = pending;
      writePending(activeUser.id, pending);
    }
    const conflict = error.code === "40001" || error.message?.includes("sync_conflict");
    discardButton.hidden = !conflict;
    setStatus(conflict
      ? "別の端末で記録が更新されています。新しい内容を確認してから同期してください。"
      : "クラウドへ保存できていません。入力内容はこの端末に保持されています。通信を確認して再試行してください。", true);
  }
}

function queueSave(expenses) {
  if (!activeUser) return;
  const item = {
    generation: ++generation,
    expenses: cloneExpenses(expenses),
    expected: baseline.map((expense) => ({ id: expense.id, updatedAt: expense.updatedAt })),
  };
  pendingSave = item;
  if (!writePending(activeUser.id, item)) {
    setStatus("未保存の変更を端末に退避できません。ログアウトせず通信を確認してください。", true);
    return;
  }
  queue = queue.catch(() => {}).then(() => flushPending(item));
}

async function retrySave() {
  if (!pendingSave) {
    const restored = activeUser && readPending(activeUser.id);
    if (restored) pendingSave = restored;
  }
  if (pendingSave) {
    const item = { ...pendingSave, generation: ++generation };
    pendingSave = item;
    queue = queue.catch(() => {}).then(() => flushPending(item));
  }
  if (pendingTheme && activeUser) {
    await queue;
    queueThemeSave(pendingTheme);
  }
}

function queueThemeSave(theme) {
  if (!activeUser || !client) return;
  const version = ++themeGeneration;
  pendingTheme = theme;
  try {
    localStorage.setItem(pendingThemeKey(activeUser.id), theme);
  } catch {
    // Keep the selected theme in memory and report unsaved state on failure.
  }
  themeQueue = themeQueue.catch(() => {}).then(async () => {
    try {
      await saveAccountSettings(client, activeUser.id, theme);
      if (version !== themeGeneration) return;
      pendingTheme = null;
      try {
        localStorage.removeItem(pendingThemeKey(activeUser.id));
      } catch {
        // The remote setting is verified even if local cleanup is unavailable.
      }
      setStatus(pendingSave ? "テーマ設定は同期済みです。支出記録に未保存の変更があります。" : "テーマ設定をクラウドに保存しました。", Boolean(pendingSave));
    } catch {
      if (version === themeGeneration) {
        setStatus("テーマ設定をクラウドに保存できませんでした。", true);
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
  app.hidden = true;
  setStatus("クラウドの記録を確認しています…");
  try {
    const account = await loadAccountData(client);
    baseline = account.expenses;
    const pending = readPending(user.id);
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
      ? "前回の未保存変更があります。クラウドへ再送信してください。"
      : "クラウド保存済み・同期済み", Boolean(pending || pendingTheme));
    document.querySelector("#app").dataset.owner = user.id;
    if (!pending) offerLocalImport(user, readLocalExpenses());
  } catch {
    window.pKakeiboApp.setExpenses([]);
    app.hidden = true;
    loadError.hidden = false;
    loadErrorMessage.textContent = "クラウドの記録を読み込めません。安全のため端末内の別の記録は表示していません。通信と設定を確認してください。";
    setStatus("クラウドの記録を読み込めません。端末内の別の記録は表示せず、通信と設定を確認してください。", true);
  }
}

function activateGuest() {
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
  try {
    const account = await loadAccountData(client);
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
  if (pendingSave || pendingTheme || readPending(activeUser.id)) {
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
  if (pendingSave || pendingTheme || readPending(activeUser.id)) {
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
