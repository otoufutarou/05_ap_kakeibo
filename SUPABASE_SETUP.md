# Supabase 設定・データ互換性

## 現在の構成と保存データ

- ブランチ：`copilot/implement-auth-cloud-storage`
- フロントエンド：ビルド工程のない HTML/CSS/JavaScript。画面遷移は `index.html` 内の `data-go` による SPA 表示切替で、ログインは独立した `login.html`。
- ローカル支出：`localStorage["p-kakeibo-v1"]` の配列。現在の主なフィールドは `id` (UUID文字列)、`name`、`amount` (円の整数)、`date` (`YYYY-MM-DD`)、`createdAt` (ISO日時)。既存オブジェクトの追加フィールドも残します。
- テーマ：`localStorage["p-kakeibo-theme"]` の `purple` / `blue` / `green` / `yellow`。このアプリにカテゴリー編集画面はありませんが、レガシーの `category` を持つ記録は保持します。
- GitHub Pages の想定公開先：`https://otoufutarou.github.io/05_ap_kakeibo/`。実際のPages設定と公開状態はGitHub側で確認してください。OAuthコールバックにはリポジトリ名を含む実際の `login.html` URLを使います。

### ローカル記録からクラウド列への対応

| ローカル (`p-kakeibo-v1`) | `public.expenses` | 取り扱い |
| --- | --- | --- |
| `id` | `source_expense_id` | ユーザーごとの一意キー。再移行時の二重登録防止に使う |
| `name` | `name` | 支出名 |
| `amount` | `amount` | 正の安全な整数、円 |
| `date` | `expense_date` | `YYYY-MM-DD`。日付だけを保存し、日本時間の日付ずれを避ける |
| `category` | `category` | 文字列カテゴリー。型が異なるレガシー値は `metadata` に保持 |
| `createdAt` | `created_at` | ISO日時 |
| `updatedAt` | `updated_at` | DBで更新し、同時編集時の競合検知に使用 |
| その他のプロパティ | `metadata` | 編集・移行で失われないようJSONとして保持 |
| `p-kakeibo-theme` | `user_settings.theme` | テーマ選択 |

`id` とその他の記録フィールドを含め、元のlocalStorage値を自動削除・上書きしません。移行はログインユーザーごとの明示的な承認後に行います。同じ記録IDがすでにクラウドにあればクラウド側を優先し、移行処理はサーバーのRLS/RPCで実行します。

## Supabaseプロジェクト設定（未実施）

Supabaseの外部プロジェクト作成や本番設定変更は、このリポジトリからは行っていません。管理者が開発/ステージング用プロジェクトを作成し、以下を設定してください。

1. Supabase Dashboardでプロジェクトを作成し、Project URLと**Publishable key**（旧形式の場合は`anon`/`public` JWT）を取得します。
2. `supabase-config.js` の `P_KAKEIBO_SUPABASE_URL` と `P_KAKEIBO_SUPABASE_PUBLISHABLE_KEY` に設定します。これらはブラウザーへ公開される値です。`service_role`、Secret key、DBパスワードを絶対に設定しないでください。クライアントは `sb_publishable_` またはJWTのroleが`anon`のキー以外を拒否します。
3. Supabase CLIで既存テーブルや既存プロジェクトを確認してから、`supabase/migrations/20261023000000_account_data.sql` を開発プロジェクトへ適用します。既存テーブルが同名なら適用を止め、スキーマを先に照合してください。このmigrationは新規テーブルを前提とし、既存データを削除しません。
4. SQL EditorまたはSupabase CLIで `supabase/tests/rls.test.sql` を実行し、pgTAP拡張の有効化後に8件すべて通ることを確認します。A/Bの分離に加え、未認証ユーザーの読み取り拒否を確認します。
5. Authenticationでメール認証を有効にし、メール確認を必須にします。開発時はSupabaseテストメール設定を使い、本番前に運営者が管理するSMTP、送信元、レート制限を設定してください。
6. Authentication > URL ConfigurationのSite URLを実際のPages公開URL（例：`https://otoufutarou.github.io/05_ap_kakeibo/`）に設定し、Redirect URLsに少なくとも `https://otoufutarou.github.io/05_ap_kakeibo/login.html` と開発URL `http://localhost:8000/login.html` を追加します。`/05_ap_kakeibo/` のサブパスを省かないでください。OAuth・確認・再設定はいずれも既存の `login.html` に戻るため、GitHub Pagesで404になりません。
7. Google Cloud ConsoleでOAuthクライアントを作成し、Supabase Dashboardに表示されるOAuth callback URLをGoogleの承認済みリダイレクトURIに登録します。Google providerを有効にし、SupabaseのRedirect URLsには上記Pages URLを設定します。
8. アカウント削除を有効にする場合、Edge Function `delete-account` をデプロイし、サーバー側環境変数 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ALLOWED_ORIGIN` を設定します。`SUPABASE_SERVICE_ROLE_KEY` はEdge Functionの秘密環境変数だけに置き、ブラウザー、Git、Pagesへ出さないでください。`ALLOWED_ORIGIN` は `https://otoufutarou.github.io` のようにOriginだけを指定します。
9. 2つのテストアカウントでメール/Google認証、RLS、追加・編集・削除、競合時の拒否、削除後のCASCADEを実機確認してから本番プロジェクトに適用します。

この静的Pages構成はビルド時環境変数を読み込まないため、ブラウザー設定を `supabase-config.js` に置きます。ここには公開してよいURLとPublishable keyだけを入れてください。管理用キーを追加するための設定場所ではありません。

## 残作業・未検証

- 実際のSupabaseプロジェクト、OAuthプロバイダー、送信メール、許可URL、migration適用、Edge Functionデプロイは管理者による設定・承認が必要です。
- 現在のリポジトリだけからPagesの実稼働状態、実際の公開URL、実機iPhone Safari/X内ブラウザ動作は確認できません。
- 利用規約・プライバシーポリシーは草案で、運営者名、連絡先、提供地域、データ保持/バックアップ期間、委託先/データリージョン、法的根拠などの確認が必要です。草案のまま本番公開完了としないでください。
- アカウント削除はサーバー関数を用意しましたが、設定・デプロイ・実環境テストは未実施です。
- RLS SQLテストはSupabase/PostgreSQL環境での実行が必要です。ローカルにDB/test runnerはありません。
