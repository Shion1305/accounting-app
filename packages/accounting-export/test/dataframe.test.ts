import { expect, test } from "vitest";
import { buildUniversityDataFrame } from "../src/dataframe/index.js";
import type {
  AccountingSnapshot,
  ReportEntry,
  UniversityReportDefinition,
} from "../src/contracts.js";
import { definition, entry, snapshot } from "./fixtures.js";

test("大学の費目順に分類し、取引を一度ずつ集計する", () => {
  const result = buildUniversityDataFrame(snapshot, definition);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");

  expect(
    result.dataFrame.tables.map((table) => ({
      id: table.id,
      name: table.name,
      keys: table.rows.map((row) => row.key),
      amounts: table.rows.map((row) => row.amountYen),
    })),
  ).toEqual([
    {
      id: "office",
      name: "備品・印刷費",
      keys: ["expense:1", "expense:2", "expense:5"],
      amounts: [100, 200, 500],
    },
    {
      id: "travel",
      name: "交通費",
      keys: ["expense:3", "expense:4"],
      amounts: [300, 400],
    },
    { id: "dues", name: "会費", keys: [], amounts: [] },
  ]);
  expect(result.dataFrame.summary).toEqual({
    sourceCount: 5,
    incomeYen: 0,
    expenseYen: 1500,
    openingBalanceYen: 2000,
    closingBalanceYen: 500,
  });
  expect(result.dataFrame.aggregates).toEqual([
    {
      tableId: "office",
      column: "amountYen",
      rowKeys: ["expense:1", "expense:2", "expense:5"],
      expectedYen: 800,
    },
    {
      tableId: "travel",
      column: "amountYen",
      rowKeys: ["expense:3", "expense:4"],
      expectedYen: 700,
    },
    { tableId: "dues", column: "amountYen", rowKeys: [], expectedYen: 0 },
  ]);
});

