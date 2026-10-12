# LLMによる会計帳票の直接編集の検証

既存アプリから独立した検証用ランナー。モデル呼出しはローカルHTTPゲートウェイを経由し、SQLiteに使用量・費用推計・未確定の予約を記録する。生成コードはOpenAIのCode Interpreterで実行する。

[検証計画](../../docs/plans/llm-file-editing-evaluation.md) / [ゲートウェイ設計](../../docs/design/llm-evaluation-gateway.md) / [初回の検証結果](../../docs/reports/llm-file-editing-poc-2026-10-12.md)

## 準備

Node.js 26以上とPython 3を使用する（CIはNode.js 26・Python 3.12）。実行コードは標準ライブラリのみを使う。型チェックに必要な開発依存はルートの `pnpm install --frozen-lockfile` で導入する。ルートのgit管理外の `.env` に `OPENAI_API_KEY` を設定する。キーは起動時に読み取り、生成環境・評価器へ渡さない。

以下のコマンドはリポジトリのルートで実行する。ローカルの127.0.0.1へのバインドと、実APIを使う場合は `api.openai.com` への通信が必要。

```sh
pnpm install --frozen-lockfile
pnpm check:llm-export
```

`check:llm-export` はstrict型チェック、TypeScript・Pythonのテスト、4つの参照Excelの構造検査をまとめて実行する。通信テストは架空のキーとモック応答を使い、実APIを呼ばない。APIキーも不要。GitHub Actionsでも同じコマンドを独立したジョブで実行し、既存アプリのNode.js要件は変更しない。

個別に実行する場合は次のコマンドを使う。

```sh
pnpm exec tsc -p experiments/llm-export/tsconfig.json
pnpm test:llm-export
python3 experiments/llm-export/preflight.py
```

## APIの接続確認

```sh
node experiments/llm-export/run.ts --mode inventory --experiment inventory
```

モデル一覧だけを取得し、生成は行わない。帳票実験とは別の予算0の台帳へ記録する。実験名を省略したinventoryも専用の台帳を使う。

## 予算と実行順序

比較対象は `gpt-6.1-sol`、`gpt-6-luna`、`gpt-5.6-luna`。初回PoCでは4大学の基本ケースを各モデルで3回ずつ、計36試行を比較した。最初の12試行で使用量・成果物を確認してから残りへ進めた。以下は今回の10米ドルの予算を共有する実行例。

同じexperiment内で、接続確認・対照・比較・修復の費用を合算する。再起動しても台帳から引き継ぎ、作成済みexperimentの予算は上書きできない。別のexperimentを作ってもAPIアカウント全体の上限にはならないため、同じ検証は同じexperimentで実行する。

まず3モデルそれぞれの短い生成を確認する。この操作からAPI料金が発生する。

```sh
for trial_model in gpt-6.1-sol gpt-6-luna gpt-5.6-luna; do
  node experiments/llm-export/run.ts --mode smoke --experiment initial-evaluation --budget-usd 10 --model "$trial_model" || break
done
```

編集ライブラリの影響を確認する対照実験は、Solの1応答から無変更保存と1セル変更の2ファイルを作る。大学ごとに元のファイルを新しいコンテナへ渡し、4大学で計4応答を使う。

```sh
node experiments/llm-export/control.ts --experiment initial-evaluation --budget-usd 10 --cases ritsumeikan
node experiments/llm-export/control.ts --experiment initial-evaluation --budget-usd 10 --cases gakushuin,hosei,waseda
```

対照だけは `openpyxl.load_workbook` → 保存という経路を指定する。比較試行では編集ライブラリを指定せず、共通の指示と入力を渡す。

```sh
for trial_model in gpt-6.1-sol gpt-6-luna gpt-5.6-luna; do
  node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model "$trial_model" --phase comparison --repeat 1 || break
done
node experiments/llm-export/report.ts --experiment initial-evaluation
node experiments/llm-export/run.ts --mode summary --experiment initial-evaluation
```

