# Excel帳票編集の実験コード

LLMに既存のExcel書式を読ませ、会計報告書を編集できるか試すためのコード。アプリ本体とは分けている。モデルへのリクエストはローカルHTTPゲートウェイを通し、SQLiteに使用量と推計費用を記録する。モデルが書いたコードはOpenAIのCode Interpreterで実行する。

[検証計画](../../docs/plans/llm-file-editing-evaluation.md) / [ゲートウェイ設計](../../docs/design/llm-evaluation-gateway.md) / [初回の検証結果](../../docs/reports/llm-file-editing-poc-2026-10-12.md)

## 準備

Node.js 26以上とPython 3が必要。CIではNode.js 26とPython 3.12を使う。実行コードは標準ライブラリだけで動き、型チェック用の開発依存はリポジトリのルートで `pnpm install --frozen-lockfile` を実行して入れる。

以下のコマンドは、すべてリポジトリのルートで実行する。まずはAPIキー不要のオフライン検証から始められる。

```sh
pnpm install --frozen-lockfile
pnpm check:llm-export
```

`check:llm-export` は、TypeScriptのstrict型チェック、TypeScript・Pythonのテスト、4つの参照Excelの構造検査を実行する。通信テストも架空のキーとモック応答を使うため、実APIは呼ばない。GitHub Actionsでも同じコマンドを専用ジョブで実行している。

個別に実行する場合は次のコマンドを使う。

```sh
pnpm exec tsc -p experiments/llm-export/tsconfig.json
pnpm test:llm-export
python3 experiments/llm-export/preflight.py
```

## モデル一覧の取得

ここから先のAPI操作には、ルートの `.env` に `OPENAI_API_KEY` の設定が必要になる。`.env` はGit管理外に置く。キーはゲートウェイだけが使用し、生成コードや評価器には渡さない。ローカルの127.0.0.1での待ち受けと、`api.openai.com` への通信が必要。

```sh
node experiments/llm-export/run.ts --mode inventory --experiment inventory
```

このコマンドはモデル一覧だけを取得し、生成は行わない。帳票実験とは別の、予算0の専用台帳に記録する。`inventory` では実験名を省略しても専用の台帳を使う。

## 予算と実行順序

初回PoCでは `gpt-6.1-sol`、`gpt-6-luna`、`gpt-5.6-luna` を比較した。4大学の基本ケースを各モデルで3回ずつ、計36回実行し、最初の12試行の使用量とファイルを確認してから残りに進んだ。以下は、実験全体で予算10米ドルを共有したときの実行例である。

同じexperimentの中では、接続確認・対照・比較・追加実験の費用を合算する。再起動後も台帳を引き継ぎ、一度作ったexperimentの予算は変更できない。この上限はAPIアカウント全体には適用されないため、同じ検証は同じexperimentに記録する。

まず3モデルそれぞれの短い生成を確認する。この操作からAPI料金が発生する。

```sh
for trial_model in gpt-6.1-sol gpt-6-luna gpt-5.6-luna; do
  node experiments/llm-export/run.ts --mode smoke --experiment initial-evaluation --budget-usd 10 --model "$trial_model" || break
done
```

保存ライブラリの影響を調べる対照実験では、Solに無変更保存と1セル変更の2ファイルを作らせる。大学ごとに元ファイルを新しいコンテナへ渡し、4大学で計4応答を使う。

```sh
node experiments/llm-export/control.ts --experiment initial-evaluation --budget-usd 10 --cases ritsumeikan
node experiments/llm-export/control.ts --experiment initial-evaluation --budget-usd 10 --cases gakushuin,hosei,waseda
```

対照実験では `openpyxl.load_workbook` で読み込んで保存する方法を指定する。モデル比較ではライブラリを指定せず、共通の指示と入力だけを渡す。

```sh
for trial_model in gpt-6.1-sol gpt-6-luna gpt-5.6-luna; do
  node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model "$trial_model" --phase comparison --repeat 1 || break
done
node experiments/llm-export/report.ts --experiment initial-evaluation
node experiments/llm-export/run.ts --mode summary --experiment initial-evaluation
```

残りの予算と結果を確認してから、同じ比較コマンドの `--repeat` を2、3に変え、各12試行を実行する。`--cases` を省略した場合は4大学すべてが対象になる。

`--repeat` は試行番号を記録する引数であり、繰り返し回数ではない。同じコマンドの重複実行も防がないため、もう一度実行すると新しい有料試行になる。

