const appShell = document.querySelector('#app');
appShell.dataset.page = 'home';

const homeForm = document.querySelector('#expense-form');
const nameInput = document.querySelector('#expense-name');
const amountInput = document.querySelector('#expense-amount');
const submitButton = homeForm.querySelector('[type="submit"]');
const feedback = document.createElement('p');
feedback.className = 'form-feedback';
feedback.setAttribute('role', 'alert');
feedback.id = 'home-feedback';
homeForm.append(feedback);
homeForm.setAttribute('aria-describedby', feedback.id);

function updateSubmitState() {
  submitButton.disabled = !nameInput.value.trim()
    || !/^[0-9]{1,8}$/.test(amountInput.value)
    || Number(amountInput.value) < 1;
}

homeForm.addEventListener('input', () => {
  feedback.textContent = '';
  updateSubmitState();
});

// プロトタイプの保存キー・登録処理を保ち、保存失敗時だけ状態を戻す。
const originalSubmit = homeForm.onsubmit;
homeForm.onsubmit = event => {
  event.preventDefault();
  if (submitButton.disabled || !homeForm.reportValidity()) return;
  const previousExpenses = expenses.slice();
  submitButton.disabled = true;
  try {
    originalSubmit.call(homeForm, event);
    fitTotals();
  } catch (error) {
    expenses = previousExpenses;
    feedback.textContent = '保存できませんでした。入力を残しています。空き容量やブラウザーの設定を確認してください。';
    console.error('支出の保存に失敗しました。', error);
  } finally {
    updateSubmitState();
  }
};

document.querySelectorAll('[data-go]').forEach(button => {
  button.addEventListener('click', () => {
    appShell.dataset.page = button.dataset.go;
    updateCurrentTab();
    fitTotals();
  });
});

function updateCurrentTab() {
  document.querySelectorAll('.nav-item').forEach(button => {
    if (button.dataset.go === appShell.dataset.page) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

function fitTotals() {
  document.querySelectorAll('#home .total strong').forEach(total => {
    total.style.fontSize = '';
    let size = parseFloat(getComputedStyle(total).fontSize);
    while (total.scrollWidth > total.clientWidth && size > 12) {
      size -= 1;
      total.style.fontSize = `${size}px`;
    }
  });
}

new ResizeObserver(fitTotals).observe(document.querySelector('#home .dashboard'));
updateSubmitState();
updateCurrentTab();
fitTotals();
console.warn('ホーム背景は暫定CSS表示です。白いキャラクターの正式画像、参考モックアップ、利用許諾済みのにくまるフォントが必要です。');