残り予算と結果を確認後、同じ比較コマンドの `--repeat` を2、3に変えて各12試行を実行する。`--cases` を省略すると4大学すべてが対象となる。`--repeat` は試行番号を記録するだけで、指定回数のループや重複実行の防止は行わない。同じコマンドを再実行すると新しい有料試行になる。

原因調査の追加試行は `--phase repair` として比較の分母から分離する。このフラグ自体は指示内容を変更せず、前回の成果物や履歴も渡さない。モデル・指示・上限などを変更した場合は保存されたmanifestと指示のハッシュで区別する。`control.ts` の記録は `kind: control` となる。

### 原因調査の追加条件

初回比較とは別枠で、次の4試行を実施した。すべて同じ `initial-evaluation` と合計10米ドルの予算を共有し、追加調査の枠6試行以内で行う。失敗例を選んだ条件変更の調査であり、初回比較の成功率には加えない。

| モデル         | 対象                  | 出力上限 | 追加指示         | 調べること                                         |
| -------------- | --------------------- | -------: | ---------------- | -------------------------------------------------- |
| `gpt-6-luna`   | 学習院・早稲田を各1回 |   12,000 | なし             | 上限だけを増やすと成果物の取得・完了まで到達するか |
| `gpt-5.6-luna` | 法政・早稲田を各1回   |    8,000 | `preserve-ooxml` | 一般的な編集手法の指示で書式保持が改善するか       |

```sh
node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model gpt-6-luna --phase repair --cases gakushuin,waseda --max-output-tokens 12000
node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model gpt-5.6-luna --phase repair --cases hosei,waseda --max-output-tokens 8000 --repair-guidance preserve-ooxml
```

`--repair-guidance preserve-ooxml` は `--mode evaluate --phase repair` の場合だけ指定できる。[追加指示](prompts/preserve-ooxml.md)を共通の依頼文の末尾へ追加し、大学名・セル対応・正解は与えない。指定しなければ従来の依頼文と完全に同じ文字列を使う。manifestには追加指示の識別子・SHA-256と、最終的な依頼文のSHA-256・出力上限を保存する。両条件は別の介入なので、単独の改善量を混ぜずに報告する。

1試行につきモデル応答は1回。ツールの内部反復はCode Interpreterに任せる。自動の再試行やモデル切替はしない。APIのエラーや費用不明が発生したらそのバッチを停止する。`--max-output-tokens` は初期値8,000、最大12,000。`incomplete`も費用と結果を記録する。

API送信前に、入力100,000トークン分の保守的な単価と出力上限、コンテナの予約額を確保する。返されたusageで予約を推計額に置き換える。内部のツール結果などで想定を超えたり費用が不明になった場合は、未確定として予約を保持する。これは実請求額の絶対上限保証ではない。

## 成果物と評価

`runs/<experiment>/` はgit管理外。次を保存する。

- `ledger.sqlite`: 呼出し前の予約、usage、単価の版、料金推計、提供元ID。
- `calls/`: 認証を除去した実際の要求・応答。自動リトライをしないため、1記録が1回の送信に対応する。
- 各試行のディレクトリ: 入力・指示・ハッシュ・モデル応答・編集済みExcel・静的評価・後片付けの結果。
- 対照のディレクトリ: `unchanged.xlsx`、`onecell.xlsx`、変更セル・ライブラリ版・警告を記した `control.json`、独立評価。診断の更新前の評価は `evaluation.original.json`、詳しい調査は `diagnostic-summary.json` に保存する。
- `report.md` / `report.json` / `results.csv`: 全試行と費用の集計。

初回比較でモデルへ渡すのは `docs/references` の参照コピー、`cases/<university>/basic.json`、共通の `prompt.md` だけ。追加調査で指定した場合に限り、一般的な編集手法の追加指示も渡す。採点用の `evaluator/expected.json` や大学別セル対応は渡さない。

評価器はセル内容、金額、SUM等の限定した計算、元の式、書式メタデータ、ZIPパーツ、対象外シートを検査する。数式の保存済み計算値は正解の証拠にしない。静的な合格は `static_status: pass`。評価器そのものはExcelでの再計算・修復警告・見た目・提出可否を確認しないので、総合状態は `unverified` のまま残る。別途のネイティブ確認は `native-checks` と検証結果へ記録し、未確認の試行へ一般化しない。

