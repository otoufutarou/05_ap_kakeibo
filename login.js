(() => {
  const themes = ['purple', 'blue', 'green', 'yellow'];
  const selector = document.querySelector('#preview-theme');
  let savedTheme = 'purple';
  try {
    const value = localStorage.getItem('p-kakeibo-theme');
    if (themes.includes(value)) savedTheme = value;
  } catch {
    // 保存を制限するブラウザでもプレビューを表示する。
  }
  document.body.dataset.theme = savedTheme;
  selector.value = savedTheme;
  selector.addEventListener('change', () => {
    if (themes.includes(selector.value)) document.body.dataset.theme = selector.value;
  });

  const messages = {
    google: 'Googleログインはデザイン承認後に接続します。今はログインされません。',
    email: 'メールログイン画面はデザイン承認後に実装します。今はメールやパスワードを入力する必要はありません。',
    signup: '新規登録はデザイン承認後に実装します。今はアカウントは作成されません。',
    terms: '正式な利用規約は運営者への確認待ちです。このプレビューでは同意を取得しません。',
    privacy: '正式なプライバシーポリシーは運営者への確認待ちです。このプレビューでは個人情報を送信しません。'
  };
  document.querySelectorAll('[data-preview]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelector('#preview-feedback').textContent = messages[button.dataset.preview];
      document.querySelector('.preview-dialog').showModal();
    });
  });
})();
