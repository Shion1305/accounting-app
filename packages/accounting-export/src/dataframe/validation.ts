import { z } from "zod";
import type {
  AccountingSnapshot,
  ReportEntry,
  ReportPeriod,
  UniversityReportDefinition,
} from "../contracts.js";

const yen = z.number().int();
const kind = z.enum(["income", "expense"]);
const textId = z.string().min(1);

const entrySchema: z.ZodType<ReportEntry> = z
  .strictObject({
    sourceKey: textId,
    kind,
    occurredOn: z.iso.date(),
    recordedAt: z.iso.datetime(),
    amountYen: yen.positive(),
    category: z.strictObject({ code: textId, name: textId }).nullable(),
    description: z.string(),
    note: z.string().nullable(),
    purpose: z.string().nullable(),
    eligibleAmountYen: yen.nonnegative().nullable(),
  })
  .refine(
    (entry) =>
      entry.eligibleAmountYen === null ||
      entry.eligibleAmountYen <= entry.amountYen,
    {
      path: ["eligibleAmountYen"],
    },
  );

const periodSchema: z.ZodType<ReportPeriod> = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("all"),
      from: z.null(),
      untilExclusive: z.null(),
    }),
    z.strictObject({
      kind: z.enum(["fiscal_year", "month", "range"]),
      from: z.iso.date(),
      untilExclusive: z.iso.date(),
    }),
  ])
  .refine(
    (period) => period.kind === "all" || period.from < period.untilExclusive,
  );

export const snapshotSchema: z.ZodType<AccountingSnapshot> = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: z.iso.datetime(),
  organization: z.strictObject({ name: textId }),
  fiscalYear: z.number().int().min(1).max(9999),
  period: periodSchema,
  openingBalanceYen: yen.nullable(),
  entries: z.array(entrySchema),
});

export const definitionSchema: z.ZodType<UniversityReportDefinition> =
  z.strictObject({
    template: z.strictObject({ id: textId, version: textId }),
    categories: z
      .array(
        z.strictObject({
          id: textId,
          name: textId,
          kind,
          sourceCategoryCodes: z.array(textId).min(1),
        }),
      )
      .min(1),
  });