`report.ts` と `run.ts --mode summary` は保存済みの証拠から集計し、APIを呼ばない。合格率は `comparison` の試行だけから求め、`control` と `repair` を混ぜない。モデル別費用には接続確認・対照・修復を含むため、「成功1件あたりの費用」はその追加費用も含む。費用未確定または合格0件なら単価を算出不能とする。

`finalMessagePresent` は、空白以外の `output_text` を持つ最終回答を意味する。`phase: final_answer` とメッセージの `status: completed` を確認し、途中の `commentary` や未完了の回答は含めない。古い応答形式でphaseまたはメッセージstatusが省略されている場合は、応答全体が `completed` のときだけ省略を許容する。応答ファイル自体がない場合はnullとする。完了判定には、この最終回答・応答全体のcompleted・成果物の取得・静的評価合格の4条件が必要で、ファイルだけの静的合格とは分けて集計する。

保存した比較成果物の静的評価も、APIを呼ばず再実行できる。

```sh
python3 experiments/llm-export/evaluator.py --university ritsumeikan --output /path/to/run/output.xlsx --report /path/to/run/evaluation.rechecked.json
```

既存の評価を変更する場合は元の評価を残す。レポートはmanifestに格納された評価を集計するため、別ファイルへ評価を出力しただけでは集計に反映されない。

共有用のスナップショットは、すべての試行が終了してから作成する。

```sh
node experiments/llm-export/report.ts --experiment initial-evaluation
python3 experiments/llm-export/snapshot.py --experiment initial-evaluation --output experiments/llm-export/results/2026-10-12
```

