# Supabase 設定・データ互換性

## 現在の構成と保存データ

- 基準ブランチ：`main`
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

### 未保存変更の復旧

- ログイン中の支出変更はユーザー別の `p-kakeibo-cloud-pending:<user-id>` に先に退避し、保存失敗時は通信復旧時・画面再表示時に自動再試行します。再試行間隔は最大5分まで延長し、手動の再試行も利用できます。
- 競合が検出された変更は自動で上書きせず、利用者の確認が必要です。保存エラーにはSupabaseのエラーコードとメッセージを表示します。
- 退避データを読み取れない場合は、元のlocalStorage値を消去・上書きせず同期を停止します。ブラウザーの保存容量不足で退避できない場合もクラウド保存を試みますが、通信にも失敗すると画面を閉じた際に変更を失うおそれがあるため、警告を表示します。
- アカウント切替前に開始した保存応答は、切替後の画面状態を更新しません。ユーザー別の退避データは各ユーザーのキーに残ります。
- 同期・復旧・バックアップの回帰テストは `node --test tests/*.test.mjs` で実行します。

### 起動できない場合のバックアップと復旧

1. **ブラウザデータを消去しないでください。** 同じブラウザ・同じ公開元の `recovery.html` を開くと、認証やSupabaseへの接続なしに「元データをバックアップする」を利用できます。通常画面の起動エラーにも同じ操作があります。別ブラウザ・別ドメインでは元のlocalStorageを参照できません。
2. ダウンロードされたJSONが保存されていることを確認してください。`entries` の各 `{ key, raw }` に、`p-kakeibo-v1`、`p-kakeibo-theme`、各アカウントの支出・テーマの未保存キュー、復旧時の原本コピーが入ります。`raw` はJSONとして壊れた値も含め、保存文字列を加工せず保持します。バックアップ操作はlocalStorageに書き込まず、クラウド送信・コンソール出力もしません。認証用キーやパスワード用キーは収集しませんが、支出や独自フィールドの内容は個人情報として安全に保管してください。
3. エラー画面の「復旧できない理由と安全な手順」で原因を確認してください。JSON破損、構造、支出の検証失敗（件数・位置・項目名のみ）、競合情報、保存世代、未対応バージョン、アカウント不一致、保存領域へのアクセス失敗、容量不足を区別します。恒常的な形式エラーは再読み込みだけでは直りません。
4. 正常なキューは、原文を `p-kakeibo-pending-original:<user-id>`（異なる原文はUUID接尾辞）へコピーし、読み戻して確認してから全件を復元・自動同期します。原本コピーを確保できない場合は停止します。元キューは保存結果に全件のID・名前・金額・日付があることを確認するまで消去しません。原本コピーは同期後も自動削除しません。
5. 旧形式で `generation` がない、または `expected` が欠落/nullの場合は、まずJSONを保存し、「バックアップ保存済み：旧形式を安全に復元する」を選び、確認に同意してください。原本コピーと検証が成功してから復元します。`generation` は0、欠落した `expected` は空配列として扱います。最新クラウド日時で補完せず、異なる既存行の上書きは既存RPCの競合保護で拒否します。不正な `expected` の一部を削除したり、更新日時を推測したりはしません。
6. 一部の記録が不正な場合も、通過した記録だけを自動送信しません。バックアップ・再確認・読み取り専用クラウド確認を選択できます。修復はバックアップのコピー上で行い、全件検証・ID重複・件数・対象アカウントを照合してください。任意の修復JSONを取り込む機能は未実装です。原本の直接編集や手動削除は復旧手順に含めません。
7. 「このアカウントのクラウド記録を読み取り専用で確認」はセッションを取得前後に照合し、別アカウントや切替前の応答を表示しません。通常画面のローカル記録を置換せず、同期・移行・削除もしません。通信できなければ理由を表示します。PostgRESTの返却上限があるため、表示件数がサーバー上の全件数とは限りません。

正常時は端末保存→RPC送信→保存結果の確認→同期済み表示の順序を維持します。通信失敗は最大5分のバックオフ、online、画面再表示で再試行します。競合・権限・形式・保存結果の不一致は自動再試行を停止し、原因確認後の手動再試行を待ちます。同一IDの再送は既存RPCにより重複登録されません。バックアップのダウンロード開始だけではファイル保存完了を検知できないため、旧形式復元の前には利用者自身の保存確認が必要です。

### 起動不能の調査結果（2026-11-04）

