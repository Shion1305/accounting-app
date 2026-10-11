# 会計出力の責務とデータ契約

更新日: 2026-09-27

位置付け: 3段階の分離は合意済み。型の抜粋は目標形であり、全てが実装済みではない。

[ドキュメント一覧](../README.md)

## 3段階の責務

```ts
// 1. DBから取得する
const snapshot = await source.capture(scope, selection);

// 2. 大学の帳票に合わせたData Frameを作る
const built = buildUniversityDataFrame(snapshot, definition);
if (!built.ok) return validationResponse(built.issues);

// 3. Data Frameからファイルを作る
const result = await fileExporter.exportReport(built.dataFrame, format, {
  generatedAt,
});
```

この3段階を別々に呼び出してテスト可能にする。認証、テンプレート定義の取得、実行履歴、HTTP応答は外側の実行モジュールとルートで管理する。

| 部分                 | 責務                                                           |
| -------------------- | -------------------------------------------------------------- |
| Honoルート           | 認証、所属確認、HTTP入力検証、応答への変換                     |
| データ取得Adapter    | D1への問い合わせ、期間・状態・サークルによる抽出、DB型の正規化 |
| 大学別Data Frame生成 | 科目変換、並び順、グループ化、集計対象と期待値の決定           |
| ファイル出力         | セル配置、継続シート、数式、書式、再計算、Excel/PDF生成        |
| テンプレートカタログ | 対応大学、版、必須入力、大学別定義の取得                       |
| 履歴Adapter          | 開始・終端結果の保存、サークル別の履歴取得                     |
| 実行モジュール       | 3段階と履歴保存の呼出順、失敗処理、処理ログ                    |

帳票生成モジュールへDB接続、Drizzleの行型、HonoのContext、認証情報を渡さない。通常のTypeScriptオブジェクトで単独実行できる契約にする。

Data Frame生成はI/O・現在時刻・乱数に依存しない純粋関数とする。ファイル出力はテンプレート読込や変換プロセスを含むので、全体を純粋関数とは扱わない。

計算関数や並び替え関数ごとにDI用interfaceを増やさない。差し替え可能にするのはDB、履歴保存、所有する別実行環境との通信、PDF変換など、実際にI/Oと失敗が発生する箇所。

## 配置するコード

```text
packages/accounting-export/
  src/
    contracts.ts                 # Snapshot / Data Frame / 結果の契約
    catalog.ts                   # 大学定義・版・必須項目
    dataframe/
      index.ts                   # buildUniversityDataFrame
      build.ts                   # 検証・科目変換・整形・集計
      layouts/                   # 明細・費目別明細・集計のデータ構造
    file/
      index.ts                   # exportReport
      placement.ts               # セル配置・継続シート計画
      workbook/                  # Excel・数式・印刷設定
      conversion/                # 再計算・PDF変換の内部契約
  templates/                     # 空XLSX・対応表・配置設定・版
  test/
    fixtures/                    # 独立した入力・期待値・検証用書式
    dataframe.test.ts
    workbook.test.ts

apps/server/src/accounting/
  create-export.ts               # 実行モジュール
  d1-export-source.ts            # DB取得
  d1-export-history.ts           # 履歴DB
  report-client.ts               # Data Frameを帳票実行環境へ渡す
  export-log.ts                  # 構造化ログ
apps/server/src/routes/accounting.ts
apps/server/test/accounting/      # 取得・履歴・実行・HTTPテスト

apps/report-service/              # 変換用実行基盤の採用時
  src/index.ts                   # 内部通信の検証とexportReport呼出
  src/libreoffice.ts              # 具体的な変換Adapter
  test/conversion.test.ts
  Dockerfile

apps/web/src/routes/AccountingExportPage.tsx
apps/web/src/components/AccountCategorySelect.tsx
apps/web/e2e/accounting-export.spec.ts
```

Workerは契約・Data Frame生成・軽量カタログを参照する。Excelライブラリ、Node固有API、LibreOfficeはファイル出力用の入口に分離する。大学固有の分岐を画面やHTTPハンドラーへ分散させない。

