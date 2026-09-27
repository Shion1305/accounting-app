import type {
  AccountingSnapshot,
  ReportEntry,
  UniversityReportDefinition,
} from "../src/contracts.js";

export function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    sourceKey: "expense:1",
    kind: "expense",
    occurredOn: "2026-05-01",
    recordedAt: "2026-05-01T00:00:00Z",
    amountYen: 100,
    category: { code: "printing", name: "印刷費" },
    description: "配布資料",
    note: null,
    purpose: null,
    eligibleAmountYen: null,
    ...overrides,
  };
}

// 合成帳票。正式な大学書式や費目対応を表すものではない。
export const definition: UniversityReportDefinition = {
  template: { id: "fixture-university", version: "1" },
  categories: [
    {
      id: "office",
      name: "備品・印刷費",
      kind: "expense",
      sourceCategoryCodes: ["printing", "supplies"],
    },
    {
      id: "travel",
      name: "交通費",
      kind: "expense",
      sourceCategoryCodes: ["travel"],
    },
    { id: "dues", name: "会費", kind: "income", sourceCategoryCodes: ["dues"] },
  ],
};

export const snapshot: AccountingSnapshot = {
  schemaVersion: 1,
  capturedAt: "2026-06-01T00:00:00Z",
  organization: { name: "テストサークル" },
  fiscalYear: 2026,
  period: { kind: "month", from: "2026-05-01", untilExclusive: "2026-06-01" },
  openingBalanceYen: 2000,
  entries: [
    entry({ sourceKey: "expense:5", amountYen: 500, occurredOn: "2026-05-03" }),
    entry({
      sourceKey: "expense:2",
      amountYen: 200,
      category: { code: "supplies", name: "消耗品費" },
    }),
    entry({
      sourceKey: "expense:3",
      amountYen: 300,
      category: { code: "travel", name: "交通費" },
    }),
    entry(),
    entry({
      sourceKey: "expense:4",
      amountYen: 400,
      category: { code: "travel", name: "交通費" },
    }),
  ],
};