`summary.json`、`results.csv`、`evidence.json` へ集計・ハッシュ・独立監査・ネイティブ確認を保存する。提供元ID、認証、ローカル絶対パス、生の要求・応答は共有版へ含めない。実際のSQLite台帳に追加された呼出しや未解決費用、古いmanifest、採点後に変更された成果物・入力・指示を検出した場合は出力を拒否する。元の実行ログと生成Excelは `runs` に残る。共有結果の `currentFileHashes` はスナップショット作成時点の記録であり、その後のソース修正へ追従させない。初回検証後の整理と再検証は[結果レポート](../../docs/reports/llm-file-editing-poc-2026-10-12.md#実装と記録の検証)へ別に記録する。

提供元が `completed` を返しても最終メッセージや成果物がない場合があるため、提供元状態・メッセージの存在・ダウンロード・静的合否を別々に記録する。完了指標はこの4条件を要求するが、最終説明の全要件を自動採点するものではない。

## 保存トレースの原因分析（API不要）

[失敗・手戻りの分析](../../docs/reports/llm-file-editing-failure-analysis-2026-10-12.md)では、44応答・796ツール呼出しと取得済み成果物を照合した。Solの成功途中の修正も対象に含める。

```sh
python3 experiments/llm-export/analyze-traces.py --experiment initial-evaluation --output /tmp/llm-trace-summary.json
python3 experiments/llm-export/reproduce-editing-pitfalls.py
```

集計にはgit管理外の `runs/<experiment>/results.csv`、各試行のmanifest/response、接続確認を含める場合はcost-summaryが必要。出力先は新規ファイルに限定し、runs内への書込み・既存ファイルの上書きを拒否する。生コード・全文ログ・提供元ID・パスを除いた[公開集計](diagnostics/2026-10-12/trace-summary.json)は元ログなしでも読める。記録済みの要求ハッシュと合否を引き継ぐ集計であり、入力ファイルの再ハッシュや成果物の再採点は行わない。空出力をエラー件数、ログ文字数を課金トークン数として扱わない。

再現スクリプトは合成XML/ZIPだけで、正規表現による行境界消失、名前空間宣言の欠落、ZipInfoの変更を再現し、各回避方法をassertで確認する。Python標準ライブラリのみを使い、元ファイル・APIには触れない。過去の例外を完全再現するものでも、本番の編集ユーティリティでもない。

[新しい追加指示案](prompts/avoid-editing-pitfalls.md)は未検証で、現行CLIからは選択できない。既存の `prompt.md` と検証済み条件の記録は変更していない。

## 対照実験で確認できたこと

4大学のopenpyxl対照では、無変更保存のセル値と数式の意味、および1セル変更時の指定セル以外の値が保持された。法政の共有SUM数式は個別の式へ展開されており、独立した参照の展開で同値を確認した。これは再計算の確認ではない。

| 参照ファイル | 実際に確認した機能・表現の欠落                                                  |
| ------------ | ------------------------------------------------------------------------------- |
| 学習院       | 4図形と4コネクタが消失。図形内の記入説明も消失                                  |
| 法政         | 22図形と2コネクタが消失。1画像は保持                                            |
| 早稲田       | 4件の拡張入力規則と2図形が消失                                                  |
| 立命館       | 6コメントの本文・作成者・セル位置は保持。文字装飾と注釈枠の寸法・位置情報が変化 |

共有文字列からインライン文字列への変換、コメントのパーツ名変更、共有数式の展開は、内容消失と区別して記録する。書式IDを参照先まで解決した比較にも、既定属性・XML要素順・結合セルの正規化の差が残るため、差分件数を画面上の破損件数として扱わない。

対照の `semantic_status: pass` はセル値・数式の意味に限定した結果。4大学とも機能・表現の欠落があり、`static_status` は `fail`。この結果は指定したopenpyxl保存経路の診断であり、LLMが選ぶすべての編集手法の限界を示すものではない。対照の立命館コピーではExcelで入力を変更してSUMが更新されることを確認した。他の対照ファイルの再計算・描画を確認済みとは扱わない。

## 提供元費用との照合

試行別の金額はusageと料金表からの推計。コンテナは試行専用の1GB、最初の20分セッション相当の$0.03を推計する。提供元の実課金単位・割引・不明な処理との差は後で照合する。料金表の根拠は `gateway/pricing.ts` に記録している。

今回の `initial-evaluation` の料金監査は、保存済みの台帳・要求応答・成果物からAPIを呼ばず再実行できる。

```sh
python3 experiments/llm-export/audit-billing.py --final --save experiments/llm-export/runs/initial-evaluation/billing-audit.json
```

この監査は今回の固定単価と、比較36・対照4・修復4・接続確認3の計47応答、44コンテナ、84アップロードに限定する。nanoUSD単位の再計算、キャッシュと推論トークンの二重計上防止、提供元ID・ハッシュ・削除記録、未解決費用0件を検査し、すべて合格した場合だけ監査結果を保存する。`--final --save ...` を省略すると実行途中の読取専用監査になる。監査に合格しても提供元の請求確認が完了したことにはならない。

通常のキーで管理用Costs APIへアクセスできるとは仮定しない。初期版は提供元から得た期間合計をJSONで取り込める。実験専用Projectの費用を確認してから、次のフィールドを用意する。

| フィールド                   | 内容                                              |
| ---------------------------- | ------------------------------------------------- |
| `experimentId`               | 台帳と同じ実験名                                  |
| `exclusiveExperimentProject` | このProjectの期間内の呼出しが当該実験だけならtrue |
| `providerAmountUsd`          | OpenAI側で計上された金額。推計値を入れない        |
| `periodStart` / `periodEnd`  | 対象期間。UTCのISO日時、終了は排他的              |
| `source`                     | 費用データの取得元と取得日を識別する説明          |

```sh
node experiments/llm-export/report.ts --experiment initial-evaluation --reconciliation /path/to/provider-costs.json
```

取り込んだ合計と推計合計との差を表示する。両者を加算しない。インポートはレポートへの証拠追加であり、不明な呼出しの予約を自動解除しない。提供元の集計だけではどの不明な呼出しの費用か確定できないため、その解決は個別に行う。応答本文の読込に失敗した場合も、取得済みのHTTP状態・提供元リクエストIDを保持する。応答を取得できずコンテナIDが不明な場合、そのコンテナの削除まで完了したとは扱わない。
