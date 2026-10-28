# 2026-10-28 AI調査の検索不使用と原価の実測（工程06・07）

本番環境（Supabase、GitHub Pages）で、`ai_usage` テーブルと診断ログを使って確認した記録。**実測は1件ずつで、件数が少ない。**以下の費用は単価を掛けた試算で、Googleの請求額とは照合していない。

## 分かったこと

### 検索がほぼ使われていなかった

- 解析済み134件のうち、出典（`aiSources`）があるのは1件、根拠のある相場は0件だった。それにもかかわらず、130件がB面「確認済み」になっていた。
- 無料枠のキーでも有料（Tier 1）のキーでも、`gemini-3.5-flash-lite` は検索ツールを受け付けたうえで使わずに回答した。応答に `groundingMetadata` も `urlContextMetadata` もなく、`finishReason` は `STOP`。
- 公式ドキュメント（2026-10-13更新）によると、検索するかどうかはモデルが判断し、強制する方法は記載されていない。
- 調査ステップを `gemini-3.8-flash` にすると、URL Context でページを開き、出典が付いた。

### 実測（調査ステップ、1件ずつ）

| 条件 | 出典 | B面 | 相場 | ツール入力トークン | 出力トークン | 所要時間 | 試算費用 |
|---|---|---|---|---|---|---|---|
| 3.5 Flash-Lite（無料キー） | 0 | 申告どおり確認済み（修正前） | 概算 | 0 | 420 | 6.8秒 | 約0.002ドル |
| 3.5 Flash-Lite（有料キー、修正後） | 0 | 要確認 | 概算 | 0 | — | 5.8秒 | 約0.002ドル |
| 3.8 Flash、ページ上限なし | 5 | 確認済み | 概算 | 339,935 | 1,855 | 53.5秒 | 約0.26ドル |
| 3.8 Flash、ページ4件まで | 4 | 確認済み | 概算 | 175,098 | 5,059 | 80.8秒 | 約0.15ドル |

単価は [Gemini API の料金](https://ai.google.dev/gemini-api/docs/pricing)（2026-10-27更新）による。3.8 Flash は入力0.75ドル／出力3.75ドル（100万トークンあたり、2026年12月31日まで。2027年1月1日から倍）。URL Context で取得した本文は入力トークンとして課金される。

## 反映した対応

| 対応 | PR |
|---|---|
| 出典がない解析では、B面を確認済みにしない | #4 |
| 調査ステップのGemini応答の形をログに出す。402（残高不足）を専用の文言で表示 | #5 |
| 調査モデルを Secret `GEMINI_RESEARCH_MODEL` で切り替える（本番は `gemini-3.8-flash`） | #6 |
| URL Context で開くページを合計4件までにするよう指示 | #7 |
| Supabase の `GEMINI_API_KEY` を、有料プロジェクトのキーに差し替え（作業者が画面で実施） | — |

## 未解決・未確認

- **検索回数を記録できていない。**出典は検索経由の形式（`grounding-api-redirect`）なのに `search_queries` が0のため、検索リクエストの課金（月5,000回まで無料、超過分は1,000回あたり14ドル）を試算に含めていない。Google AI Studio の利用状況との照合が必要。
- **相場は4回とも概算だった。**費用の大半を占める商品ページの確認から、根拠のある相場は1件も得られていない。データがたまった段階で、相場調査のやり方を見直すか判断する。
- 既存の約130件の「B面確認済み」は、判断によりそのままにした。再調査したものから正しい状態になる。
- Supabase の GitHub 連携は「本番にリポジトリにないマイグレーション履歴がある」ため毎回失敗している。本番への反映は画面操作で行っている。

## 次に見るもの

普段どおり使って `ai_usage` にデータがたまったら、次のSQLで、モデル別の件数・出典の付き方・費用を見る。

```sql
select u.model, count(*) as attempts,
       count(*) filter (where u.outcome = 'error') as errors,
       round(avg(u.tool_prompt_tokens)) as avg_tool_tokens,
       round(avg(u.duration_ms) / 1000.0, 1) as avg_seconds,
       count(*) filter (where r.data->>'marketPriceBasis' = 'evidence') as evidence_price
from public.ai_usage u left join public.records r on r.id = u.record_id
group by 1 order by 2 desc;
```
