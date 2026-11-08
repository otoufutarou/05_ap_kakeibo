const expenseFields = new Set(["id", "name", "amount", "date", "createdAt", "updatedAt", "category"]);

export function inspectExpenses(value) {
  if (!Array.isArray(value)) return { total: 0, valid: 0, issues: [{ field: "expenses" }] };
  const ids = new Set();
  const issues = [];
  value.forEach((expense, index) => {
    const fields = [];
    const [year, month, day] = typeof expense?.date === "string" ? expense.date.split("-").map(Number) : [];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!expense || typeof expense !== "object" || Array.isArray(expense)) fields.push("record");
    if (typeof expense?.id !== "string" || !expense.id) fields.push("id");
    else if (ids.has(expense.id)) fields.push("duplicate_id");
    if (typeof expense?.name !== "string" || !expense.name.trim() || expense.name.trim().length > 100) fields.push("name");
    if (!Number.isSafeInteger(expense?.amount) || expense.amount <= 0) fields.push("amount");
    if (typeof expense?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expense.date)
      || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fields.push("date");
    if (expense?.createdAt !== undefined && expense.createdAt !== null && expense.createdAt !== ""
      && (typeof expense.createdAt !== "string" || !Number.isFinite(Date.parse(expense.createdAt)))) fields.push("createdAt");
    if (typeof expense?.id === "string") ids.add(expense.id);
    if (fields.length) issues.push({ index, field: fields.join(", ") });
  });
  return { total: value.length, valid: value.length - issues.length, issues };
}

export function validateExpenses(value) {
  const report = inspectExpenses(value);
  if (report.issues.length) {
    const error = new Error("形式が不正、またはIDが重複した記録がありました。元の記録は変更していません。");
    error.code = "invalid_expenses";
    error.syncStage = "local_validation";
    error.report = report;
    throw error;
  }
  return value.map((expense) => ({ ...expense }));
}

export function isValidExpected(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) return false;
    ids.add(item.id);
  }
  return true;
}

function syncError(error, syncStage, status = error?.status) {
  const result = new Error(error?.message || "支出の同期に失敗しました。");
  result.name = error?.name || "Error";
  for (const key of ["code", "details", "hint"]) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  if (status !== undefined) result.status = status;
  result.syncStage = syncStage;
  return result;
}

function fromRow(row) {
  return {
    ...row.metadata,
    id: row.source_expense_id,
    name: row.name,
    amount: Number(row.amount),
    date: row.expense_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.category === null ? {} : { category: row.category }),
  };
}

function toRow(expense) {
  const metadata = Object.fromEntries(
    Object.entries(expense).filter(([key]) => !expenseFields.has(key)
      || (key === "category" && typeof expense.category !== "string"))
  );
  return {
    source_expense_id: expense.id,
    name: expense.name.trim(),
    amount: expense.amount,
    category: typeof expense.category === "string" ? expense.category : null,
    expense_date: expense.date,
    created_at: expense.createdAt || new Date().toISOString(),
    metadata,
  };
}

export async function loadAccountData(client) {
  const [{ data: rows, error: expenseError }, { data: settings, error: settingsError }] = await Promise.all([
    client.from("expenses").select("source_expense_id,name,amount,category,expense_date,created_at,updated_at,metadata").order("expense_date", { ascending: false }),
    client.from("user_settings").select("theme,week_start").maybeSingle(),
  ]);
  if (expenseError) throw expenseError;
  if (settingsError) throw settingsError;
  return {
    expenses: (rows || []).map(fromRow),
    settings: settings || { theme: "purple", week_start: 1 },
  };
}

export async function syncAccountExpenses(client, desired, expected) {
  let safeExpenses;
  let args;
  try {
    safeExpenses = validateExpenses(desired);
    if (!isValidExpected(expected)) {
      const error = new Error("競合確認データのID・更新日時が不正です。元の記録は保持し、送信を停止しました。");
      error.code = "invalid_expected";
      throw error;
    }
    args = {
      p_expenses: safeExpenses.map(toRow),
      p_expected: expected.map((expense) => ({
        source_expense_id: expense.id,
        updated_at: expense.updatedAt,
      })),
    };
  } catch (error) {
    throw syncError(error, error.syncStage || "local_validation");
  }
  let result;
  try {
    result = await client.rpc("p_kakeibo_sync_expenses", args);
  } catch (error) {
    throw syncError(error, "rpc_transport");
  }
  if (result.error) throw syncError(result.error, "rpc_response", result.status ?? result.error.status);
  if (!Array.isArray(result.data)) {
    const error = new Error("RPCの成功応答に支出一覧がありません。");
    error.code = "sync_response_invalid";
    throw syncError(error, "response_parse");
  }
  try {
    const saved = result.data.map(fromRow);
    if (!isValidExpected(saved)) {
      const error = new Error("RPCの成功応答に正しいID・更新日時がありません。未保存の記録は保持しています。");
      error.code = "sync_response_invalid";
      throw error;
    }
    return saved;
  } catch (error) {
    throw syncError(error, "response_parse");
  }
}

export async function saveAccountSettings(client, userId, theme) {
  if (!["purple", "blue", "green", "yellow"].includes(theme)) {
    throw new Error("テーマ設定が不正です。");
  }
  const { error } = await client.from("user_settings").upsert(
    { user_id: userId, theme, week_start: 1, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw error;
  const { data, error: verifyError } = await client.from("user_settings")
    .select("theme").eq("user_id", userId).single();
  if (verifyError || data?.theme !== theme) throw verifyError || new Error("設定を確認できませんでした。");
}
