# 出力リクエスト・実行履歴・API・画面

更新日: 2026-09-27

位置付け: 実行履歴をDBへ保存し再ダウンロードしない方針は合意済み。テーブル・状態・APIの詳細は設計案。

[ドキュメント一覧](../README.md)

## 実行モジュール

```ts
const accountingExports = createAccountingExports(
  { circleId: c.get("circleId"), actorId: c.get("userId") },
  { source, catalog, fileExporter, history, log, clock, ids },
);
const result = await accountingExports.run(c.req.valid("json"));
return toExportResponse(result);
```

scopeは認証から得て束縛し、履歴一覧・詳細にも適用する。HTTP本文のサークルID・実行者IDを信用しない。clockとidsはテストを固定する小さな依存とし、DIフレームワークは導入しない。

実行順序:

1. 認証・所属・HTTP入力形式の確認を済ませる。
2. 実行IDを発行し、開始履歴をD1へ保存する。
3. 指定テンプレート版とSnapshotを取得する。
4. 大学別Data Frameを作り、不足・不正を検出する。
5. exportReportでファイルを生成・検証する。
6. 件数・集計・結果・エラーを履歴へ確定する。
7. 成功ならファイル、失敗なら実行ID付きエラーを返す。

入力確認用の呼出ごとには履歴を作らない。正式出力で検証不合格となった実行は履歴に残す。

## DB履歴

初期は `accounting_exports` の1テーブルとする。

| 分類     | 保存フィールド                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 主体     | id、circle_id、actor_user_id                                                                                         |
| 条件     | format、template_id、template_version、fiscal_year、period_kind、period_from、period_until_exclusive、selection_mode |
| 状態     | status、started_at、finished_at、deadline_at、duration_ms                                                            |
| 入力     | source_count、income_total_yen、expense_total_yen、input_digest、input_schema_version、dataframe_schema_version      |
| 生成条件 | template_digest、generator_version                                                                                   |
| 出力     | filename、byte_length、artifact_digest                                                                               |
| 失敗     | error_code、error_stage                                                                                              |

未判明の件数・金額・版はNULLとし、不明を0と記録しない。摘要・備考・領収書・入力全体・ファイル本体は保存しない。詳細な入力不足は応答で返し、履歴には安全なエラーコードを記録する。

`(circle_id, started_at, id)` に一覧用インデックスを付け、日時とIDのカーソルを使う。取得・更新は常にサークルで制限する。保存期間は運用時に決め、初期実装で自動削除を追加しない。

| 状態      | 意味                                         |
| --------- | -------------------------------------------- |
| running   | 開始記録済み、終端結果未確定                 |
| generated | ファイル生成・検証・結果記録が完了           |
| rejected  | 分類不足など、出力条件を満たさない           |
| failed    | 抽出・テンプレート処理・再計算・変換等が失敗 |

generatedはブラウザへの保存完了ではない。runningから終端状態への条件付き更新にし、同一結果の再試行は許容するが、異なる終端結果で上書きしない。

中断してrunningが残る場合、実行期限と猶予を過ぎたものを「結果未確認」と表示する。生成成功の可能性もあるので失敗と断定せず、履歴のためだけの定期ジョブも初期は作らない。

## 履歴障害と処理ログ

開始履歴が保存できなければ生成を始めない。結果履歴を確定できなければ成功ファイルを応答しない方針とする。書込応答だけが失われた場合は、実行IDによる限定的な再試行・読戻しで同じ結果かを確認する。

生成失敗と履歴書込失敗が重なった場合は元の生成原因を保持し、履歴失敗も処理ログへ記録する。DB障害中にDB履歴が必ず完結するとは保証しない。

処理ログはDB履歴と別に、同じexportIdでWorkerと帳票実行環境を関連付ける。段階はcapture、build_dataframe、validate_dataframe、render_xlsx、recalculate、render_pdf、history_finalizeを基本とし、開始・終了・失敗・所要時間を残す。

