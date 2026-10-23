const expenseFields = new Set(["id", "name", "amount", "date", "createdAt", "updatedAt", "category"]);

export function validateExpenses(value) {
  if (!Array.isArray(value)) throw new Error("ローカルの記録形式を確認できません。");
  const ids = new Set();
  return value.map((expense) => {
    const [year, month, day] = typeof expense?.date === "string" ? expense.date.split("-").map(Number) : [];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!expense || typeof expense !== "object"
      || typeof expense.id !== "string" || !expense.id || ids.has(expense.id)
      || typeof expense.name !== "string" || !expense.name.trim() || expense.name.trim().length > 100
      || !Number.isSafeInteger(expense.amount) || expense.amount <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(expense.date)
      || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error("形式が不正、またはIDが重複した記録がありました。元の記録は変更していません。");
    }
    ids.add(expense.id);
    return { ...expense, name: expense.name.trim() };
  });
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
  const safeExpenses = validateExpenses(desired);
  const { data, error } = await client.rpc("p_kakeibo_sync_expenses", {
    p_expenses: safeExpenses.map(toRow),
    p_expected: expected.map((expense) => ({
      source_expense_id: expense.id,
      updated_at: expense.updatedAt,
    })),
  });
  if (error) throw error;
  return (data || []).map(fromRow);
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
