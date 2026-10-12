# 代表的な成果物

すべて合成データによる方式検証の証拠であり、正式提出用のファイルではない。元の生成Excelは修正せず複製し、`manifest.json` に実行IDとSHA-256を記録した。

- `*-sol-r1.xlsx`: GPT-6.1 Solの初回4出力。静的評価に合格し、それぞれの使い捨てコピーでExcelの入力変更・再計算を確認した。法政の既存の参照切れ6セルは修正対象外。
- `waseda-5-6-luna-r1-invalid.xlsx`: GPT-5.6 Lunaの不合格例。ラベルの削除、セルと親行の不一致があり、Excelが修復を要求した。修復後のファイルへ差し替えていない。
- `ritsumeikan-sol-r1.pdf`、`gakushuin-sol-r1.pdf`: 入力変更の試験値を元へ戻した使い捨てコピーから、Excelで保存した印刷証拠。各1ページを目視確認した。

比較条件、検査範囲、全試行の費用・合否は[検証結果](../../../../../docs/reports/llm-file-editing-poc-2026-10-12.md)を参照する。全試行の生のAPIログ・生成物はローカルの `experiments/llm-export/runs/initial-evaluation` に保存する。
