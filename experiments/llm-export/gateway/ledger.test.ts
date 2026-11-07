import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Ledger, BudgetExceededError, DuplicateCallError } from "./ledger.ts";

const usage = {
  input_tokens: 10,
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 1 },
};
const reservation = (callId: string, reservedNanoUsd = 50_000_000) => ({
  callId,
  runId: "run-1",
  operation: "responses",
  model: "gpt-6.1-sol",
  reservedNanoUsd,
  requestHash: `hash-${callId}`,
  metadata: { caseId: "case-1", attempt: 1 },
});

function temporaryDatabase(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "llm-ledger-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "ledger.sqlite");
}

test("reservation is replaced atomically by actual usage, without counting both", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 0.1);
  t.after(() => ledger.close());
  ledger.reserve(reservation("call-1"));
  assert.equal(ledger.summary().committedNanoUsd, 50_000_000);
  const settled = ledger.settle("call-1", {
    status: "completed",
    usage,
    responseId: "resp-1",
    providerRequestId: "req-1",
    estimatedNanoUsd: 40_000,
    details: { rawStatus: "completed" },
  });
  assert.deepEqual(settled.usage, usage);
  assert.equal(settled.providerRequestId, "req-1");
  assert.equal(ledger.summary().reservedNanoUsd, 0);
  assert.equal(ledger.summary().committedNanoUsd, 40_000);
  assert.equal(ledger.summary().byRun["run-1"].estimatedNanoUsd, 40_000);
});

test("budget includes unfinished and unknown calls and rejected reservations do not enter the ledger", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 0.1);
  t.after(() => ledger.close());
  ledger.reserve(reservation("call-1", 60_000_000));
  ledger.unknown("call-1", "socket disconnected after dispatch");
  assert.throws(
    () => ledger.reserve(reservation("call-2", 40_000_001)),
    BudgetExceededError,
  );
  assert.equal(ledger.getCall("call-2"), undefined);
  ledger.reserve(reservation("call-3", 40_000_000));
  assert.equal(ledger.summary().remainingNanoUsd, 0);
  assert.equal(ledger.summary().unknownCount, 1);
  assert.equal(ledger.summary().pendingCount, 1);
});

test("duplicate call IDs never authorize replay, including after close and reopen", (t) => {
  const path = temporaryDatabase(t);
  let ledger = new Ledger(path, "experiment", 1);
  ledger.reserve(reservation("call-1"));
  assert.throws(
    () => ledger.reserve(reservation("call-1")),
    DuplicateCallError,
  );
  ledger.close();
  ledger = new Ledger(path, "experiment", 1);
  t.after(() => ledger.close());
  assert.equal(ledger.summary().reservedNanoUsd, 50_000_000);
  assert.throws(
    () => ledger.reserve(reservation("call-1")),
    DuplicateCallError,
  );
});

test("durable reservation survives abrupt process termination without close", (t) => {
  const path = temporaryDatabase(t);
  const moduleUrl = new URL("./ledger.ts", import.meta.url).href;
  const script = `import { Ledger } from ${JSON.stringify(moduleUrl)};
    const ledger = new Ledger(${JSON.stringify(path)}, 'crashed', 0.1);
    ledger.reserve(${JSON.stringify(reservation("interrupted", 70_000_000))});
    process.kill(process.pid, 'SIGKILL');`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.equal(result.signal, "SIGKILL", result.stderr);
  const recovered = new Ledger(path, "crashed", 0.1);
  t.after(() => recovered.close());
  assert.equal(recovered.getCall("interrupted")?.costState, "reserved");
  assert.equal(recovered.summary().reservedNanoUsd, 70_000_000);
  assert.throws(
    () => recovered.reserve(reservation("next", 30_000_001)),
    BudgetExceededError,
  );
});

test("missing model usage retains the reservation even if caller estimates zero", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  ledger.reserve(reservation("call-1"));
  const result = ledger.settle("call-1", {
    status: "incomplete",
    responseId: "resp-1",
    estimatedNanoUsd: 0,
  });
  assert.equal(result.costState, "unknown");
  assert.equal(result.estimatedNanoUsd, null);
  assert.equal(ledger.summary().reservedNanoUsd, 50_000_000);
  ledger.settle("call-1", {
    status: "incomplete",
    responseId: "resp-1",
    usage,
    estimatedNanoUsd: 40_000,
  });
  assert.equal(ledger.summary().unknownCount, 0);
  assert.equal(ledger.summary().estimatedNanoUsd, 40_000);
});