処理ログにも摘要・備考・領収書・個人情報の全文を出力しない。実行ID・段階・安全なエラーコードで追跡する。

Data Frameの純粋な変換関数にロガーを持たせず、実行モジュールや実行環境のラッパーで記録する。処理ログ出力の失敗は正常な帳票結果を変更しない。

手動再実行は新しい実行IDで現在のDBを読み取る。POST全体の自動再試行は初期には行わない。入力・ファイルのハッシュは調査用であり、過去ファイルや入力を復元できるものではない。

## エラーと利用者への説明

| エラー                           | 対応                                             |
| -------------------------------- | ------------------------------------------------ |
| 大学・年度・期間不正             | 対象入力を示す                                   |
| 未分類・未マッピング             | 該当取引・項目と修正導線を示す。黙って除外しない |
| 用途・対象額等の不足             | 必要な取引と項目を示す                           |
| テンプレートなし・破損・版不一致 | 対応状況と問い合わせ用実行IDを示す               |
| セル・式・Data Frame不正         | 壊れたファイルを配信せず失敗として扱う           |
| PDF失敗・タイムアウト            | 再試行またはExcel形式での新しい出力を案内        |
| 履歴保存失敗                     | 実行ID付きエラー。生成と記録の成否を混同しない   |

## APIと画面

| API                                               | 役割                                               |
| ------------------------------------------------- | -------------------------------------------------- |
| GET /api/admin/account-categories                 | 所属サークルの収入・支出項目                       |
| GET /api/public/circles/:token/account-categories | 公開立替フォーム用。有効な支出項目だけ返す         |
| 既存の収支・立替登録API                           | 分類・購入日・備考等の検証と保存                   |
| 分類補完用PATCH API                               | 対象取引の所属を確認して分類・補助情報を補完       |
| GET /api/admin/accounting/templates               | 対応大学・版・必須入力                             |
| POST /api/admin/accounting/exports/validate       | 取得とData Frame生成。件数・集計・不足項目を返す   |
| POST /api/admin/accounting/exports                | 履歴付きで3段階を実行し、ファイルを返す            |
| GET /api/admin/accounting/exports                 | サークルの実行履歴一覧                             |
| GET /api/admin/accounting/exports/:id             | サークルの実行履歴詳細。ファイル取得機能は含めない |

公開立替フォームも、トークンから解決したサークルの支出項目かを登録時に検証する。出力と履歴APIは既存の管理者認証・所属確認を必須にする。

`/dashboard/accounting-export` を追加し、ダッシュボードとメニューから移動できるようにする。

- 大学・帳票、提出年度、期間、対象データを指定。
- 必要な団体情報・開始残高等を表示・補完。
- 対象件数・収支・残高・未分類・不足件数を表示。
- Excel・PDFのダウンロード操作。
- 実行日時・実行者・大学・期間・形式・件数・結果の履歴一覧。

サークル設定と現在年度を初期値にし、設定とデータ補完が済んだ通常操作では3クリック以内を目標にする。生成中は多重実行を防ぎ、成功時はダウンロード開始を通知する。利用者の保存先への書込完了を確認できる前提にしない。

ファイル名は大学・年度・帳票名を基本とし、月・任意期間は対象期間も含める。ファイル名やHTTPヘッダーで不正な文字を除去する。

主な既存変更箇所はserverのschema、admin・reimbursements・circles・signupルートとindex、webの収入・支出・立替申請・承認・取引一覧・ダッシュボード・AdminLayout・App。

## 保存情報との境界

領収書を大学へ提出した事実と、ファイルを生成した実行履歴は別に扱う。generatedでも領収書の提出状態を更新しない。プロフィール等の補完は保存APIで行い、出力リクエストは選択条件を受け付ける。[保存設計](accounting-data.md)を参照する。

## 関連文書

- [過去ファイルを保存しない判断](../adr/0002-export-history-without-artifacts.md)
- [3段階の契約](export-pipeline.md)
- [障害・権限・履歴のテスト](testing.md)
