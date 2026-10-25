function validExpenseAmount(value) {
  return /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

const editor = document.querySelector('#expense-editor');
const editForm = document.querySelector('#edit-expense-form');
const editName = document.querySelector('#edit-name');
const editAmount = document.querySelector('#edit-amount');
const editFeedback = document.querySelector('#edit-feedback');
editForm.setAttribute('aria-describedby', editFeedback.id);
let editingExpense = null;
let editorOpener = null;

function openExpenseEditor(expense, opener) {
  editingExpense = expense;
  editorOpener = opener;
  editName.value = expense.name;
  editAmount.value = String(expense.amount);
  editAmount.setCustomValidity('');
  document.querySelector('#edit-date').textContent = `${expense.date.replaceAll('-', '/')} の記録`;
  editFeedback.textContent = '';
  editor.showModal();
}

function persistExpenses(next) {
  if (window.pKakeiboAuth?.user) {
    expenses = next;
    window.dispatchEvent(new CustomEvent('p-kakeibo-data-changed', { detail: { expenses } }));
    return;
  }
  localStorage.setItem(STORAGE, JSON.stringify(next));
  expenses = next;
}

function deleteExpense(expense) {
  if (window.pKakeiboAuth?.user) {
    alert('安全のため、クラウド上の記録の削除は現在無効です。');
    return false;
  }
  if (!confirm('この記録を削除しますか？')) return false;
  persistExpenses(expenses.filter(item => item !== expense));
  return true;
}

document.querySelector('#edit-cancel').addEventListener('click', () => editor.close());
editor.addEventListener('close', () => {
  editingExpense = null;
  if (editorOpener?.isConnected) editorOpener.focus();
  else document.querySelector('.page.active button, .nav-item.active')?.focus();
});
editForm.addEventListener('input', () => {
  editAmount.setCustomValidity('');
  editFeedback.textContent = '';
});
editForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = editName.value.trim() || 'なにか';
  const amount = Number(editAmount.value);
  editAmount.setCustomValidity(validExpenseAmount(editAmount.value) ? '' : '1円以上の整数金額を入力してください。');
  if (!editForm.reportValidity()) return;
  const original = editingExpense;
  if (!original || !expenses.includes(original)) return;
  const updated = {
    ...original,
    name,
    amount
  };
  try {
    persistExpenses(expenses.map(item => item === original ? updated : item));
  } catch {
    editFeedback.textContent = '保存できませんでした。入力を残しています。空き容量やブラウザーの設定を確認してください。';
    return;
  }
  render();
  editor.close();
});
document.querySelector('#edit-delete').addEventListener('click', () => {
  if (!editingExpense) return;
  try {
    if (!deleteExpense(editingExpense)) return;
  } catch {
    editFeedback.textContent = '削除を保存できませんでした。もう一度お試しください。';
    return;
  }
  render();
  editor.close();
});