Honoのルート型共有を維持し、API変更後はserverの型宣言をビルドしてからwebを型チェックする。

## データ契約

以下は設計用の型の抜粋。詳細な列定義・検証コードは契約テストとともに実装する。現在の契約は費目別明細の基礎までで、大学固有情報の完全な契約ではない。[保存設計](accounting-data.md)に従い、選択した帳票の文脈・領収書提出情報・年度プロフィール等を追加する。`eligibleAmountYen` は当該帳票向けの判断結果の投影とし、大学・制度に依存しない取引の属性としてDBへそのまま固定しない。

```ts
type ExportFormat = "xlsx" | "pdf";

type ReportEntry = Readonly<{
  sourceKey: string; // income:<id> / expense:<id>
  kind: "income" | "expense";
  occurredOn: string; // YYYY-MM-DD
  recordedAt: string; // UTCのISO日時。同日取引の順序に使う
  amountYen: number;
  category: Readonly<{ code: string; name: string }> | null;
  description: string;
  note: string | null;
  purpose: string | null;
  eligibleAmountYen: number | null;
}>;

type AccountingSnapshot = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  organization: Readonly<{ name: string }>;
  fiscalYear: number;
  period: Readonly<{
    kind: "fiscal_year" | "month" | "range" | "all";
    from: string | null;
    untilExclusive: string | null;
  }>;
  openingBalanceYen: number | null;
  entries: readonly ReportEntry[];
}>;

type UniversityDataFrame = Readonly<{
  schemaVersion: 1;
  template: Readonly<{
    id: string;
    version: string;
    definitionDigest: string;
  }>;
  header: ReportHeader;
  tables: readonly ReportTable[];
  aggregates: readonly AggregateDefinition[];
  summary: ReportSummary;
  inputDigest: string;
}>;

type BuildDataFrameResult =
  | { ok: true; dataFrame: UniversityDataFrame }
  | { ok: false; issues: readonly ReportIssue[] };

interface ExportSource {
  capture(
    scope: ExportScope,
    selection: ExportSelection,
  ): Promise<AccountingSnapshot>;
}

function buildUniversityDataFrame(
  snapshot: AccountingSnapshot,
  definition: UniversityReportDefinition,
): BuildDataFrameResult;

interface FileExporter {
  exportReport(
    dataFrame: UniversityDataFrame,
    format: ExportFormat,
    options: { generatedAt: string },
  ): Promise<ExportResult>;
}

type ExportResult =
  | {
      ok: true;
      artifact: { bytes: Uint8Array; filename: string; contentType: string };
      manifest: ExportManifest;
    }
  | {
      ok: false;
      error: {
        code: ExportErrorCode;
        stage: ExportStage;
        issues: readonly ReportIssue[];
      };
    };
```

## Snapshot

- DB接続や遅延ロードを含まない、自己完結した取得時点の値とする。
- 分類名・団体情報・開始残高・大学固有の必要情報も固定する。生成中に一部分だけ再取得しない。
- `readonly` は実行時の不変性を保証しない。取得結果を所有するコピーにし、freezeした入力でも変換・出力できることをテストする。
- 日付は日付文字列、時刻はUTCのISO文字列、金額は整数円に統一する。単独金額と集計後の両方で安全な整数範囲を確認する。
- `all` は期間の両端をNULLとし、それ以外は両端を必須にする。提出年度は別に保持する。
- 不明な開始残高はNULLとし、0円と区別する。
- 期間外・重複sourceKey・不正金額を黙って除外せず、契約違反として検出する。

## 大学別Data Frame

