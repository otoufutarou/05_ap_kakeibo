import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client.js";
import { P_KAKEIBO_ENABLE_SIGNUP } from "./supabase-config.js";

const params = new URLSearchParams(location.search);
const appUrl = new URL("./index.html", location.href);
const authForms = document.querySelector("#auth-forms");
const feedback = document.querySelector("#auth-feedback");
const loginActions = document.querySelector(".login-actions");
const divider = document.querySelector(".login-divider");
const signupButton = document.querySelector("#show-signup");
const formTitle = document.querySelector("#form-title");
const forms = ["email-form", "signup-form", "reset-form", "new-password-form", "email-confirmation", "password-complete"];

function returnToUrl() {
  try {
    const candidate = new URL(params.get("returnTo") || "./index.html", location.href);
    if (candidate.origin === location.origin && candidate.pathname === appUrl.pathname) {
      return candidate.pathname + candidate.hash;
    }
  } catch {
    // Use the app home page for invalid return destinations.
  }
  return appUrl.pathname;
}

function callbackUrl(kind = "auth") {
  const callback = new URL("./login.html", location.href);
  callback.searchParams.set("callback", kind);
  callback.searchParams.set("returnTo", returnToUrl());
  return callback.href;
}

function cleanCallbackUrl() {
  history.replaceState(null, "", location.pathname);
}

function showForm(id, title, message = "") {
  authForms.hidden = false;
  loginActions.hidden = true;
  divider.hidden = true;
  signupButton.hidden = true;
  formTitle.textContent = title;
  feedback.textContent = message;
  feedback.dataset.error = "false";
  forms.forEach((formId) => {
    document.querySelector(`#${formId}`).hidden = formId !== id;
  });
  document.querySelector("#back-to-login").hidden = id === "new-password-form";
  const returnLink = document.querySelector("#account-settings-link");
  returnLink.hidden = !["email-confirmation", "password-complete"].includes(id);
  returnLink.href = returnToUrl();
  returnLink.textContent = "家計簿へ戻る";
}

function showLogin() {
  authForms.hidden = true;
  loginActions.hidden = false;
  divider.hidden = false;
  signupButton.hidden = false;
  feedback.textContent = "";
}

function setFeedback(message, error = false) {
  feedback.textContent = message;
  feedback.dataset.error = String(error);
}

function setBusy(button, busy) {
  button.disabled = busy;
  if (busy) button.dataset.previousText = button.textContent;
  else if (button.dataset.previousText) {
    button.textContent = button.dataset.previousText;
    delete button.dataset.previousText;
  }
}

function isInXBrowser() {
  return /Twitter|X\/|X iPhone|X Android/i.test(navigator.userAgent);
}

document.querySelector("#show-email-login").addEventListener("click", () => showForm("email-form", "メールアドレスでログイン"));
document.querySelector("#show-signup").addEventListener("click", () => showForm("signup-form", "アカウントを作成"));
document.querySelector("#show-reset").addEventListener("click", () => showForm("reset-form", "パスワードを再設定"));
document.querySelector("#back-to-login").addEventListener("click", showLogin);

document.querySelectorAll("[data-toggle-password]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "隠す" : "表示";
    button.setAttribute("aria-label", show ? "パスワードを隠す" : "パスワードを表示");
  });
});

async function start() {
  let client;
  try {
    client = await getSupabaseClient();
  } catch {
    setFormNotice("認証サービスへ接続できません。通信を確認して再読み込みしてください。");
    return;
  }
  if (!client) {
    setFormNotice("認証はまだ設定されていません。SupabaseのProject URLとPublishable keyが必要です。");
    return;
  }

  const callback = params.get("callback");
  if (callback === "recovery") {
    const { data, error } = await client.auth.getSession();
    cleanCallbackUrl();
    if (error || !data.session) {
      showForm("email-form", "パスワード再設定", "再設定リンクが無効または期限切れです。もう一度メールを送信してください。");
    } else {
      showForm("new-password-form", "新しいパスワードを設定");
    }
    return;
  }
  if (callback === "auth" || callback === "verified") {
    const { data, error } = await client.auth.getSession();
    cleanCallbackUrl();
    if (error) {
      setFormNotice("認証を完了できませんでした。リンクが期限切れの場合は再度お試しください。");
    } else if (data.session?.user) {
      location.replace(returnToUrl());
    } else {
      setFormNotice("メール内の確認リンクを開いてください。");
    }
    return;
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    setFormNotice("ログイン状態を確認できませんでした。再試行してください。");
  } else if (data.session?.user) {
    location.replace(returnToUrl());
  }
}

