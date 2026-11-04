export function collectBackup(storage) {
  const entries = [];
  const keys = new Set(["p-kakeibo-v1", "p-kakeibo-theme"]);
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (/^p-kakeibo-(cloud-pending|theme-pending|pending-original):/.test(key)) keys.add(key);
  }
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw !== null) entries.push({ key, raw });
  }
  return { format: "p-kakeibo-raw-backup", version: 1, entries };
}

export function downloadBackup(storage = localStorage) {
  const backup = collectBackup(storage);
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `p-kakeibo-backup-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-backup]").forEach((button) => {
    button.addEventListener("click", () => {
      const feedback = document.querySelector("#backup-feedback");
      try {
        downloadBackup();
        feedback.textContent = "JSONのダウンロードを開始しました。ファイルが保存されたことを確認してください。元データは変更していません。";
      } catch {
        feedback.textContent = "バックアップを作成できません。保存領域へのアクセス許可とダウンロード設定を確認してください。元データは変更していません。";
      }
    });
  });
}
