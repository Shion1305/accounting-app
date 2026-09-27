export type EntryKind = "income" | "expense";

export type ReportPeriod =
  | Readonly<{ kind: "all"; from: null; untilExclusive: null }>
  | Readonly<{
      kind: "fiscal_year" | "month" | "range";
      from: string;
      untilExclusive: string;
    }>;

export type ReportEntry = Readonly<{
  sourceKey: string;
  kind: EntryKind;
  occurredOn: string;
  recordedAt: string;
  amountYen: number;
  category: Readonly<{ code: string; name: string }> | null;
  description: string;
  note: string | null;
  purpose: string | null;
  eligibleAmountYen: number | null;
}>;

export type AccountingSnapshot = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  organization: Readonly<{ name: string }>;
  fiscalYear: number;
  period: ReportPeriod;
  openingBalanceYen: number | null;
  entries: readonly ReportEntry[];
}>;

export type UniversityReportDefinition = Readonly<{
  template: Readonly<{ id: string; version: string }>;
  categories: readonly Readonly<{
    id: string;
    name: string;
    kind: EntryKind;
    sourceCategoryCodes: readonly string[];
  }>[];
}>;

export type ReportRow = Readonly<{
  key: string;
  sourceKeys: readonly string[];
  occurredOn: string;
  amountYen: number;
  description: string;
  note: string | null;
  purpose: string | null;
  eligibleAmountYen: number | null;
}>;

export type ReportTable = Readonly<{
  id: string;
  name: string;
  kind: EntryKind;
  rows: readonly ReportRow[];
}>;

export type UniversityDataFrame = Readonly<{
  schemaVersion: 1;
  template: UniversityReportDefinition["template"];
  header: Readonly<{
    organizationName: string;
    fiscalYear: number;
    period: ReportPeriod;
    capturedAt: string;
  }>;
  tables: readonly ReportTable[];
  aggregates: readonly Readonly<{
    tableId: string;
    column: "amountYen";
    rowKeys: readonly string[];
    expectedYen: number;
  }>[];
  summary: Readonly<{
    sourceCount: number;
    incomeYen: number;
    expenseYen: number;
    openingBalanceYen: number | null;
    closingBalanceYen: number | null;
  }>;
}>;

export type ReportIssue = Readonly<{
  code:
    | "INVALID_SNAPSHOT"
    | "INVALID_DEFINITION"
    | "DUPLICATE_SOURCE_KEY"
    | "ENTRY_OUTSIDE_PERIOD"
    | "UNCLASSIFIED_ENTRY"
    | "UNMAPPED_CATEGORY"
    | "AMOUNT_OVERFLOW";
  sourceKey?: string;
  path?: string;
}>;

export type BuildDataFrameResult =
  | { ok: true; dataFrame: UniversityDataFrame }
  | { ok: false; issues: readonly ReportIssue[] };