原因調査の追加試行には `--phase repair` を付け、主比較の成功率から外して集計する。この引数自体は指示を変えず、過去の成果物や会話履歴も渡さない。モデル・指示・上限などの違いはmanifestと指示のハッシュに記録する。`control.ts` の結果は `kind: control` として記録する。

### 原因調査の追加条件

初回比較の後、失敗したケースを選んで次の4試行を行った。`initial-evaluation` の予算10米ドルを使い、追加枠6試行の中で実施した。条件を変えた調査なので、初回比較の成功率には含めない。

| モデル         | 対象                  | 出力上限 | 追加指示         | 調べること                                         |
| -------------- | --------------------- | -------: | ---------------- | -------------------------------------------------- |
| `gpt-6-luna`   | 学習院・早稲田を各1回 |   12,000 | なし             | 上限だけを増やすと成果物の取得・完了まで到達するか |
| `gpt-5.6-luna` | 法政・早稲田を各1回   |    8,000 | `preserve-ooxml` | 一般的な編集手法の指示で書式保持が改善するか       |

```sh
node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model gpt-6-luna --phase repair --cases gakushuin,waseda --max-output-tokens 12000
node experiments/llm-export/run.ts --mode evaluate --experiment initial-evaluation --budget-usd 10 --model gpt-5.6-luna --phase repair --cases hosei,waseda --max-output-tokens 8000 --repair-guidance preserve-ooxml
```

`--repair-guidance preserve-ooxml` は `--mode evaluate --phase repair` の場合に指定できる。[追加指示](prompts/preserve-ooxml.md)を共通依頼の末尾に加えるが、大学名・セル対応・正解は含めない。未指定なら従来と同じ依頼文を使う。

manifestには追加指示の識別子とSHA-256、最終依頼文のSHA-256、出力上限を保存する。上限を増やす実験と指示を加える実験では変えた条件が異なるため、効果は分けて読む。

1試行につきモデル応答は1回で、その中のツール実行はCode Interpreterに任せる。自動リトライやモデルの自動切り替えは行わず、APIエラーや費用不明の呼び出しが出たら、そのバッチを止める。`--max-output-tokens` の初期値は8,000、最大値は12,000。`incomplete` でも費用と結果を記録する。

APIへ送る前に、入力100,000トークン、出力上限、コンテナに必要な費用を余裕のある単価で予約する。usageを受信したら推計額を求め、予約と置き換える。使用量が不明な間は予約を残す。ツールの結果で想定より入力が増えることもあり、この処理で実際の請求額の上限までは保証できない。

## 成果物と評価

結果と判断は `docs/reports/` のMarkdownに記録する。生成したJSON、CSV、Excel、PDFなどは `artifacts/` にまとめ、ディレクトリ全体をGit管理外にしている。

`artifacts/results/` は初回の集計と代表ファイル、`artifacts/diagnostics/` はトレース分析と追加比較の記録の保存先である。これらはcloneに含まれないため、過去の実験を監査するには手元の記録が必要になる。

元の実行記録は、同じくGit管理外の `runs/<experiment>/` に保存する。

- `ledger.sqlite`: 呼出し前の予約、usage、単価の版、料金推計、提供元ID。
- `calls/`: 認証を除去した実際の要求・応答。自動リトライをしないため、1記録が1回の送信に対応する。
- 各試行のディレクトリ: 入力・指示・ハッシュ・モデル応答・編集済みExcel・静的評価・後片付けの結果。
- 対照のディレクトリ: `unchanged.xlsx`、`onecell.xlsx`、変更セル・ライブラリ版・警告を記した `control.json`、独立評価。診断の更新前の評価は `evaluation.original.json`、詳しい調査は `diagnostic-summary.json` に保存する。
- `report.md` / `report.json` / `results.csv`: 全試行と費用の集計。

初回比較では、`docs/references` の参照コピー、`cases/<university>/basic.json`、共通の `prompt.md` をモデルに渡す。追加調査で指定した場合だけ、編集方法の指示も加える。採点用の `evaluator/expected.json` と大学別のセル対応は評価器だけで使う。

評価器はセル内容、金額、SUMなどの限定した計算、元の数式、書式メタデータ、ZIPパーツ、対象外シートを調べる。保存済みの数式キャッシュを正解には使わない。

検査に合格すると `static_status: pass` になる。ただしExcelでの再計算、修復警告、表示、提出可否までは確認しないため、総合状態は `unverified` のまま残す。Excelで確認した結果は `native-checks` とレポートに別途記録する。