function setFormNotice(message) {
  showForm("email-form", "ログイン・アカウント作成");
  setFeedback(message, true);
}

document.querySelector("#google-login").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!isSupabaseConfigured()) {
    setFormNotice("Googleログインは未設定です。SupabaseのProject URLとPublishable keyが必要です。");
    return;
  }
  if (isInXBrowser()) {
    setFeedback("Xアプリ内ブラウザではGoogle認証が制限される場合があります。Safariなど通常のブラウザでこのページを開いてください。", true);
    return;
  }
  setBusy(button, true);
  setFeedback("Googleへ接続しています…");
  try {
    const client = await getSupabaseClient();
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl("auth") },
    });
    if (error) throw error;
  } catch {
    setFeedback("ログインを開始できませんでした。SupabaseのGoogle設定と通信を確認し、もう一度お試しください。", true);
    setBusy(button, false);
  }
});

document.querySelector("#email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  setFeedback("ログインしています…");
  try {
    const client = await getSupabaseClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: document.querySelector("#email").value.trim(),
      password: document.querySelector("#password").value,
    });
    if (error) throw error;
    if (!data.session) throw new Error("ログインセッションを確認できません。");
    location.replace(returnToUrl());
  } catch {
    setFeedback("ログインできませんでした。メールアドレスとパスワードを確認してください。", true);
    setBusy(button, false);
  }
});

document.querySelector("#signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!P_KAKEIBO_ENABLE_SIGNUP) {
    setFeedback("新規登録は利用規約・プライバシーポリシーの運営者確認後に有効になります。", true);
    return;
  }
  const form = event.currentTarget;
  const password = document.querySelector("#signup-password").value;
  const confirmPassword = document.querySelector("#signup-confirm");
  confirmPassword.setCustomValidity(password === confirmPassword.value ? "" : "パスワードが一致しません。");
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  setFeedback("アカウントを作成しています…");
  const email = document.querySelector("#signup-email").value.trim();
  try {
    const client = await getSupabaseClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: callbackUrl("verified") },
    });
    if (error) throw error;
    if (data.session?.user) location.replace(returnToUrl());
    else {
      showForm("email-confirmation", "確認メールを送信しました");
      window.pendingConfirmationEmail = email;
    }
  } catch {
    setFeedback("登録できませんでした。入力内容やメール送信設定を確認して、もう一度お試しください。", true);
    setBusy(button, false);
  }
});

document.querySelector("#resend-confirmation").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const email = window.pendingConfirmationEmail;
  if (!email) {
    setFeedback("再送するメールアドレスを確認できません。もう一度アカウント作成をお試しください。", true);
    return;
  }
  setBusy(button, true);
  try {
    const client = await getSupabaseClient();
    const { error } = await client.auth.resend({ type: "signup", email });
    if (error) throw error;
    setFeedback("確認メールを再送しました。メールをご確認ください。");
  } catch {
    setFeedback("再送できませんでした。時間をおいて再試行してください。", true);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  try {
    const client = await getSupabaseClient();
    const { error } = await client.auth.resetPasswordForEmail(
      document.querySelector("#reset-email").value.trim(),
      { redirectTo: callbackUrl("recovery") }
    );
    if (error) throw error;
    setFeedback("該当するアカウントがある場合、再設定メールを送信しました。メールをご確認ください。");
  } catch {
    setFeedback("送信を確認できませんでした。しばらくしてから再試行してください。", true);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#new-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = document.querySelector("#new-password").value;
  const confirmPassword = document.querySelector("#new-password-confirm");
  confirmPassword.setCustomValidity(password === confirmPassword.value ? "" : "パスワードが一致しません。");
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  try {
    const client = await getSupabaseClient();
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    showForm("password-complete", "パスワードを更新しました");
  } catch {
    setFeedback("パスワードを更新できませんでした。再設定リンクが有効か確認してください。", true);
    setBusy(button, false);
  }
});

try {
  const savedTheme = localStorage.getItem("p-kakeibo-theme");
  document.body.dataset.theme = ["purple", "blue", "green", "yellow"].includes(savedTheme) ? savedTheme : "purple";
} catch {
  document.body.dataset.theme = "purple";
}
if (params.has("error") || params.has("error_description")) {
  cleanCallbackUrl();
  setFormNotice("認証を完了できませんでした。キャンセルされた場合は、もう一度お試しください。");
}
start();
