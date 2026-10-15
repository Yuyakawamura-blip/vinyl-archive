# VINYL ARCHIVE

レコードのジャケット写真、作品情報、コンディション、購入価格、参考相場をまとめて管理するウェブアプリです。スマートフォンやパソコンのブラウザで利用でき、Supabaseにログインすると端末間でコレクションを同期できます。

**アプリを開く：** [VINYL ARCHIVE](https://yuyakawamura-blip.github.io/vinyl-archive/)

## はじめに

1. アプリを開き、同期画面でメールアドレスとパスワードを使ってログインします。初めて使う場合は「新規登録」を選び、確認メールが届いたらメール内のリンクを開いて登録を完了してください。
2. 既存のレコードを登録するには「手入力で保存」を使います。ジャケット写真からまとめて登録する場合は「撮影・一括追加」を開きます。
3. 同じアカウントでログインした端末は、レコードと写真を自動で同期します。オフライン中の変更は端末に保持され、オンラインに戻ると同期を再試行します。

すでにログイン済みで認証画面が表示されない場合は、画面上部の「アカウント」を開き、「ログアウトして切り替える」を選ぶと、ログインまたは新規登録に進めます。

## 写真からまとめて登録する

1. 「撮影・一括追加」を開き、「連続撮影を開始」または「写真をまとめて選択」を選びます。
2. 撮影した写真を確認し、不要な写真を取り除きます。
3. 「まとめてアップロード」を選びます。写真をクラウドへ保存した後、AI解析を自動で開始します。

AIは画像から読み取った文字を手掛かりにGoogle検索で作品情報を照合し、アーティスト、タイトル、年代、ジャンル、カタログ番号、A面・B面の候補と検索出典を記録詳細に表示します。画像や検索から判断できない内容は推測せず、情報を取得できない場合は「AIリソースなし」と表示します。AIの結果は候補として確認してください。

## Supabase設定

このリポジトリでは、コレクションと写真の同期にSupabase Auth、Database、Storage、Edge Functionsを使います。現在のSupabaseプロジェクトには次の設定を反映済みです。

- `public.records` テーブルとユーザーごとのRow Level Securityポリシー
- 非公開の `record-covers` Storageバケットとユーザーごとのアクセス制御
- `analyze-record` Edge Function
- Edge Function Secret `GEMINI_API_KEY`（Google Search Groundingを有効にしたGemini APIプロジェクト）

### プロジェクトを新しく設定する場合

1. Supabaseでプロジェクトを作成します。
2. SQL Editorで [`supabase/schema.sql`](supabase/schema.sql) を実行し、レコードテーブル、RLSポリシー、写真バケットを作成します。
3. `cloud-config.js` のSupabase URLとPublishable Keyを、新しいプロジェクトの値に設定します。Publishable Keyはブラウザで使う公開用キーです。Secret KeyやService Role Keyをこのファイルに入れないでください。
4. SupabaseのAuthenticationでメールとパスワードによるログインを有効にします。確認メールを使う場合は、公開アプリのURLを認証のリダイレクト先に許可します。
5. SupabaseのEdge Functionsから `analyze-record` をデプロイします。ソースは [`supabase/functions/analyze-record/index.ts`](supabase/functions/analyze-record/index.ts) です。
6. Google AI Studioで利用可能なGemini APIキーを用意し、Supabaseの **Edge Functions → Secrets** で名前を `GEMINI_API_KEY` として登録します。キーをGitHubや `cloud-config.js` に保存しないでください。
7. GitHub Pagesで `main` ブランチのルートを公開元に設定し、アプリURLを開いてログインと同期を確認します。

Gemini APIの利用枠や速度制限はGoogle AI Studio側のアカウントとプロジェクトの条件に従います。Google Search GroundingはGemini 3系のFree TierではAPI利用できず、課金対象Tierで月5,000検索リクエストまでは無料、それを超えると1,000リクエストあたり14米ドルです。1回の解析で複数の検索が実行される場合があります。費用と利用状況をGoogle AI Studioで確認してください。解析に失敗したレコードは再試行待ちとして保持し、次回同期時に再試行します。

## iPhoneで使う

SafariまたはChromeでアプリURLを開き、ブラウザの共有メニューからホーム画面に追加すると、アプリのように起動できます。カメラを使う場合はブラウザにカメラへのアクセスを許可してください。アプリ内カメラで撮影した写真は、iPhoneの写真ライブラリには保存されません。

### iPhoneでカメラや選択画面が開かない場合

- iPhoneの「設定」から利用中のブラウザを選び、カメラへのアクセスを許可します。
- アプリ内カメラが利用できない環境では、iPhone標準のカメラに切り替えてください。
- 更新前の画面が残る場合は、アプリを閉じてから開き直してください。

## 主な機能

- レコード情報、ジャケット写真、コンディション、購入価格、参考相場の管理
- 連続撮影と複数写真の一括登録
- Geminiによるジャケット写真の自動解析
- iPhoneとパソコン間の自動クラウド同期
- A面・B面の曲名と音源URLの記録
- Apple Music、Spotify、YouTube、SoundCloudでの曲検索
- アーティストや作品に関連するニュースへのリンク（通常のブラウザ表示）
- 検索、ジャンル絞り込み、並べ替え、グリッド・リスト表示
- 購入価格と参考相場の差額集計
- Yahoo!オークションの落札相場、メルカリの出品相場の検索
- JSONバックアップの書き出し

## データとセキュリティ

ログイン前のデータはブラウザ内のIndexedDBに保存されます。ログイン後は自分のアカウントに紐づくレコードと写真がSupabaseへ同期されます。公開スキーマのテーブルと写真バケットにはRLSポリシーを設定し、各ユーザーが自分のデータだけを扱えるようにしています。ブラウザ用Publishable Keyは公開されてもよいキーですが、アクセス制御はRLSによって行います。

AI解析用のGemini APIキーはSupabase Edge Functionからのみ参照し、ブラウザやGitHubには置きません。

## 関連ファイル

- `cloud-config.js`：ブラウザ用のSupabase URLとPublishable Key
- `cloud-sync.js`：ログイン、自動同期、写真アップロード、AI解析の呼び出し
- `supabase/schema.sql`：テーブル、RLS、Storageの初期スキーマ
- `supabase/functions/analyze-record/index.ts`：Gemini画像解析、Google検索照合、出典保存
- `supabase/migrations/`：スキーマ変更の履歴