test.each([null, 0, 2000])(
  "0件でも空の費目表を返し、不明な開始残高を0にしない (%s)",
  (openingBalanceYen) => {
    const result = buildUniversityDataFrame(
      { ...snapshot, entries: [], openingBalanceYen },
      definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("変換が失敗しました");
    expect(result.dataFrame.tables.map((table) => table.rows)).toEqual([
      [],
      [],
      [],
    ]);
    expect(result.dataFrame.summary).toEqual({
      sourceCount: 0,
      incomeYen: 0,
      expenseYen: 0,
      openingBalanceYen,
      closingBalanceYen: openingBalanceYen,
    });
  },
);

test("全期間の収入・支出を区分し、備考や文字列をそのまま保持する", () => {
  const expense = entry({
    occurredOn: "2024-02-29",
    description: "=SUM(A1:A2)",
    note: "長い備考\n日本語",
    purpose: "活動用",
    eligibleAmountYen: 60,
  });
  const result = buildUniversityDataFrame(
    {
      ...snapshot,
      period: { kind: "all", from: null, untilExclusive: null },
      entries: [
        expense,
        entry({
          sourceKey: "income:1",
          kind: "income",
          amountYen: 600,
          category: { code: "dues", name: "会費" },
        }),
      ],
    },
    definition,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");
  expect(result.dataFrame.summary).toEqual({
    sourceCount: 2,
    incomeYen: 600,
    expenseYen: 100,
    openingBalanceYen: 2000,
    closingBalanceYen: 2500,
  });
  expect(result.dataFrame.tables[0]?.rows[0]).toEqual({
    key: "expense:1",
    sourceKeys: ["expense:1"],
    occurredOn: "2024-02-29",
    amountYen: 100,
    description: "=SUM(A1:A2)",
    note: "長い備考\n日本語",
    purpose: "活動用",
    eligibleAmountYen: 60,
  });
});

test("入力順によらず取引日・登録日時・識別子の順になる", () => {
  const input = {
    ...snapshot,
    entries: [
      entry({ sourceKey: "expense:a", recordedAt: "2026-05-01T00:00:01Z" }),
      entry({ sourceKey: "expense:z", recordedAt: "2026-05-01T00:00:00.000Z" }),
      entry({ sourceKey: "expense:b" }),
      entry({
        sourceKey: "expense:first",
        occurredOn: "2026-04-30",
        recordedAt: "2026-05-02T00:00:00Z",
      }),
    ],
    period: { kind: "all" as const, from: null, untilExclusive: null },
  };
  const result = buildUniversityDataFrame(input, definition);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");
  expect(result.dataFrame.tables[0]?.rows.map((row) => row.key)).toEqual([
    "expense:first",
    "expense:b",
    "expense:z",
    "expense:a",
  ]);
  expect(
    buildUniversityDataFrame(
      { ...input, entries: [...input.entries].reverse() },
      definition,
    ),
  ).toEqual(result);
});

test("freezeされた入力でも動作し、結果はJSON化できる", () => {
  const input = structuredClone(snapshot);
  const template = structuredClone(definition);
  deepFreeze(input);
  deepFreeze(template);
  const result = buildUniversityDataFrame(input, template);
  expect(result.ok).toBe(true);
  expect(input).toEqual(snapshot);
  expect(template).toEqual(definition);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("返したData Frameは呼出元のオブジェクト変更の影響を受けない", () => {
  const organization = { name: "取得時の団体名" };
  const template = { ...definition.template };
  const period = {
    kind: "month" as const,
    from: "2026-05-01",
    untilExclusive: "2026-06-01",
  };
  const inputEntries = [entry()];
  const result = buildUniversityDataFrame(
    { ...snapshot, organization, period, entries: inputEntries },
    { ...definition, template },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");
  organization.name = "変更後";
  template.version = "2";
  period.from = "2026-05-10";
  inputEntries.push(entry({ sourceKey: "expense:2" }));
  expect(result.dataFrame.header).toEqual({
    organizationName: "取得時の団体名",
    fiscalYear: 2026,
    capturedAt: "2026-06-01T00:00:00Z",
    period: snapshot.period,
  });
  expect(result.dataFrame.template).toEqual(definition.template);
  expect(result.dataFrame.summary.sourceCount).toBe(1);
});

test.each<UniversityReportDefinition>([
  { ...definition, template: { id: "", version: "1" } },
  { ...definition, template: { id: "fixture", version: "" } },
  { ...definition, categories: [] },
  {
    ...definition,
    categories: [
      {
        id: "office",
        name: "印刷費",
        kind: "expense",
        sourceCategoryCodes: [],
      },
    ],
  },
])("不完全な帳票定義を拒否する (%#)", (input) => {
  const result = buildUniversityDataFrame(snapshot, input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不正定義が受け入れられました");
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "INVALID_DEFINITION" }),
  );
});

test("登録時刻のミリ秒未満の精度も並び順に反映する", () => {
  const result = buildUniversityDataFrame(
    {
      ...snapshot,
      entries: [
        entry({
          sourceKey: "expense:a",
          recordedAt: "2026-05-01T00:00:00.0009Z",
        }),
        entry({
          sourceKey: "expense:z",
          recordedAt: "2026-05-01T00:00:00.0001Z",
        }),
        entry({
          sourceKey: "expense:b",
          recordedAt: "2026-05-01T00:00:00.00010Z",
        }),
      ],
    },
    definition,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");
  expect(result.dataFrame.tables[0]?.rows.map((row) => row.key)).toEqual([
    "expense:b",
    "expense:z",
    "expense:a",
  ]);
});

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

test.each<AccountingSnapshot>([
  {
    ...snapshot,
    entries: [
      entry({ amountYen: Number.MAX_SAFE_INTEGER }),
      entry({ sourceKey: "expense:2", amountYen: 1 }),
    ],
  },
  {
    ...snapshot,
    entries: [
      entry({ amountYen: Number.MAX_SAFE_INTEGER }),
      entry({
        sourceKey: "expense:2",
        amountYen: 1,
        category: { code: "travel", name: "交通費" },
      }),
    ],
  },
  {
    ...snapshot,
    openingBalanceYen: -Number.MAX_SAFE_INTEGER,
    entries: [entry()],
  },
  {
    ...snapshot,
    openingBalanceYen: Number.MAX_SAFE_INTEGER,
    entries: [
      entry({
        sourceKey: "income:1",
        kind: "income",
        category: { code: "dues", name: "会費" },
      }),
    ],
  },
])("集計・残高が安全な整数円の範囲を超えたら拒否する (%#)", (input) => {
  const result = buildUniversityDataFrame(input, definition);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("範囲外の金額が受け入れられました");
  expect(result.issues).toEqual([{ code: "AMOUNT_OVERFLOW" }]);
});

test("残高の途中計算が大きくても1円単位で正確に計算する", () => {
  const result = buildUniversityDataFrame(
    {
      ...snapshot,
      openingBalanceYen: Number.MAX_SAFE_INTEGER,
      entries: [
        entry({ amountYen: 2 }),
        entry({
          sourceKey: "income:1",
          kind: "income",
          amountYen: 2,
          category: { code: "dues", name: "会費" },
        }),
      ],
    },
    definition,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("変換が失敗しました");
  expect(result.dataFrame.summary.closingBalanceYen).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test.each<Partial<ReportEntry>>([
  { amountYen: 1.5 },
  { amountYen: -100 },
  { amountYen: 0 },
  { amountYen: Number.NaN },
  { amountYen: Number.POSITIVE_INFINITY },
  { amountYen: Number.MAX_SAFE_INTEGER + 1 },
  { occurredOn: "2026-02-30" },
  { recordedAt: "invalid" },
  { eligibleAmountYen: -1 },
  { eligibleAmountYen: 101 },
])("不正な日付・金額を帳票データにしない (%#)", (overrides) => {
  const result = buildUniversityDataFrame(
    { ...snapshot, entries: [entry(overrides)] },
    definition,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不正入力が受け入れられました");
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "INVALID_SNAPSHOT" }),
  );
});

test.each<Partial<AccountingSnapshot>>([
  {
    period: { kind: "range", from: "2026-06-01", untilExclusive: "2026-05-01" },
  },
  {
    period: { kind: "range", from: "2026-05-01", untilExclusive: "2026-05-01" },
  },
  { openingBalanceYen: 0.5 },
  { capturedAt: "invalid" },
])("不正な取得条件を拒否する (%#)", (overrides) => {
  const result = buildUniversityDataFrame(
    { ...snapshot, ...overrides },
    definition,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不正入力が受け入れられました");
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "INVALID_SNAPSHOT" }),
  );
});

test("重複した元取引と期間外の取引を拒否する", () => {
  expect(
    buildUniversityDataFrame(
      {
        ...snapshot,
        entries: [
          entry(),
          entry(),
          entry({ sourceKey: "expense:before", occurredOn: "2026-04-30" }),
          entry({ sourceKey: "expense:end", occurredOn: "2026-06-01" }),
        ],
      },
      definition,
    ),
  ).toEqual({
    ok: false,
    issues: [
      { code: "DUPLICATE_SOURCE_KEY", sourceKey: "expense:1" },
      { code: "ENTRY_OUTSIDE_PERIOD", sourceKey: "expense:before" },
      { code: "ENTRY_OUTSIDE_PERIOD", sourceKey: "expense:end" },
    ],
  });
});

test.each<UniversityReportDefinition>([
  {
    ...definition,
    categories: [
      ...definition.categories,
      {
        id: "duplicate",
        name: "重複",
        kind: "expense",
        sourceCategoryCodes: ["printing"],
      },
    ],
  },
  {
    ...definition,
    categories: [
      {
        id: "same",
        name: "印刷",
        kind: "expense",
        sourceCategoryCodes: ["printing"],
      },
      {
        id: "same",
        name: "会費",
        kind: "income",
        sourceCategoryCodes: ["dues"],
      },
    ],
  },
  {
    ...definition,
    categories: [
      {
        id: "office",
        name: "印刷",
        kind: "expense",
        sourceCategoryCodes: ["printing", "printing"],
      },
    ],
  },
])("二重計上を生む費目定義を拒否する (%#)", (invalidDefinition) => {
  const result = buildUniversityDataFrame(snapshot, invalidDefinition);
  expect(result).toMatchObject({
    ok: false,
    issues: [{ code: "INVALID_DEFINITION" }],
  });
});

test("未分類・未対応の費目を除外せず、該当取引を返す", () => {
  const result = buildUniversityDataFrame(
    {
      ...snapshot,
      entries: [
        entry({ category: null }),
        entry({
          sourceKey: "expense:2",
          category: { code: "unknown", name: "未対応" },
        }),
        entry({ sourceKey: "income:1", kind: "income" }),
      ],
    },
    definition,
  );
  expect(result).toEqual({
    ok: false,
    issues: [
      { code: "UNCLASSIFIED_ENTRY", sourceKey: "expense:1" },
      { code: "UNMAPPED_CATEGORY", sourceKey: "expense:2" },
      { code: "UNMAPPED_CATEGORY", sourceKey: "income:1" },
    ],
  });
});