test("same provider response and repeated settlement are charged once", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  const settlement = {
    status: "completed",
    responseId: "resp-same",
    usage,
    estimatedNanoUsd: 40_000,
  };
  ledger.reserve(reservation("call-1"));
  ledger.settle("call-1", settlement);
  ledger.settle("call-1", settlement);
  ledger.reserve(reservation("call-2"));
  assert.equal(ledger.settle("call-2", settlement).duplicateOf, "call-1");
  assert.equal(ledger.summary().estimatedNanoUsd, 40_000);
  assert.equal(ledger.summary().reservedNanoUsd, 0);
  assert.equal(ledger.summary().duplicateCount, 1);
  assert.throws(
    () => ledger.settle("call-1", { ...settlement, estimatedNanoUsd: 1 }),
    /cannot be overwritten/,
  );
});

test("a free retrieval cannot become the canonical inference charge", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  ledger.reserve({
    ...reservation("retrieve", 0),
    model: undefined,
    operation: "responses.retrieve",
  });
  ledger.settle("retrieve", {
    status: "completed",
    responseId: "resp-same",
    estimatedNanoUsd: 0,
  });
  ledger.reserve(reservation("generation"));
  ledger.settle("generation", {
    status: "completed",
    responseId: "resp-same",
    usage,
    estimatedNanoUsd: 40_000,
  });
  assert.equal(ledger.summary().estimatedNanoUsd, 40_000);
  assert.equal(ledger.summary().duplicateCount, 0);
});

test("recovery of a shared response resolves earlier unknown reservations", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  ledger.reserve(reservation("call-1"));
  ledger.settle("call-1", { status: "incomplete", responseId: "resp-same" });
  ledger.reserve(reservation("retrieval"));
  ledger.settle("retrieval", {
    status: "completed",
    responseId: "resp-same",
    usage,
    estimatedNanoUsd: 40_000,
  });
  assert.equal(ledger.getCall("call-1")?.duplicateOf, "retrieval");
  assert.equal(ledger.summary().committedNanoUsd, 40_000);
  assert.equal(ledger.summary().unresolvedCount, 0);
});

test("two connections share atomic budget checks and recorded experiment settings", (t) => {
  const path = temporaryDatabase(t);
  const first = new Ledger(path, "experiment", 0.1);
  const second = new Ledger(path, "experiment", 0.1);
  t.after(() => {
    first.close();
    second.close();
  });
  first.reserve(reservation("call-1", 60_000_000));
  assert.throws(
    () => second.reserve(reservation("call-2", 50_000_000)),
    BudgetExceededError,
  );
  assert.throws(
    () => new Ledger(path, "experiment", 1),
    /budget or price version differs/,
  );
});

test("free file operations and explicit container charges appear independently of tokens", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  ledger.reserve({
    ...reservation("upload", 0),
    model: undefined,
    operation: "files.create",
  });
  ledger.settle("upload", {
    status: "completed",
    estimatedNanoUsd: 0,
    details: { fileId: "file-1" },
  });
  ledger.reserve({
    ...reservation("container", 30_000_000),
    model: undefined,
    operation: "containers.create",
  });
  ledger.settle("container", {
    status: "completed",
    estimatedNanoUsd: 30_000_000,
    details: { containerId: "cntr-1", memory: "1g" },
  });
  assert.equal(ledger.summary().estimatedNanoUsd, 30_000_000);
  assert.equal(ledger.summary().byModel["non-model"].callCount, 2);
});

test("an unexpectedly high settled charge is preserved and blocks further spending", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 0.01);
  t.after(() => ledger.close());
  ledger.reserve(reservation("call-1", 1_000_000));
  ledger.settle("call-1", {
    status: "incomplete",
    usage,
    estimatedNanoUsd: 20_000_000,
  });
  assert.equal(ledger.summary().budgetExceeded, true);
  assert.equal(ledger.summary().estimatedNanoUsd, 20_000_000);
  assert.throws(
    () => ledger.reserve(reservation("call-2", 1)),
    BudgetExceededError,
  );
  ledger.reserve({
    ...reservation("cleanup", 0),
    model: undefined,
    operation: "files.delete",
  });
  ledger.settle("cleanup", { status: "completed", estimatedNanoUsd: 0 });
  assert.equal(ledger.getCall("cleanup")?.costState, "settled");
});

test("invalid amounts and unknown models are rejected before a call is reserved", (t) => {
  const ledger = new Ledger(temporaryDatabase(t), "experiment", 1);
  t.after(() => ledger.close());
  assert.throws(
    () => ledger.reserve(reservation("negative", -1)),
    /nonnegative/,
  );
  assert.throws(
    () =>
      ledger.reserve({ ...reservation("unknown"), model: "unpriced-model" }),
    /registered price/,
  );
  assert.equal(ledger.summary().callCount, 0);
});