`report.ts` と `run.ts --mode summary` は保存した記録を集計するだけで、APIは呼ばない。合格率は `comparison` の試行から求める。モデル別費用には接続確認・対照・追加実験も含むため、そこから求める「成功1件あたりの費用」には追加分も入る。費用が未確定か、合格が0件なら単価は算出しない。

`finalMessagePresent` は、空白以外の `output_text` を含む最終回答が完了したかを表す。`phase: final_answer` とメッセージの `status: completed` を確認し、途中の `commentary` や未完了の回答は含めない。古い応答形式でphaseやメッセージstatusがない場合は、応答全体が `completed` のときだけ許容する。応答ファイルがない場合はnullになる。

完了として数えるには、最終回答の完了、応答全体の `completed`、成果物の取得、静的検査の合格という4条件が必要になる。ファイルだけが合格した試行は別に集計する。

保存した比較成果物の静的評価も、APIを呼ばず再実行できる。

```sh
python3 experiments/llm-export/evaluator.py --university ritsumeikan --output /path/to/run/output.xlsx --report /path/to/run/evaluation.rechecked.json
```

評価し直す際は、元の評価も残す。集計に使われるのはmanifest内の評価なので、別ファイルに再評価の結果を出しただけではレポートに反映されない。

共有用のスナップショットは、すべての試行が終了してから作成する。

```sh
node experiments/llm-export/report.ts --experiment initial-evaluation
python3 experiments/llm-export/snapshot.py --experiment initial-evaluation --output experiments/llm-export/artifacts/results/2026-10-12
```

`artifacts/results/2026-10-12/` に、集計用の `summary.json`、試行別の `results.csv`、監査用の `evidence.json` を保存する。提供元ID、認証情報、ローカル絶対パス、生の要求・応答は含めない。

