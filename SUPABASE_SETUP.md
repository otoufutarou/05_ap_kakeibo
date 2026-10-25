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
3. **管理者の承認までは適用しないでください。** 承認後、Supabase CLIで既存テーブルや既存プロジェクトを確認してから、`supabase/migrations/20261023000000_account_data.sql` を開発プロジェクトへ適用します。既存テーブルが同名なら適用を止め、スキーマを先に照合してください。このmigrationは新規テーブルを前提とし、既存データを削除しません。
4. SQL EditorまたはSupabase CLIで `supabase/tests/rls.test.sql`（11件）と `supabase/tests/sync.test.sql`（23件）を実行し、pgTAP拡張の有効化後に34件すべて通ることを確認します。A/Bの分離、未認証ユーザーの拒否、競合・非削除・移行の基本動作を確認します。テストは専用の開発環境で実行してください。
5. Authenticationでメール認証を有効にし、メール確認を必須にします。開発時はSupabaseテストメール設定を使い、本番前に運営者が管理するSMTP、送信元、レート制限を設定してください。
6. Authentication > URL ConfigurationのSite URLを実際のPages公開URL（例：`https://otoufutarou.github.io/05_ap_kakeibo/`）に設定し、Redirect URLsに `https://otoufutarou.github.io/05_ap_kakeibo/login.html?callback=**` と開発URL `http://localhost:8000/login.html?callback=**` を追加します。`/05_ap_kakeibo/` のサブパスを省かないでください。OAuth・確認・再設定はいずれも既存の `login.html` に戻るため、GitHub Pagesで404になりません。
7. Google Cloud ConsoleでOAuthクライアントを作成し、Supabase Dashboardに表示されるOAuth callback URLをGoogleの承認済みリダイレクトURIに登録します。Google providerを有効にし、SupabaseのRedirect URLsには上記Pages URLを設定します。
8. アカウント削除を有効にする場合、Edge Function `delete-account` をデプロイし、サーバー側環境変数 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ALLOWED_ORIGIN` を設定します。`SUPABASE_SERVICE_ROLE_KEY` はEdge Functionの秘密環境変数だけに置き、ブラウザー、Git、Pagesへ出さないでください。`ALLOWED_ORIGIN` は `https://otoufutarou.github.io` のようにOriginだけを指定します。
9. 2つのテストアカウントでメール/Google認証、RLS、追加・編集、クラウド記録削除の拒否、競合時の拒否を実機確認してから本番プロジェクトに適用します。既存のアカウント削除機能とCASCADEの検証は、別途承認した使い捨てアカウントだけで行ってください。

この静的Pages構成はビルド時環境変数を読み込まないため、ブラウザー設定を `supabase-config.js` に置きます。ここには公開してよいURLとPublishable keyだけを入れてください。管理用キーを追加するための設定場所ではありません。

`P_KAKEIBO_ENABLE_SIGNUP` は規約・ポリシー草案が運営者に承認されるまで `false` のままにしてください。本番Supabase側でも新規サインアップを無効にし、Google OAuth経由の新規ユーザー作成も同様に止めてください。正式文書の確定と必要な法務確認後にのみ、メール登録フラグとSupabase側のサインアップ設定を有効化します。`supabase/config.toml` のローカル開発サインアップ設定はテスト用で、本番設定の根拠にはしないでください。

## 適用前レビュー（2026-10-25）

### 見つかった問題と修正

- 旧RPCは、`p_expected` にあり `p_expenses` にない記録を削除していました。全件スナップショットの欠落を削除意思とみなす設計を廃止し、RPCを追加・更新専用にしました。SQL NULLも配列検査をすり抜けないよう拒否します。
- 既存行のロックだけでは、同じIDを同時に初回登録する処理を保護できませんでした。認証ユーザー単位のトランザクションロックを追加し、検査から書き込みまでを直列化します。同じ内容の再送は重複登録せず、異なる内容の同時編集は `40001 / sync_conflict` で拒否します。
- `now()` はトランザクション内で一定なので、更新しても競合判定用の時刻が変わらない場合がありました。更新トリガーは実時刻と前回値＋1マイクロ秒の大きい方を使用します。クライアントはこの値を文字列のまま返し、JavaScriptのDateで丸めません。
- 支出テーブルへの直接書き込みは競合検査を迂回できるため、`authenticated` はSELECTのみとし、追加・更新はRPCに限定しました。RPCは `SECURITY DEFINER` ですが、空の `search_path`、NULLでない `auth.uid()`、すべてのデータ操作での明示的な所有者条件を使用します。実行権限は `authenticated` のみです。関数所有者 `postgres` は信頼された管理者として扱います。
- 両テーブルのRLSを維持し、設定テーブルは本人のSELECT/INSERT/UPDATEのみを許可します。DELETE権限は与えません。クラウド記録の削除UIも拒否し、削除できたように見せないようにしました。ゲストのローカル削除動作は変更していません。
- 移行確定時はlocalStorageの生の配列全体を検証します。表示用フィルターで不正レコードを除いてから移行し、一部だけ成功したように扱うことを防ぎます。元の `p-kakeibo-v1` と `p-kakeibo-theme` は変更・削除しません。同じIDが既にある場合は既存クラウド記録を優先し、カテゴリー・追加メタデータを保持します。
- migration全体をトランザクション化しました。テーブル行のDELETE/TRUNCATEやデータ初期化は追加していません。既存の `auth.users` 削除時のCASCADEとアカウント削除機能は残っていますが、migration適用で実行される処理ではありません。

### 実行した検証と限界

- 外部接続のないローカルPostgreSQL 16で新規適用に成功しました。Supabase相当の最小限の `auth.users` / `auth.uid()` / `anon` / `authenticated` をテスト用に用意し、pgTAP 34件が成功しました。データがある状態でのSQL再適用でも3件のテスト記録が残りました。
- PostgreSQLの2接続を使い、同じID・同じ内容の同時登録が両方成功して1件だけ残ること、異なるIDの同時登録が両方残ること、同じ旧バージョンからの同時編集は片方だけ成功することを確認しました。
- JavaScriptの構文検査とセキュリティレビューを実施しました。本番Supabaseの設定・ロール・Authの実装を完全に再現した試験ではなく、実プロジェクトへの接続・SQL適用・設定変更はしていません。
- テーマ設定は従来どおり後勝ちです。支出の競合検知とは別で、同時変更したテーマの競合通知はありません。
- PostgRESTの返却上限と大量データは別途確認が必要です。現在のフロントエンドは一覧のページングに未対応で、返却上限を超える記録の全件表示・移行確認を保証しません。移行前にlocalStorageのJSON全体をバックアップし、上限超過や不正形式、重複IDがあれば適用・移行を止めてください。移行失敗時も元データは残ります。

## 残作業・未検証

- 実際のSupabaseプロジェクト、OAuthプロバイダー、送信メール、許可URL、migration適用、Edge Functionデプロイは管理者による設定・承認が必要です。
- 現在のリポジトリだけからPagesの実稼働状態、実際の公開URL、実機iPhone Safari/X内ブラウザ動作は確認できません。
- 利用規約・プライバシーポリシーは草案で、運営者名、連絡先、提供地域、データ保持/バックアップ期間、委託先/データリージョン、法的根拠などの確認が必要です。草案のまま本番公開完了としないでください。
- アカウント削除はサーバー関数を用意しましたが、設定・デプロイ・実環境テストは未実施です。
- RLS・同期SQLテストはローカルPostgreSQLで実行済みです。管理者の承認後に、実際のSupabase開発環境でも再検証してください。