- 直前変更 `0ad983e` では、従来 `null` を返していた読み込み失敗を `{ state: "invalid" }` に変更し、`activateUser()` / `retrySave()` がアプリを隠して同期を停止するようになりました。元データ保護は必要ですが、原因別の情報や復旧操作がなく、同じ原本を再検証して同じ画面に戻る状態でした。
- 端末の実データは参照していないため、今回の直接原因がJSON破損・支出検証・expected検証・保存領域へのアクセス失敗のどれかは**未特定**です。`expected` 要素の文字列ID・updatedAt検査が追加されたことは確認しています。欠落した更新日時を含むキューはこの新しい検査で拒否されますが、正規の過去の書き込みが必ずその値を作るという証拠はありません。
- 履歴 `943d83b` は `{ generation, expenses, expected: [] }`、`f4f6bb2` / `ea6a975` は同じ構造にベースラインの `{ id, updatedAt }` を保存しています。`readPending()` は以前から欠落/nullのexpectedも受理していました。配列そのものをキューとして保存していた履歴は確認できませんでした。`tests/fixtures/pending-history.json` はこれら2世代の実際のwriter構造を再現した架空の記録で、利用者の実データではありません。
- `validateExpenses()` の基本条件は直前変更では変わっていません。UUID以外の非空文字列ID、「なにか」、createdAt/updatedAtのない記録、旧category・追加フィールドは対応済みです。文字列金額、無効日付、重複IDは自動変換・削除せず拒否します。今回、存在するが不正なcreatedAtはRPC送信前に診断するようにしました。
- 付随して、表示側の同日ソートが `createdAt.localeCompare()` を直接呼び、createdAtのない旧記録で例外になる経路も修正しました。起動時のテーマ読み取り失敗でも認証・復旧画面まで進めるようにし、初期表示によるテーマキーへの書き戻しをなくしています。
- Nodeの回帰テスト34件、JavaScript構文検査、差分検査が成功しています。実ブラウザでも、Supabaseクライアントをローカルのテスト用モックに置き換え、JSONダウンロードが保存領域を変更しないこと、破損時の原文保持、2件の復元・自動同期・ホーム表示、expected不正時の再確認と送信停止を確認しました。重複防止・競合テストのサーバー部分もモックであり、実Supabaseでの再検証は必要です。
- 本番へのSQL適用・設定変更・実データの読み書きは実施していません。承認後、実端末でJSONバックアップを確保し、原因コードを確認したうえで、開発Supabaseで自動再送、重複防止、競合、RLSによるA/B分離、再読み込み後の復旧を確認してください。本番の未保存データの送信・移行・上書きは別途明示的な承認が必要です。

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

### 実環境でクラウド保存に失敗した場合

このリポジトリだけでは、Supabase Dashboard上で現在適用されているSQL、実アカウントの認証状態、HTTP応答を確認できません。まず設定画面の保存エラーに表示される段階・HTTP status・Supabase/PostgreSQL code・message/details/hintを記録してください。`RPC通信（送信・応答受信の結果は不明）`はブラウザーが応答を得られなかった状態で、サーバー側の保存成否は断定できません。同一IDでの再試行はRPCが重複登録を防ぎます。支出内容、認証情報、トークン、鍵をConsoleやチケットへ貼り付けないでください。

Supabase SQL Editorで次の読み取り専用SQLを実行し、RPCの定義・所有者・実行権限、RLSポリシー、適用済みmigrationをリポジトリのmigrationと照合してください。既存データや権限は変更しません。

```sql
select
  p.oid::regprocedure as function_signature,
  owner.rolname as function_owner,
  p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_roles owner on owner.oid = p.proowner
where p.oid = 'public.p_kakeibo_sync_expenses(jsonb,jsonb)'::regprocedure;

select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('expenses', 'user_settings')
order by tablename, policyname;

select
  has_table_privilege('authenticated', 'public.expenses', 'select') as expenses_select,
  has_table_privilege('authenticated', 'public.expenses', 'insert') as expenses_insert,
  has_table_privilege('authenticated', 'public.expenses', 'update') as expenses_update,
  has_table_privilege('authenticated', 'public.expenses', 'delete') as expenses_delete;

select version, name
from supabase_migrations.schema_migrations
where version = '20261023000000';
```

期待値はRPC署名が`(jsonb, jsonb)`、所有者が`postgres`、`security_definer`がtrue、`search_path`が空、authenticatedのみ実行可で、expensesの直接書き込み権限はなく、RLSポリシーが所有者に限定されていることです。migration台帳の1行は適用記録であり、実際の関数定義・権限が正しい証明ではありません。SQL結果に差異があれば、承認なしに修復SQLを実行せず、まず開発プロジェクトでmigrationとRLS/RPCテストを照合してください。

実ブラウザーの保存確認は、開発プロジェクトと専用テストアカウント、新規プロフィールで行います。設定画面でエラーがないことだけでなく、支出登録後の成功表示、同じユーザーで再読み込み後の取得、別ブラウザーからの取得を確認してください。アプリが読み取り専用の復旧表示を開いた場合、未保存データは原本を保持したまま書き込みを停止しています。原因を確認するまで破棄・上書き・手動SQLによるデータ変更を行わないでください。