台帳に新しい呼び出しや未確定費用がある場合、manifestが古い場合、採点後に成果物・入力・指示が変わった場合は、スナップショットの出力を拒否する。元のログと生成Excelは `runs/` に残す。`currentFileHashes` は保存時点のソースのハッシュであり、その後の修正に合わせて書き換えない。初回実験後の修正と再検証は[結果レポート](../../docs/reports/llm-file-editing-poc-2026-10-12.md#実装と記録の検証)を参照する。

API上で `completed` でも、最終回答や成果物がないケースがあった。そのため、APIの状態、最終回答、ファイル取得、静的合否をそれぞれ記録している。最終回答の有無は検査するが、説明文の全要件を自動採点するわけではない。

## 保存トレースの原因分析（API不要）

[失敗・手戻りの分析](../../docs/reports/llm-file-editing-failure-analysis-2026-10-12.md)では、44応答・796ツール呼出しと取得済み成果物を照合した。Solの成功途中の修正も対象に含める。

```sh
python3 experiments/llm-export/analyze-traces.py --experiment initial-evaluation --output experiments/llm-export/artifacts/diagnostics/2026-10-12/trace-summary.rechecked.json
python3 experiments/llm-export/reproduce-editing-pitfalls.py
```

再集計には `runs/<experiment>/results.csv` と各試行のmanifest・responseが必要で、接続確認を含める場合はcost-summaryも使う。保存履歴への書き込みと、既存出力の上書きは拒否するため、出力先には新しいファイル名を指定する。

保存済みの集計は `artifacts/diagnostics/2026-10-12/trace-summary.json` にある。生コード、全文ログ、提供元ID、パスは除いている。集計処理は記録されたハッシュと合否を読み取るもので、入力の再ハッシュや成果物の再採点は行わない。空の出力をエラー件数、ログ文字数を課金トークン数として数えることもしない。

再現スクリプトは小さな合成XML・ZIPを使い、正規表現で行の境界が消える問題、名前空間の宣言が消える問題、ZipInfoが書き換わる問題と、それぞれの回避方法をassertで確かめる。Python標準ライブラリだけで動き、元のExcelやAPIには触れない。過去の実行全体を再現するものではなく、問題の仕組みを確認するためのコードである。

[追加指示案](prompts/avoid-editing-pitfalls.md)は `--mode evaluate --phase comparison --prompt-variant avoid-editing-pitfalls` で選択できる。省略時は従来とバイト単位で同じ共通プロンプトを使う。明示的な `--prompt-variant baseline` も比較専用で、`--repair-guidance` とは併用できない。manifestへ条件名・追加本文・送信プロンプトのハッシュを記録する。

Solを各条件12回ずつ比べた手順は[比較計画](../../docs/plans/llm-prompt-improvement-comparison.md)、結果は[比較レポート](../../docs/reports/llm-prompt-improvement-comparison-2026-10-12.md)にまとめている。追加指示ファイルの区切り線より前は、作成当時の状態説明で、APIには送らない。実行時のハッシュを確かめられるよう、ファイルはその説明も含めて当時のまま保存している。現在の使い方はこのREADMEを参照する。

追加比較の集計では、保存した台帳、要求・応答、成果物、評価、削除記録を突き合わせる。実行前に固定した `artifacts/diagnostics/sol-prompt-comparison-2026-10-12/plan.json` も必要になる。APIへのアクセスや、過去の履歴の変更は行わない。

```sh
node experiments/llm-export/report.ts --experiment sol-prompt-baseline-2026-10-12
node experiments/llm-export/report.ts --experiment sol-prompt-improved-2026-10-12
python3 experiments/llm-export/compare-prompts.py --repeats 3 --output experiments/llm-export/artifacts/diagnostics/sol-prompt-comparison-2026-10-12/comparison.rechecked.json
```

出力先には新しいファイル名を指定する。生ログ、提供元ID、ローカルパスは集計に含めない。最初の8応答と全24応答の監査は別に保存する。次節の料金監査は初回47応答専用なので、この追加比較には使わない。

## 対照実験で確認できたこと

openpyxlを使った4大学の対照実験では、無変更保存でセル値と数式の意味が保たれ、1セル変更でもほかの値は変わらなかった。法政の共有SUM数式は個別の式に展開されたが、参照先を展開して比べると同じ意味だった。数式の再計算は、この照合とは別に確認する必要がある。

| 参照ファイル | 実際に確認した機能・表現の欠落                                                  |
| ------------ | ------------------------------------------------------------------------------- |
| 学習院       | 4図形と4コネクタが消失。図形内の記入説明も消失                                  |
| 法政         | 22図形と2コネクタが消失。1画像は保持                                            |
| 早稲田       | 4件の拡張入力規則と2図形が消失                                                  |
| 立命館       | 6コメントの本文・作成者・セル位置は保持。文字装飾と注釈枠の寸法・位置情報が変化 |

共有文字列のインライン化、コメントのパーツ名の変更、共有数式の展開などは、表現が変わっても内容が失われるとは限らない。書式の参照先まで解決して比較しても、既定属性、XMLの要素順、結合セルの正規化による差が残る。そのため、差分件数をそのまま表示の崩れの件数には使えない。

対照実験の `semantic_status: pass` は、セル値と数式の意味が保たれたことを表す。一方で4大学とも機能や表現の欠落があり、`static_status` は `fail` だった。これは指定したopenpyxlの保存方法での結果であり、ほかの編集方法まで試したものではない。

対照の立命館のコピーはExcelでも開き、入力を変えるとSUMが更新されることを確認した。ほかの対照ファイルの再計算と表示は未確認である。

## 提供元費用との照合

試行別の金額は、usageと料金表から求めた推計である。試行専用の1GBコンテナは最初の20分相当として$0.03を計上する。実際の課金単位や割引などによる差は、後で提供元の費用データと照合する。単価の根拠は `gateway/pricing.ts` に記録している。

今回の `initial-evaluation` の料金監査は、保存済みの台帳・要求応答・成果物からAPIを呼ばず再実行できる。

```sh
python3 experiments/llm-export/audit-billing.py --final --save experiments/llm-export/runs/initial-evaluation/billing-audit.json
```

この監査は、初回実験の固定単価と、比較36・対照4・追加4・接続確認3の計47応答、44コンテナ、84アップロードを対象にしている。nanoUSD単位で料金を計算し直し、キャッシュと思考トークンの重複計上、ID・ハッシュ・削除記録、未確定費用の有無を検査する。

すべての検査が通った場合だけ最終監査を保存する。`--final --save ...` を省略すると、実行途中でも記録を変更せずに確認できる。この監査は台帳と元記録の整合性を調べるもので、提供元の請求確認とは別である。

管理用Costs APIの利用には、通常の実行キーとは別の権限が必要になる。代わりに、提供元から得た期間合計をJSONで取り込むこともできる。実験専用Projectの費用を確認し、次の項目を用意する。

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

取り込んだ額は推計に加算せず、両者の差額を表示する。期間合計だけでは費用不明の呼び出しを特定できないため、残っている予約は自動解除しない。各呼び出しを別途調べる必要がある。

応答本文の読み込みに失敗しても、取得済みのHTTP状態と提供元リクエストIDは残す。コンテナIDを取得できなかった場合は、削除を確認できていない状態として記録する。