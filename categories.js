const CATEGORIES = [
  { id: 'food', label: '食費' },
  { id: 'shopping', label: '買い物' },
  { id: 'daily', label: '日用品' },
  { id: 'transport', label: '交通費' },
  { id: 'entertainment', label: '娯楽' },
  { id: 'other', label: 'なにか' }
];

function categoryFor(value) {
  return CATEGORIES.find(category => category.id === value) || CATEGORIES[5];
}

function categoryIcon(value) {
  const category = categoryFor(value);
  const icon = document.createElement('span');
  icon.className = 'category-icon';
  icon.dataset.category = category.id;
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', category.label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./public/assets/categories.svg#${category.id}`);
  svg.append(use);
  icon.append(svg);
  return icon;
}

function createCategoryPicker(element) {
  let selected = null;
  const buttons = CATEGORIES.map(category => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-choice';
    button.dataset.category = category.id;
    const icon = categoryIcon(category.id);
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = category.label;
    button.append(icon, label);
    button.addEventListener('click', () => set(selected === category.id ? null : category.id));
    element.querySelector('.category-options').append(button);
    return button;
  });
  function set(value) {
    selected = value === null ? null : categoryFor(value).id;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === selected)));
  }
  set(null);
  return { set, value: () => selected || 'other' };
}

const entryCategories = createCategoryPicker(document.querySelector('#entry-categories'));
const editCategories = createCategoryPicker(document.querySelector('#edit-categories'));
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
  editCategories.set(categoryFor(expense.category).id);
  editFeedback.textContent = '';
  editor.showModal();
}

function persistExpenses(next) {
  localStorage.setItem(STORAGE, JSON.stringify(next));
  expenses = next;
}

function deleteExpense(expense) {
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
  const name = editName.value.trim();
  const amount = Number(editAmount.value);
  editAmount.setCustomValidity(Number.isFinite(amount) && amount > 0 ? '' : '1円以上の金額を入力してください。');
  if (!name || !editForm.reportValidity()) return;
  const original = editingExpense;
  if (!original || !expenses.includes(original)) return;
  const updated = {
    ...original,
    name: editName.value === original.name ? original.name : name,
    amount: editAmount.value === String(original.amount) ? original.amount : Math.max(1, Math.round(amount)),
    category: editCategories.value()
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
