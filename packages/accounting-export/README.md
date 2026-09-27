# 会計出力データの変換

`buildUniversityDataFrame(snapshot, definition)`は、取得済みの会計データを大学の費目順に整形する。
DB・HTTP・Excelオブジェクト・現在時刻に依存せず、成功時は明細・集計対象・期待金額を返す。

```ts
import { buildUniversityDataFrame } from "@repo/accounting-export/dataframe";
import type {
  AccountingSnapshot,
  UniversityReportDefinition,
} from "@repo/accounting-export/contracts";

function prepare(
  snapshot: AccountingSnapshot,
  definition: UniversityReportDefinition,
) {
  return buildUniversityDataFrame(snapshot, definition);
}
```

## 入出力の契約

- 入力は取得時点の値。抽出・承認状態の選択・開始残高の取得は呼出側が担当する。
- 日付は`YYYY-MM-DD`、時刻はUTCのISO文字列。期間の開始日を含み、終了日を含まない。
- `all`以外の期間は呼出側で日付範囲へ正規化する。年度開始月の判断はこの関数では行わない。
- 取引金額は正の整数円。開始残高には負数を許容し、不明な開始・終了残高は`null`で返す。
- 大学定義の配列順に表を作り、各表の明細は取引日・登録日時・識別子の順に並べる。
- アプリ側の科目は収支区分とcodeで照合する。複数codeを同じ大学費目へまとめられる。
- 元取引は一度ずつ明細へ対応し、`sourceKeys`で追跡する。入力を変更せず、出力も入力の可変オブジェクトを共有しない。
- 0件でも定義した費目の空表を返す。摘要・備考・用途と金額を表示用文字列へ変換しない。
- `aggregates`は表・行キー・金額列・期待金額を表す。セル番地やSUM式は後段のファイル生成が決める。
- 集計は内部でBigIntを使い、入力・集計・残高が安全な整数円の範囲内であることを確認する。返すData FrameはJSON化できるnumberを使う。

入力が不正な場合は`ok: false`を返し、部分的なData Frameは返さない。

| code                 | 意味                                                         |
| -------------------- | ------------------------------------------------------------ |
| INVALID_SNAPSHOT     | 日付・金額・必須フィールド等が不正。pathで対象を示す         |
| INVALID_DEFINITION   | 帳票定義が不正。表IDの重複、同じ科目の複数費目への割当も含む |
| DUPLICATE_SOURCE_KEY | 同じ元取引が複数回含まれている                               |
| ENTRY_OUTSIDE_PERIOD | 正規化済みの期間から外れた取引                               |
| UNCLASSIFIED_ENTRY   | 会計項目が未分類                                             |
| UNMAPPED_CATEGORY    | 大学の費目対応がない                                         |
| AMOUNT_OVERFLOW      | 集計または残高が安全な整数円の範囲外                         |

分類・重複・期間外のエラーには`sourceKey`を返す。構造検証、定義の重複検証、取引検証、集計の順で確認し、
前段で失敗した場合は後段の検証へ進まない。

## 現在の範囲

最初の実装は費目別明細の変換まで。テストの大学定義は合成データで、正式な大学書式ではない。
大学別の必須項目・集計型レイアウトは正式テンプレートに沿って追加する。
DB取得Adapter、入力・定義のハッシュ、Excel/PDF生成、実行履歴は後続の実装で接続する。
`purpose`と`eligibleAmountYen`は値の保持と金額範囲の検証までを行い、大学固有の必須判定は未実装。

## 開発

```sh
pnpm --filter @repo/accounting-export test
pnpm --filter @repo/accounting-export check-types
pnpm --filter @repo/accounting-export build
```

テストは公開関数に固定Snapshotと大学定義を渡し、手計算した明細・合計・エラーと比較する。
DBや帳票ライブラリのモックは使わない。ルートの`pnpm test`とGitHub Actionsからも実行する。
