# 2026-10-29 利用者間のデータ分離とCSP（工程09、要件R5）

[企画メモ](../concept.md)の要件R5（一般公開前のセキュリティの残り）の記録。[10/28の静的レビュー](2026-10-28-security-static-review.md)で未確認・未修正だった項目を扱う。**実装者と同じ担当（Claude Code）による確認で、独立レビューではない。**

## 1. 利用者間のデータ分離（本番DB）

- 環境：本番Supabase（opsyfbhzhpeacdalmsju）。検証用アカウントは作らず、DBの中で役割を切り替えた（`set local role authenticated` と `request.jwt.claims` に存在しない利用者BのIDを設定、または `anon`）。
- 実行はすべて `begin; … rollback;` の中で行い、本番のデータは変えていない。実行後、利用者Aのレコード数（136件）が変わっていないことを同じトランザクション内で確認した。
- 対象：利用者A＝作り手のアカウント（レコード136件、写真132件）。

| 操作 | 期待 | 実測 |
|---|---|---|
| BがAのレコードを読む | 0件 | 0件 |
| BがAのレコードを更新する | 0件 | 0件 |
| BがAのレコードの所有者を自分に付け替える | 0件 | 0件 |
| BがAのレコードを削除する | 0件 | 0件 |
| BがAのIDでレコードを作る | 拒否 | 拒否（42501） |
| BがAの写真フォルダを読む | 0件 | 0件 |
| BがAの写真フォルダにファイルを作る | 拒否 | 拒否（42501） |
| BがAのAI利用量を読む | 0件 | 0件 |
| Bの `my_ai_quota` | B自身の分だけ | read:0, research:0 |
| Bが `consume_ai_quota` / `claim_ai_jobs` を呼ぶ | 拒否 | 拒否（42501） |
| 未ログインでレコードを読む | 拒否 | 拒否（42501） |
| 未ログインで写真の一覧を読む | 0件 | 0件 |
| 未ログインでAI利用量を読む | 拒否 | 拒否（42501） |

あわせて確認したこと：

- 写真のバケット `record-covers` は非公開（`public = false`）。公開URL形式でのアクセスは400。
- `analyze-record` は、認証なし・不正なトークン・偽のワーカー秘密のいずれも401を返す。
- RLSポリシーは、`records` の4操作、`storage.objects` の4操作、`ai_usage` の読み取りが、すべて `auth.uid()` と所有者（`user_id` または写真フォルダ名）の一致を条件にしている。
- SQLから写真の行を直接削除することは、Supabase側のトリガーで禁止されている（Storage API経由のみ）。

**確認していないこと**：実際の2つのアカウントでアプリから操作した場合（Realtimeの購読、Storage APIでの削除、署名付きURLの発行を含む）。上の結果は、同じRLSポリシーをDB内で評価したもの。

## 2. Content-Security-Policy

`index.html` と `privacy.html` に `<meta http-equiv="Content-Security-Policy">` を追加した。許可した読み込み先は、自サイト、Supabase（`https` と Realtime の `wss`）、jsDelivr（Supabaseのライブラリ）、Google Fonts だけ。`object-src 'none'`、`base-uri 'self'`、`form-action 'self'` も指定した。GitHub Pages ではレスポンスヘッダーを設定できないため、`frame-ancestors`（他サイトへの埋め込み防止）は設定できない。

あわせて：

- jsDelivr から読み込む `supabase-js@2.117.3` に SRI（`integrity` の sha384）を付けた。
- 画像の `src` 属性に入れる値も `esc()` でエスケープするようにした（3か所）。

| 項目 | 内容 |
|---|---|
| 環境 | ローカル（`python3 -m http.server`）、ヘッドレスChrome、未ログイン、検証用レコード8件 |
| 手順 | 一覧、リスト表示、詳細、追加ダイアログ、登録フォームの送信（本番Authへの通信）、データの扱いのページを順に開き、`securitypolicyviolation` イベントを記録 |
| 期待結果 | 違反0件。ライブラリ、フォント、画像、Supabaseとの通信が動く |
| 実測 | 違反0件。ライブラリ読み込み可、フォント可、画像8/8、登録送信で本番Authから応答あり、Service Worker登録可 |

**確認していないこと**：ログイン中の動作（Realtimeの `wss`、写真の署名付きURL、Edge Functionの呼び出し）、カメラ撮影、iPhone実機。

## 3. 写真のパスのDB制約

`records.cover_path` を、所有者のフォルダ（`<user_id>/<ファイル名>.<拡張子>`）か空に限る `check` 制約を追加する（`supabase/migrations/20261029010000_cover_path_owner_check.sql`）。

- 既存136件はすべて形式に合っていた。
- 取り消すトランザクションで、他人のフォルダと `../` を含むパスは拒否され、自分のフォルダは受け付けられることを確認した。
- 2026-10-29、作業者の承認を得て本番に適用した（マイグレーション履歴に記録）。

## 気づいたこと

- 利用者Aのレコードは136件だが、写真は132件。4件は、写真が見つからないレコードの可能性がある。分離の問題ではないが、別途確認する。
