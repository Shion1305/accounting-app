import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  PRICE_VERSION,
  getModelPrice,
  integerAmount,
  nanoUsdToUsd,
  usdToNanoUsd,
} from "./pricing.ts";
import type { Usage } from "./pricing.ts";

export type Reservation = {
  callId: string;
  runId: string;
  operation: string;
  model?: string;
  reservedNanoUsd: number;
  requestHash: string;
  metadata?: unknown;
};

export type Settlement = {
  usage?: Usage | null;
  responseId?: string;
  providerRequestId?: string;
  status: string;
  estimatedNanoUsd?: number;
  details?: unknown;
};

export type LedgerCall = Reservation & {
  experimentId: string;
  status: string;
  costState: "reserved" | "unknown" | "settled";
  estimatedNanoUsd: number | null;
  usage: Usage | null;
  responseId: string | null;
  providerRequestId: string | null;
  details: unknown;
  duplicateOf: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class DuplicateCallError extends Error {
  constructor(callId: string) {
    super(
      `Call ID already recorded; automatic replay is prohibited: ${callId}`,
    );
    this.name = "DuplicateCallError";
  }
}

function requiredString(value: string, name: string) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a nonempty string`);
  return value;
}

function encode(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function decode(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : null;
}

function callFromRow(row: Record<string, unknown>): LedgerCall {
  return {
    callId: row.call_id as string,
    experimentId: row.experiment_id as string,
    runId: row.run_id as string,
    operation: row.operation as string,
    model: (row.model as string | null) ?? undefined,
    reservedNanoUsd: row.reserved_nano_usd as number,
    requestHash: row.request_hash as string,
    metadata: decode(row.metadata_json),
    status: row.status as string,
    costState: row.cost_state as LedgerCall["costState"],
    estimatedNanoUsd: row.estimated_nano_usd as number | null,
    usage: decode(row.usage_json) as Usage | null,
    responseId: row.response_id as string | null,
    providerRequestId: row.provider_request_id as string | null,
    details: decode(row.details_json),
    duplicateOf: row.duplicate_of as string | null,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
  };
}

/** Append-before-dispatch ledger. Reopening never resubmits unfinished calls. */
export class Ledger {
  readonly experimentId: string;
  readonly budgetNanoUsd: number;
  private db: DatabaseSync;

  constructor(dbPath: string, experimentId: string, budgetUsd: number) {
    this.experimentId = requiredString(experimentId, "experimentId");
    this.budgetNanoUsd = usdToNanoUsd(budgetUsd);
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS evaluation_experiments (
          experiment_id TEXT PRIMARY KEY,
          budget_nano_usd INTEGER NOT NULL CHECK (budget_nano_usd >= 0),
          price_version TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS evaluation_calls (
          call_id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL REFERENCES evaluation_experiments(experiment_id),
          run_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          model TEXT,
          request_hash TEXT NOT NULL,
          metadata_json TEXT,
          reserved_nano_usd INTEGER NOT NULL CHECK (reserved_nano_usd >= 0),
          estimated_nano_usd INTEGER CHECK (estimated_nano_usd >= 0),
          status TEXT NOT NULL,
          cost_state TEXT NOT NULL CHECK (cost_state IN ('reserved', 'unknown', 'settled')),
          usage_json TEXT,
          response_id TEXT,
          provider_request_id TEXT,
          details_json TEXT,
          duplicate_of TEXT REFERENCES evaluation_calls(call_id),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          CHECK (cost_state != 'settled' OR estimated_nano_usd IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS evaluation_calls_experiment ON evaluation_calls(experiment_id);
        CREATE UNIQUE INDEX IF NOT EXISTS evaluation_response_charge
          ON evaluation_calls(response_id)
          WHERE response_id IS NOT NULL AND cost_state = 'settled' AND duplicate_of IS NULL
            AND (model IS NOT NULL OR operation = 'responses');
      `);
      this.transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT budget_nano_usd, price_version FROM evaluation_experiments WHERE experiment_id = ?",
          )
          .get(experimentId);
        if (existing) {
          if (
            existing.budget_nano_usd !== this.budgetNanoUsd ||
            existing.price_version !== PRICE_VERSION
          ) {
            throw new Error(
              "Existing experiment budget or price version differs; use the recorded settings or a new experiment ID",
            );
          }
        } else {
          this.db
            .prepare("INSERT INTO evaluation_experiments VALUES (?, ?, ?, ?)")
            .run(
              experimentId,
              this.budgetNanoUsd,
              PRICE_VERSION,
              new Date().toISOString(),
            );
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCall(callId: string): LedgerCall | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM evaluation_calls WHERE call_id = ? AND experiment_id = ?",
      )
      .get(callId, this.experimentId);
    return row ? callFromRow(row) : undefined;
  }

  reserve(reservation: Reservation): LedgerCall {
    requiredString(reservation.callId, "callId");
    requiredString(reservation.runId, "runId");
    requiredString(reservation.operation, "operation");
    requiredString(reservation.requestHash, "requestHash");
    integerAmount(reservation.reservedNanoUsd, "reservedNanoUsd");
    if (reservation.model) getModelPrice(reservation.model);
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM evaluation_calls WHERE call_id = ?")
          .get(reservation.callId)
      )
        throw new DuplicateCallError(reservation.callId);
      const used = this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN cost_state = 'settled' THEN estimated_nano_usd ELSE reserved_nano_usd END), 0) AS total FROM evaluation_calls WHERE experiment_id = ?`,
        )
        .get(this.experimentId)!.total as number;
      const committed = integerAmount(
        used + reservation.reservedNanoUsd,
        "committed cost",
      );
      if (reservation.reservedNanoUsd > 0 && committed > this.budgetNanoUsd) {
        throw new BudgetExceededError(
          `Budget would be exceeded: ${committed} nanoUSD committed against ${this.budgetNanoUsd} nanoUSD budget`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO evaluation_calls
        (call_id, experiment_id, run_id, operation, model, request_hash, metadata_json, reserved_nano_usd, status, cost_state, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'reserved', ?)`,
        )
        .run(
          reservation.callId,
          this.experimentId,
          reservation.runId,
          reservation.operation,
          reservation.model ?? null,
          reservation.requestHash,
          encode(reservation.metadata),
          reservation.reservedNanoUsd,
          new Date().toISOString(),
        );
      return this.getCall(reservation.callId)!;
    });
  }

  settle(callId: string, settlement: Settlement): LedgerCall {
    requiredString(settlement.status, "status");
    if (settlement.responseId !== undefined)
      requiredString(settlement.responseId, "responseId");
    if (settlement.estimatedNanoUsd !== undefined)
      integerAmount(settlement.estimatedNanoUsd, "estimatedNanoUsd");
    return this.transaction(() => {
      const call = this.getCall(callId);
      if (!call) throw new Error(`No reserved call: ${callId}`);
      if (call.costState === "settled") {
        if (
          call.responseId === (settlement.responseId ?? null) &&
          (call.estimatedNanoUsd === settlement.estimatedNanoUsd ||
            call.duplicateOf !== null)
        )
          return call;
        throw new Error(`Settled call cannot be overwritten: ${callId}`);
      }
      const responseId = settlement.responseId ?? call.responseId;
      const inference =
        call.model !== undefined || call.operation === "responses";
      const canonical =
        inference && responseId
          ? this.db
              .prepare(
                `SELECT call_id FROM evaluation_calls WHERE response_id = ? AND cost_state = 'settled' AND duplicate_of IS NULL AND call_id != ? AND (model IS NOT NULL OR operation = 'responses')`,
              )
              .get(responseId, callId)
          : undefined;
      const modelUsageMissing = inference && settlement.usage == null;
      const known =
        canonical !== undefined ||
        (!modelUsageMissing && settlement.estimatedNanoUsd !== undefined);
      const estimatedNanoUsd = canonical
        ? 0
        : known
          ? settlement.estimatedNanoUsd!
          : null;
      const details = !known
        ? {
            reason: modelUsageMissing
              ? "Model usage missing; reservation retained"
              : "Cost unknown; reservation retained",
            settlement: settlement.details ?? null,
          }
        : settlement.details;
      this.db
        .prepare(
          `UPDATE evaluation_calls SET
        status = ?, cost_state = ?, usage_json = ?, estimated_nano_usd = ?, response_id = ?,
        provider_request_id = ?, details_json = ?, duplicate_of = ?, finished_at = ?
        WHERE call_id = ?`,
        )
        .run(
          settlement.status,
          known ? "settled" : "unknown",
          encode(settlement.usage),
          estimatedNanoUsd,
          responseId,
          settlement.providerRequestId ?? call.providerRequestId,
          encode(details),
          canonical?.call_id ?? null,
          new Date().toISOString(),
          callId,
        );
      if (inference && known && !canonical && responseId) {
        // A recovered response resolves earlier unknown copies without another charge.
        this.db
          .prepare(
            `UPDATE evaluation_calls SET cost_state = 'settled', estimated_nano_usd = 0,
          duplicate_of = ?, finished_at = ? WHERE response_id = ? AND call_id != ? AND cost_state != 'settled'
          AND (model IS NOT NULL OR operation = 'responses')`,
          )
          .run(callId, new Date().toISOString(), responseId, callId);
      }
      return this.getCall(callId)!;
    });
  }

  unknown(callId: string, reason: string): LedgerCall {
    requiredString(reason, "reason");
    return this.transaction(() => {
      const call = this.getCall(callId);
      if (!call) throw new Error(`No reserved call: ${callId}`);
      if (call.costState === "settled") return call;
      this.db
        .prepare(
          "UPDATE evaluation_calls SET status = 'unknown', cost_state = 'unknown', details_json = ?, finished_at = ? WHERE call_id = ?",
        )
        .run(
          encode({ reason, previousDetails: call.details }),
          new Date().toISOString(),
          callId,
        );
      return this.getCall(callId)!;
    });
  }

  summary() {
    const calls = this.db
      .prepare(
        "SELECT * FROM evaluation_calls WHERE experiment_id = ? ORDER BY started_at, rowid",
      )
      .all(this.experimentId)
      .map(callFromRow);
    const aggregate = (rows: LedgerCall[]) => {
      const estimatedNanoUsd = integerAmount(
        rows.reduce((sum, call) => sum + (call.estimatedNanoUsd ?? 0), 0),
        "estimated total",
      );
      const reservedNanoUsd = integerAmount(
        rows.reduce(
          (sum, call) =>
            sum + (call.costState === "settled" ? 0 : call.reservedNanoUsd),
          0,
        ),
        "reserved total",
      );
      return {
        callCount: rows.length,
        settledCount: rows.filter((call) => call.costState === "settled")
          .length,
        pendingCount: rows.filter((call) => call.costState === "reserved")
          .length,
        unknownCount: rows.filter((call) => call.costState === "unknown")
          .length,
        unresolvedCount: rows.filter((call) => call.costState !== "settled")
          .length,
        duplicateCount: rows.filter((call) => call.duplicateOf !== null).length,
        estimatedNanoUsd,
        estimatedUsd: nanoUsdToUsd(estimatedNanoUsd),
        reservedNanoUsd,
        committedNanoUsd: integerAmount(
          estimatedNanoUsd + reservedNanoUsd,
          "committed total",
        ),
      };
    };
    const group = (key: "runId" | "model") =>
      Object.fromEntries(
        [...new Set(calls.map((call) => call[key] ?? "non-model"))].map(
          (value) => [
            value,
            aggregate(
              calls.filter((call) => (call[key] ?? "non-model") === value),
            ),
          ],
        ),
      );
    const totals = aggregate(calls);
    return {
      experimentId: this.experimentId,
      priceVersion: PRICE_VERSION,
      currency: "USD",
      reconciliationStatus: "not_reconciled",
      budgetNanoUsd: this.budgetNanoUsd,
      budgetUsd: nanoUsdToUsd(this.budgetNanoUsd),
      ...totals,
      remainingNanoUsd: Math.max(
        0,
        this.budgetNanoUsd - totals.committedNanoUsd,
      ),
      budgetExceeded: totals.committedNanoUsd > this.budgetNanoUsd,
      byRun: group("runId"),
      byModel: group("model"),
      calls,
    };
  }

  close() {
    this.db.close();
  }
}
