function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validExpenseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function todayDate() {
  return new Date(`${todayKey()}T12:00:00`);
}

function dateKey(date) {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function weekStart(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return start;
}

function formatExpenseDate(value) {
  if (!validExpenseDate(value)) return '日付を選択してください';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  }).format(new Date(`${value}T00:00:00Z`)).replace('(', '（').replace(')', '）');
}

function setDateInput(input, value) {
  input.value = value;
  input.setCustomValidity('');
  input.parentElement.querySelector('.date-display').textContent = formatExpenseDate(input.value);
}

document.querySelectorAll('.date-input').forEach(input => {
  input.addEventListener('input', () => setDateInput(input, input.value));
  input.addEventListener('change', () => setDateInput(input, input.value));
});
setDateInput(document.querySelector('#expense-date'), todayKey());