- Data FrameはTypeScriptの型付き中間データとする。DB型、Excelオブジェクト、任意のセル操作命令を含めない。
- `ReportTable` は論理的な表または費目ブロック。明細型・費目別明細型・集計型を表現する。
- 各行は安定したキー、元取引の `sourceKeys`、型付き列の値を持つ。集計行は複数の元取引を対応付けられるようにする。
- 大学別定義に従い、費目・列の意味・並び順・集計対象を決める。日付や金額を表示済みの文字列にはしない。
- `AggregateDefinition` は集計IDと対象の表・行・金額列を表す。SUM文字列やA1番地は出力側で生成する。
- `summary` は件数・費目合計・全体合計・残高を持ち、出力後の照合にも使う。
- 元取引が主たる明細または費目集計に過不足なく対応することを検証する。小計・総計の参照と二重計上を区別する。
- `sourceKey` を大学帳票へ勝手に追加しない。対応関係の検証に用いる。

## 出力結果

- `exportReport` はData Frameの構造、参照、集計整合性、テンプレート版を検証する。
- 科目変換やDB抽出を再実行せず、Data Frameをセル・シートへ配置する。
- 指定版がない場合や、定義と出力テンプレートの内容が一致しない場合は失敗させる。最新へ自動置換しない。
- manifestにテンプレート・生成器の版、入力の指紋、件数・集計、ファイルサイズ・ハッシュ、警告を返す。
- generatedAtは呼出側から渡す。同じ入力で会計結果・配置は一致させるが、ZIP内の時刻等を含むバイト一致は仕様にしない。
- 初期は1実行1形式。別々にExcelとPDFを要求した場合は別実行として現在のデータを取得する。
- 将来の両形式一括出力では同じData Frameと生成ブックを共有する。

## 取得の整合性

取得Adapterは、認証から確定したサークルと条件で取引・分類・団体情報・残高、および選択帳票に必要な年度プロフィール・領収書提出情報・判定結果を取得する。単一SQLまたは短いD1トランザクションbatchを使う。

独立SELECTを並列実行するだけでは、途中更新により明細と分類・残高が食い違う可能性がある。capturedAtを付けるだけでも解決しない。D1のbatchとSessions APIの逐次整合性を混同しない。[D1公式仕様](https://developers.cloudflare.com/d1/worker-api/d1-database/)

既存のダッシュボード用summaryを出力合計として再利用せず、取得した同じSnapshotからData Frameと合計を作る。ファイル生成中はDBへ再取得せず、DBトランザクションも保持しない。

プレビューと正式出力は別の取得になる。ブラウザから返された取引配列やData Frameを正式出力元にしない。過去の入力を保存しない初期仕様では「以前のプレビューと必ず同じ内容を再生成する」保証は含めない。

## 大学固有情報を取得・変換へ含める

```text
登録・更新
  ├─ 会計データ（購入日・科目・用途等）
  └─ 必要な時点で領収書提出情報・年度プロフィール等を補完
          ↓
エクスポート要求（大学・帳票・年度・期間・形式）
          ↓
1. DB取得Adapter: 会計データ＋当該帳票に必要な関連情報を取得
          ↓
2. 大学別Data Frame: 条件付き必須検証・分類・集計・番号対応
          ↓
3. export関数: Data FrameだけからExcel/PDFを生成
```

リクエストは出力の選択条件を指定する。未保存の用途や領収書提出区分をリクエスト側で作り出す設計にはしない。補完フォームから保存するAPIと出力APIを分け、出力の直前にDBから取得し直して検証する。

Snapshotに選択帳票の文脈を持つ型付き `reportContext` 等を追加し、必要な取引補助情報を結合する。大学別の分岐と不足検証はData Frame側へ集約する。ExporterはDBへ問い合わせず、科目から対象額を推測せず、不足情報を利用者へ直接問い合わせない。現在の `purpose` は共通の取引の用途として利用でき、`eligibleAmountYen` は必要性が確認された帳票への投影として利用できる。

元情報の保存Schemaと帳票上の表示Schemaを分ける。DBには提出制度や提出関係を保存し、Data Frameには解決済みの表示番号・活動の提出状態などを載せる。レイアウトやテンプレートの改版だけで元の取引を書き換えない。

## 関連文書

- [分離する理由](../adr/0001-separate-export-stages.md)
- [ファイル生成](file-generation.md)
- [実行処理と履歴](export-execution.md)
- [実装計画・契約の実装状況](../plans/accounting-export.md)
