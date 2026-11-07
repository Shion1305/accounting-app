import type { Draft, DraftStatus, Period } from "./model.ts";
import type { DraftStore } from "./service.ts";

type Row = {
  id: string;
  circle_id: string;
  actor_id: string;
  status: DraftStatus;
  created_at: number;
  finished_at: number | null;
  expires_at: number;
  period_from: string;
  period_to: string;
  model: string;
  response_id: string | null;
  input_ids: string;
  container_ids: string;
  files: string;
  message: string;
  error: string | null;
  usage: string | null;
  cleaned_at: number | null;
};
function decode(row: Row): Draft {
  return {
    id: row.id,
    circleId: row.circle_id,
    actorId: row.actor_id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    from: row.period_from,
    to: row.period_to,
    model: row.model,
    responseId: row.response_id,
    inputIds: JSON.parse(row.input_ids),
    containerIds: JSON.parse(row.container_ids),
    files: JSON.parse(row.files),
    message: row.message,
    error: row.error,
    usage: row.usage ? JSON.parse(row.usage) : null,
    cleanedAt: row.cleaned_at,
  };
}
export function createDraftStore(db: D1Database): DraftStore {
  return {
    async insert(draft) {
      const result = await db
        .prepare(
          `INSERT INTO accounting_exports
        (id, circle_id, actor_id, status, created_at, expires_at, period_from, period_to, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          draft.id,
          draft.circleId,
          draft.actorId,
          draft.status,
          draft.createdAt,
          draft.expiresAt,
          draft.from,
          draft.to,
          draft.model,
        )
        .run();
      return result.meta.changes === 1;
    },
    async get(id, circleId) {
      const row = await db
        .prepare(
          "SELECT * FROM accounting_exports WHERE id = ? AND circle_id = ?",
        )
        .bind(id, circleId)
        .first<Row>();
      return row ? decode(row) : null;
    },
    async save(draft, expected) {
      const clause = expected?.length
        ? ` AND status IN (${expected.map(() => "?").join(",")})`
        : "";
      const result = await db
        .prepare(
          `UPDATE accounting_exports SET status=?, finished_at=?, expires_at=?, response_id=?,
        input_ids=?, container_ids=?, files=?, message=?, error=?, usage=?, cleaned_at=? WHERE id=? AND circle_id=?${clause}`,
        )
        .bind(
          draft.status,
          draft.finishedAt,
          draft.expiresAt,
          draft.responseId,
          JSON.stringify(draft.inputIds),
          JSON.stringify(draft.containerIds),
          JSON.stringify(draft.files),
          draft.message,
          draft.error,
          draft.usage === null ? null : JSON.stringify(draft.usage),
          draft.cleanedAt,
          draft.id,
          draft.circleId,
          ...(expected ?? []),
        )
        .run();
      return result.meta.changes === 1;
    },
    async expired(now) {
      const rows = await db
        .prepare(
          "SELECT * FROM accounting_exports WHERE expires_at <= ? AND cleaned_at IS NULL ORDER BY expires_at LIMIT 50",
        )
        .bind(now)
        .all<Row>();
      return rows.results.map(decode);
    },
    capture: (circleId, period) => captureAccountingData(db, circleId, period),
  };
}

export async function captureAccountingData(
  db: D1Database,
  circleId: string,
  period: Period,
) {
  const organization = await db
    .prepare(
      "SELECT name, university_name AS universityName FROM circles WHERE id=?",
    )
    .bind(circleId)
    .first();
  const filter =
    "circle_id = ? AND (? IS NULL OR occurred_on >= ?) AND (? IS NULL OR occurred_on < ?)";
  const bindings = [
    circleId,
    period.since,
    period.since,
    period.until,
    period.until,
  ];
  type Entry = {
    id: string;
    amount: number;
    description: string;
    occurred_on: number;
    source?: string;
    memo?: string | null;
    title?: string | null;
    payer_name?: string | null;
  };
  const [income, expense] = await db.batch<Entry>([
    db
      .prepare(
        `SELECT id, amount, description, occurred_on FROM income_records WHERE ${filter} ORDER BY occurred_on, id`,
      )
      .bind(...bindings),
    db
      .prepare(
        `SELECT e.id, e.amount, e.description, e.occurred_on, e.source, r.memo, r.title, r.payer_name
      FROM (SELECT * FROM expense_records WHERE ${filter}) e
      LEFT JOIN reimbursement_requests r ON r.id = e.reimbursement_request_id AND r.circle_id = e.circle_id
      ORDER BY e.occurred_on, e.id`,
      )
      .bind(...bindings),
  ]);
  if (!income || !expense) throw new Error("Accounting data could not be read");
  return {
    organization,
    period: {
      from: period.from || null,
      to: period.to || null,
      timeZone: "Asia/Tokyo",
    },
    currency: "JPY",
    missingData:
      "費目・用途・開始残高・購入日など未保存の事実は不明。支出は承認済み立替の反映分を含み、立替申請は別計上していません。",
    entries: [
      ...income.results.map((row) => ({
        id: row.id,
        direction: "income",
        amountYen: row.amount,
        description: row.description,
        recordedDate: new Date(Number(row.occurred_on) * 1000).toISOString(),
        dateSource: "income_records.occurred_on",
      })),
      ...expense.results.map((row) => ({
        id: row.id,
        direction: "expense",
        amountYen: row.amount,
        description: row.description,
        source: row.source,
        reimbursement:
          row.source === "reimbursement"
            ? {
                title: row.title ?? null,
                memo: row.memo ?? null,
                payerName: row.payer_name ?? null,
              }
            : null,
        recordedDate: new Date(Number(row.occurred_on) * 1000).toISOString(),
        dateSource:
          row.source === "reimbursement"
            ? "立替申請日（購入日は未保存）"
            : "expense_records.occurred_on",
      })),
    ],
  };
}
