import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

class Element {
  hidden = false;
  disabled = false;
  textContent = "";
  value = "";
  dataset = {};
  listeners = new Map();
  attributes = new Map();

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    return this.listeners.get(type)?.({
      preventDefault() {},
      currentTarget: this,
      ...event,
    });
  }

  querySelector() {
    return this.submitButton;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  reportValidity() {
    return true;
  }
}

async function createLoginPage(signInWithPassword) {
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const emailForm = getElement("#email-form");
  emailForm.submitButton = getElement("#email-submit");
  emailForm.querySelector = () => emailForm.submitButton;

  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword,
    },
  };
  const source = (await readFile(new URL("../login.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "");
  const location = {
    href: "https://example.test/login.html",
    search: "",
    pathname: "/login.html",
    replace(url) {
      this.replacedWith = url;
    },
  };
  const sandbox = {
    URL,
    URLSearchParams,
    location,
    history: { replaceState() {} },
    navigator: { userAgent: "" },
    document: {
      body: { dataset: {} },
      querySelector: getElement,
      querySelectorAll: () => [],
    },
    window: {},
    localStorage: { getItem: () => null },
    getSupabaseClient: async () => client,
    isSupabaseConfigured: () => true,
    P_KAKEIBO_ENABLE_SIGNUP: false,
  };
  vm.runInNewContext(source, sandbox, { filename: "login.js" });
  await new Promise((resolve) => setImmediate(resolve));
  getElement("#show-email-login").dispatch("click");
  emailForm.hidden = false;
  return { elements, emailForm, location, getElement };
}

test("wrong password can be corrected and retried without reloading", async () => {
  const calls = [];
  const results = [
    { data: { session: null }, error: { code: "invalid_credentials", status: 400 } },
    { data: { session: { user: { id: "test-user" } } }, error: null },
  ];
  const page = await createLoginPage(async (credentials) => {
    calls.push({ email: credentials.email, password: credentials.password });
    return results.shift();
  });
  const email = page.getElement("#email");
  const password = page.getElement("#password");
  const feedback = page.getElement("#auth-feedback");
  email.value = "user@example.test";
  password.value = "wrongpass";

  await page.emailForm.dispatch("submit");
  assert.equal(page.emailForm.submitButton.disabled, false);
  assert.equal(feedback.dataset.error, "true");

  password.value = "correctpass";
  await page.emailForm.dispatch("submit");
  assert.deepEqual(calls, [
    { email: "user@example.test", password: "wrongpass" },
    { email: "user@example.test", password: "correctpass" },
  ]);
  assert.equal(feedback.dataset.error, "false");
  assert.equal(page.location.replacedWith, "/index.html");
});

test("duplicate submits do not race and rate-limit codes are handled", async () => {
  let rejectFirst;
  const calls = [];
  const page = await createLoginPage((credentials) => {
    calls.push({ email: credentials.email, password: credentials.password });
    if (calls.length > 1) {
      return Promise.resolve({
        data: { session: { user: { id: "test-user" } } },
        error: null,
      });
    }
    return new Promise((resolve) => {
      rejectFirst = resolve;
    });
  });
  page.getElement("#email").value = "user@example.test";
  page.getElement("#password").value = "wrongpass";

  const firstAttempt = page.emailForm.dispatch("submit");
  page.getElement("#password").value = "correctpass";
  await page.emailForm.dispatch("submit");
  assert.equal(calls.length, 1);

  rejectFirst({ data: { session: null }, error: { code: "over_request_rate_limit", status: 429 } });
  await firstAttempt;
  assert.equal(page.getElement("#auth-feedback").textContent,
    "ログイン試行が多すぎます。しばらく待ってから再試行してください。");
  assert.equal(page.emailForm.submitButton.disabled, false);

  await page.emailForm.dispatch("submit");
  assert.deepEqual(calls, [
    { email: "user@example.test", password: "wrongpass" },
    { email: "user@example.test", password: "correctpass" },
  ]);
  assert.equal(page.location.replacedWith, "/index.html");
});
