import type {
  AccountingSnapshot,
  BuildDataFrameResult,
  ReportIssue,
  ReportRow,
  UniversityReportDefinition,
} from "../contracts.js";
import { definitionSchema, snapshotSchema } from "./validation.js";

export function buildUniversityDataFrame(
  snapshot: AccountingSnapshot,
  definition: UniversityReportDefinition,
): BuildDataFrameResult {
  const checkedDefinition = definitionSchema.safeParse(definition);
  if (!checkedDefinition.success) {
    return {
      ok: false,
      issues: checkedDefinition.error.issues.map((issue) => ({
        code: "INVALID_DEFINITION",
        path: issue.path.join("."),
      })),
    };
  }
  const checkedSnapshot = snapshotSchema.safeParse(snapshot);
  if (!checkedSnapshot.success) {
    return {
      ok: false,
      issues: checkedSnapshot.error.issues.map((issue) => ({
        code: "INVALID_SNAPSHOT",
        path: issue.path.join("."),
      })),
    };
  }
  definition = checkedDefinition.data;
  snapshot = checkedSnapshot.data;

  const categoryIds = new Set<string>();
  const mappings = new Map<string, string>();
  for (const category of definition.categories) {
    if (categoryIds.has(category.id)) return invalidDefinition();
    categoryIds.add(category.id);
    for (const code of category.sourceCategoryCodes) {
      const key = `${category.kind}:${code}`;
      if (mappings.has(key)) return invalidDefinition();
      mappings.set(key, category.id);
    }
  }
  const issues: ReportIssue[] = [];
  const sourceKeys = new Set<string>();
  for (const entry of snapshot.entries) {
    if (sourceKeys.has(entry.sourceKey)) {
      issues.push({ code: "DUPLICATE_SOURCE_KEY", sourceKey: entry.sourceKey });
    }
    sourceKeys.add(entry.sourceKey);
    if (
      snapshot.period.kind !== "all" &&
      (entry.occurredOn < snapshot.period.from ||
        entry.occurredOn >= snapshot.period.untilExclusive)
    ) {
      issues.push({ code: "ENTRY_OUTSIDE_PERIOD", sourceKey: entry.sourceKey });
    }
    if (entry.category === null) {
      issues.push({ code: "UNCLASSIFIED_ENTRY", sourceKey: entry.sourceKey });
    } else if (!mappings.has(`${entry.kind}:${entry.category.code}`)) {
      issues.push({ code: "UNMAPPED_CATEGORY", sourceKey: entry.sourceKey });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const entries = [...snapshot.entries].sort(
    (a, b) =>
      compare(a.occurredOn, b.occurredOn) ||
      compareInstants(a.recordedAt, b.recordedAt) ||
      compare(a.sourceKey, b.sourceKey),
  );
  const tables = definition.categories.map((category) => ({
    id: category.id,
    name: category.name,
    kind: category.kind,
    rows: entries
      .filter(
        (entry) =>
          entry.category !== null &&
          mappings.get(`${entry.kind}:${entry.category.code}`) === category.id,
      )
      .map(
        (entry): ReportRow => ({
          key: entry.sourceKey,
          sourceKeys: [entry.sourceKey],
          occurredOn: entry.occurredOn,
          amountYen: entry.amountYen,
          description: entry.description,
          note: entry.note,
          purpose: entry.purpose,
          eligibleAmountYen: entry.eligibleAmountYen,
        }),
      ),
  }));
  const tableTotals = tables.map((table) => sumYen(table.rows));
  const income = sumYen(entries.filter((entry) => entry.kind === "income"));
  const expense = sumYen(entries.filter((entry) => entry.kind === "expense"));
  const closingBalance =
    snapshot.openingBalanceYen === null
      ? null
      : BigInt(snapshot.openingBalanceYen) + income - expense;
  const totals = [...tableTotals, income, expense, closingBalance ?? 0n];
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (totals.some((amount) => amount > limit || amount < -limit)) {
    return { ok: false, issues: [{ code: "AMOUNT_OVERFLOW" }] };
  }
  const aggregates = tables.map((table, index) => ({
    tableId: table.id,
    column: "amountYen" as const,
    rowKeys: table.rows.map((row) => row.key),
    expectedYen: Number(tableTotals[index]),
  }));

  return {
    ok: true,
    dataFrame: {
      schemaVersion: 1,
      template: { ...definition.template },
      header: {
        organizationName: snapshot.organization.name,
        fiscalYear: snapshot.fiscalYear,
        period: { ...snapshot.period },
        capturedAt: snapshot.capturedAt,
      },
      tables,
      aggregates,
      summary: {
        sourceCount: entries.length,
        incomeYen: Number(income),
        expenseYen: Number(expense),
        openingBalanceYen: snapshot.openingBalanceYen,
        closingBalanceYen:
          closingBalance === null ? null : Number(closingBalance),
      },
    },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareInstants(a: string, b: string): number {
  const milliseconds = Date.parse(a) - Date.parse(b);
  if (milliseconds !== 0) return milliseconds;
  // Date.parse truncates sub-millisecond precision accepted by the ISO schema.
  const aFraction = a.split(".")[1]?.slice(0, -1) ?? "";
  const bFraction = b.split(".")[1]?.slice(0, -1) ?? "";
  const width = Math.max(aFraction.length, bFraction.length);
  return compare(aFraction.padEnd(width, "0"), bFraction.padEnd(width, "0"));
}

function invalidDefinition(): BuildDataFrameResult {
  return {
    ok: false,
    issues: [{ code: "INVALID_DEFINITION", path: "categories" }],
  };
}

function sumYen(rows: readonly { amountYen: number }[]): bigint {
  return rows.reduce((total, row) => total + BigInt(row.amountYen), 0n);
}
