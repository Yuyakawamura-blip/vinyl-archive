# VINYL ARCHIVE

レコードのジャケット写真、作品情報、追加日、市場価格をまとめて管理するウェブアプリです。スマートフォンやパソコンのブラウザで利用でき、Supabaseにログインすると端末間でコレクションを同期できます。

**アプリを開く：** [VINYL ARCHIVE](https://yuyakawamura-blip.github.io/vinyl-archive/)

## はじめに

1. ログインしなくても、開いてすぐ使えます。その場合、レコードはその端末だけに保存されます。端末間で同期する場合は、画面右上の「ログインして同期」からメールアドレスとパスワードでログインします。個人用のアプリのため、新規登録は受け付けていません（SupabaseのAuthで新規登録を無効にしています）。
2. 既存のレコードを登録するには「手入力で保存」を使います。ジャケット写真からまとめて登録する場合は「撮影・一括追加」を開きます。
3. 同じアカウントでログインした端末は、レコードと写真を自動で同期します。オフライン中の変更は端末に保持され、オンラインに戻ると同期を再試行します。

ログイン中のアカウントは、画面上部の「アカウント」から確認・ログアウトできます。

## 写真からまとめて登録する

1. 「撮影・一括追加」を開き、「連続撮影を開始」または「写真をまとめて選択」を選びます。
2. 撮影した写真を確認し、不要な写真を取り除きます。
3. 「まとめてアップロード」を選びます。写真をクラウドへ保存した後、AI解析を自動で開始します。

AIは画像の文字を読み取り、Google検索で同じリリースの曲目・B面を照合します。市場価格は、同じ盤の落札履歴や販売ページを2件以上確認できた場合に「相場」として記録します。根拠が足りない場合は、同じアーティストの同時期・同フォーマットの中古相場などからAIが概算し、「≈¥3,000」のように相場と区別して表示します。コレクション合計には概算も含め、そのうち概算がいくらかを併記します。手入力した価格や確認済みの相場は、AIの再調査で概算に置き換わりません。盤面の傷・反り・ノイズ、ジャケット裏面、付属品の完備状況、マトリクス／ランアウト刻印、プロモ盤や特殊個体かどうかは判定対象にしません。B面の曲名は盤に一致する情報が確認できた場合にのみ補います。追加日は自動記録され、詳細画面と一覧に表示されます。購入価格、カタログ番号、コンディションはアプリ画面に表示しません。既存レコードは詳細画面の「AIで市場価格・曲目を再調査」から更新できます。AIの読み取り結果は詳細画面の「編集」から手で直せます。AIの結果は参考情報として確認してください。

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
7. AI解析はサーバー側の順番待ちで実行します。ランダムな文字列を1つ用意し、Edge Function Secret `ANALYZE_WORKER_SECRET` として登録します。SQL Editorで次を実行し、Vaultに関数のURLと同じ文字列を保存します。

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/analyze-record', 'analyze_worker_url');
   select vault.create_secret('<ANALYZE_WORKER_SECRETと同じ文字列>', 'analyze_worker_secret');
   ```

   `analyze-record` は `supabase/config.toml` の設定によりゲートウェイのJWT確認を行わず、関数内でユーザーのログインまたは上記の文字列を確認します。
8. GitHub Pagesで `main` ブランチのルートを公開元に設定し、アプリURLを開いてログインと同期を確認します。

Gemini APIの利用枠や速度制限はGoogle AI Studio側のアカウントとプロジェクトの条件に従います。Google Search GroundingはGemini 3系のFree TierではAPI利用できず、課金対象Tierで月5,000検索リクエストまでは無料、それを超えると1,000リクエストあたり14米ドルです。1回の解析で複数の検索が実行される場合があります。また、URL Contextで取得した商品ページの内容はGeminiの入力トークンとして計上されます。費用と利用状況をGoogle AI Studioで確認してください。AI解析はサーバー側で実行されるため、写真のアップロード後にアプリを閉じても続きます。pg_cronが1分ごとに解析待ちのレコードを処理し、失敗したものは10分以上あけて最大3回まで自動で再試行します。

## iPhoneで使う

SafariまたはChromeでアプリURLを開き、ブラウザの共有メニューからホーム画面に追加すると、アプリのように起動できます。カメラを使う場合はブラウザにカメラへのアクセスを許可してください。アプリ内カメラで撮影した写真は、iPhoneの写真ライブラリには保存されません。

### iPhoneでカメラや選択画面が開かない場合

- iPhoneの「設定」から利用中のブラウザを選び、カメラへのアクセスを許可します。
- アプリ内カメラが利用できない環境では、iPhone標準のカメラに切り替えてください。
- 更新前の画面が残る場合は、アプリを閉じてから開き直してください。

## 主な機能

- レコード情報、ジャケット写真、追加日、市場価格の管理
- 連続撮影と複数写真の一括登録
- Geminiによるジャケット写真・B面曲目・商品詳細ページまで確認する市場価格調査
- iPhoneとパソコン間の自動クラウド同期
- A面・B面の曲名と音源URLの記録
- Apple Music、Spotify、YouTube、SoundCloudでの曲検索
- アーティストや作品に関連するニュースへのリンク（通常のブラウザ表示）
- 検索、ジャンル絞り込み、並べ替え、グリッド・リスト表示
- ウェブ検索に基づく市場価格と調査出典の表示
- JSONバックアップの書き出し

## データとセキュリティ

ログイン前のデータはブラウザ内のIndexedDBに保存されます。ログイン後は自分のアカウントに紐づくレコードと写真がSupabaseへ同期されます。公開スキーマのテーブルと写真バケットにはRLSポリシーを設定し、各ユーザーが自分のデータだけを扱えるようにしています。ブラウザ用Publishable Keyは公開されてもよいキーですが、アクセス制御はRLSによって行います。

AI解析用のGemini APIキーはSupabase Edge Functionからのみ参照し、ブラウザやGitHubには置きません。

## 関連ファイル

- `cloud-config.js`：ブラウザ用のSupabase URLとPublishable Key
- `cloud-sync.js`：ログイン、自動同期、写真アップロード、AI解析の呼び出し
- `supabase/schema.sql`：テーブル、RLS、Storageの初期スキーマ
- `supabase/functions/analyze-record/index.ts`：Gemini画像解析、Google検索照合、出典保存
- `supabase/config.toml`：Edge Functionの設定（`analyze-record` のJWT確認を関数内で行う）
- `supabase/migrations/`：スキーマ変更の履歴
