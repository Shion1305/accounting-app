#!/usr/bin/env python3
"""Export a completed, locally recorded PoC without API calls or private traces."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCES = {
    "hosei": "docs/references/hosei.synthetic.reference.xlsx",
    "gakushuin": "docs/references/gakushuin.reference.xlsx",
    "waseda": "docs/references/waseda-2025.reference.xlsx",
    "ritsumeikan": "docs/references/ritsumeikan.reference.xlsx",
}
PRIVATE_KEYS = {
    "responseid", "providerrequestid", "requestid", "callid", "containerid",
    "containerids", "fileid", "fileids", "apikey", "authorization", "token",
    "evidencecalls", "cleanup",
}
PROVIDER_ID = re.compile(r"\b(?:resp_|req_|cntr_|file-)[A-Za-z0-9_-]+\b")
LOCAL_PATH = re.compile(r"(?:/Users/|/private/|/tmp/|/mnt/|/home/)[^\s\"'<>]*")


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def scrub(value):
    """Keep human findings while excluding credentials, provider IDs and paths."""
    if isinstance(value, dict):
        return {
            key: scrub(item) for key, item in value.items()
            if re.sub(r"[^a-z]", "", key.lower()) not in PRIVATE_KEYS
        }
    if isinstance(value, list):
        return [scrub(item) for item in value
                if not (isinstance(item, str) and
                        (item.startswith("calls/") or item.endswith("/response.json")))]
    if isinstance(value, str):
        value = value.replace(str(ROOT) + "/", "")
        value = LOCAL_PATH.sub("<local-path>", value)
        value = PROVIDER_ID.sub("<provider-id>", value)
        value = re.sub(r"\bsk-[A-Za-z0-9_-]+", "<credential>", value)
        return re.sub(r"Bearer\s+\S+", "Bearer <credential>", value)
    return value


def fingerprint(path):
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise ValueError("Evidence files must be regular files inside the repository")
    path = path.resolve()
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
    }


def verify_live_ledger(path, experiment_id, summary):
    """Reject omitted smoke calls and changed settlements, including WAL updates."""
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        config = db.execute(
            "SELECT budget_nano_usd, price_version FROM evaluation_experiments WHERE experiment_id = ?",
            (experiment_id,),
        ).fetchone()
        live = db.execute(
            "SELECT * FROM evaluation_calls WHERE experiment_id = ? ORDER BY call_id",
            (experiment_id,),
        ).fetchall()
    finally:
        db.close()
    if config is None or config["budget_nano_usd"] != summary["budgetNanoUsd"] or config["price_version"] != summary["priceVersion"]:
        raise ValueError("Live ledger settings differ from the report")
    if any(call["cost_state"] != "settled" for call in live):
        raise ValueError("Unresolved live ledger costs prevent a final snapshot")
    fields = {
        "call_id": "callId", "experiment_id": "experimentId", "run_id": "runId",
        "operation": "operation", "model": "model", "request_hash": "requestHash",
        "reserved_nano_usd": "reservedNanoUsd", "estimated_nano_usd": "estimatedNanoUsd",
        "status": "status", "cost_state": "costState", "response_id": "responseId",
        "provider_request_id": "providerRequestId", "duplicate_of": "duplicateOf",
        "started_at": "startedAt", "finished_at": "finishedAt",
        "metadata_json": "metadata", "usage_json": "usage", "details_json": "details",
    }
    reported = {call["callId"]: call for call in summary["calls"]}
    if len(reported) != len(summary["calls"]) or len(live) != summary["callCount"] or {call["call_id"] for call in live} != set(reported):
        raise ValueError("Report is stale: live ledger call identities or count differ")
    for call in live:
        for column, field in fields.items():
            value = call[column]
            if column.endswith("_json") and value is not None:
                value = json.loads(value)
            if value != reported[call["call_id"]].get(field):
                raise ValueError("Report is stale: a live ledger call changed")
    if sum(call["estimated_nano_usd"] for call in live) != summary["estimatedNanoUsd"]:
        raise ValueError("Live ledger cost total differs from the report")


def verify_recorded_hashes(run, directory):
    """Bind saved verdicts to the retained bytes instead of merely rehashing them."""
    source = ROOT / SOURCES[run["university"]]
    checks = [
        ("sourceSha256", source, run.get("sourceSha256")),
        ("inputSha256", directory / "input.json", run.get("inputSha256")),
        ("promptSha256", directory / "prompt.md", run.get("promptSha256")),
        ("outputSha256", directory / "output.xlsx", run.get("outputSha256")),
    ]
    if run.get("repairGuidanceSha256") is not None:
        if run.get("repairGuidance") != "preserve-ooxml":
            raise ValueError("Unknown recorded repair guidance")
        checks.append(("repairGuidanceSha256", HERE / "prompts/preserve-ooxml.md", run["repairGuidanceSha256"]))
    control_hashes = run.get("artifactSha256")
    if control_hashes is not None:
        if not isinstance(control_hashes, dict) or set(control_hashes) - {"unchanged.xlsx", "onecell.xlsx", "control.json"}:
            raise ValueError("Unsupported control artifact hash record")
        checks.extend(("artifactSha256:" + name, directory / name, expected) for name, expected in control_hashes.items())
    evaluation = run.get("evaluation") or {}
    checks.extend([
        ("evaluation.source_sha256", source, evaluation.get("source_sha256")),
        ("evaluation.output_sha256", directory / "output.xlsx", evaluation.get("output_sha256")),
    ])
    verified = []
    for label, path, expected in checks:
        if expected is None:
            continue
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError(f"Invalid recorded hash: {label}")
        if not path.is_file() or fingerprint(path)["sha256"] != expected:
            raise ValueError(f"Recorded evidence hash mismatch: {label}")
        verified.append(label)
    return verified


def verify_csv_rows(headers, csv_rows, json_rows):
    """Match every exported field, preserving null versus observed numeric zero."""
    if not headers or len(headers) != len(set(headers)):
        raise ValueError("CSV report headers are missing or duplicated")
    expected_fields = set().union(*(set(row) for row in json_rows)) - {"estimatedNanoUsd"}
    if json_rows and set(headers) != expected_fields:
        raise ValueError("CSV report columns differ from JSON report fields")
    expected = {row["runId"]: row for row in json_rows}
    actual = {row.get("runId"): row for row in csv_rows}
    if len(expected) != len(json_rows) or len(actual) != len(csv_rows) or set(actual) != set(expected):
        raise ValueError("CSV and JSON report run lists differ")
    for run_id, record in actual.items():
        for name in headers:
            value = expected[run_id].get(name)
            cell = record.get(name)
            if value is None:
                matches = cell == ""
            elif isinstance(value, bool):
                matches = cell == str(value).lower()
            elif isinstance(value, (int, float)):
                try:
                    matches = Decimal(cell) == Decimal(str(value))
                except (InvalidOperation, TypeError):
                    matches = False
            else:
                matches = isinstance(value, str) and cell == value
            if not matches:
                raise ValueError(f"CSV report is stale or inconsistent in field: {name}")


def aggregate(calls):
    result = {
        "apiCalls": len(calls), "inferenceCalls": 0,
        "estimatedNanoUsd": 0, "tokenNanoUsd": 0, "containerNanoUsd": 0,
        "inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
        "cachedInputTokens": 0, "cacheWriteTokens": 0,
        "containerSessions": 0, "missingUsageCalls": 0,
    }
    for call in calls:
        amount = call.get("estimatedNanoUsd")
        if amount is None:
            raise ValueError("A settled call lacks its estimated cost")
        result["estimatedNanoUsd"] += amount
        if call.get("operation") != "response":
            continue
        result["inferenceCalls"] += 1
        if call.get("duplicateOf") is not None:
            continue
        details = call.get("details") or {}
        usage = call.get("usage")
        if usage is None:
            result["missingUsageCalls"] += 1
        else:
            inputs = usage.get("input_tokens_details") or {}
            outputs = usage.get("output_tokens_details") or {}
            for field, count in {
                "inputTokens": usage.get("input_tokens", 0),
                "outputTokens": usage.get("output_tokens", 0),
                "reasoningTokens": outputs.get("reasoning_tokens", 0),
                "cachedInputTokens": inputs.get("cached_tokens", 0),
                "cacheWriteTokens": inputs.get("cache_write_tokens", inputs.get("cache_creation_tokens", 0)),
            }.items():
                result[field] += count
        result["tokenNanoUsd"] += (details.get("usageEstimate") or {}).get("estimatedNanoUsd", 0)
        result["containerNanoUsd"] += details.get("containerNanoUsd", 0)
        result["containerSessions"] += len(set(details.get("containerIds") or []))
    result["otherEstimatedNanoUsd"] = result["estimatedNanoUsd"] - result["tokenNanoUsd"] - result["containerNanoUsd"]
    for field in ("estimated", "token", "container", "otherEstimated"):
        result[field + "Usd"] = result[field + "NanoUsd"] / 1_000_000_000
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", default="initial-evaluation")
    parser.add_argument("--output", default="experiments/llm-export/results/2026-10-12")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,100}", args.experiment):
        parser.error("Invalid experiment identifier")
    experiment = HERE / "runs" / args.experiment
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(HERE / "results"):
        parser.error("Output must be under experiments/llm-export/results")
    report = load(experiment / "report.json")
    ledger = report["summary"]
    rows, runs, calls = report["rows"], report["runs"], ledger["calls"]
    if report["experimentId"] != args.experiment:
        raise ValueError("Report experiment identifier does not match")
    verify_live_ledger(experiment / "ledger.sqlite", args.experiment, ledger)
    if ledger["unresolvedCount"] or ledger["reservedNanoUsd"] or any(call["costState"] != "settled" for call in calls):
        raise ValueError("Unresolved API costs prevent a final snapshot")
    if any(row.get("completionStatus") in ("in_progress", "unknown") or row.get("artifactStatus") in ("started", "unknown", None) for row in rows):
        raise ValueError("Unfinished or unknown run states prevent a final snapshot")
    by_run = {run["runId"]: run for run in runs}
    directories = {}
    for manifest_path in sorted(experiment.glob("*/manifest.json")):
        current = load(manifest_path)
        saved = by_run.get(current["runId"])
        if saved is None or current != saved or current.get("status") == "started":
            raise ValueError("Report is stale; regenerate it after all runs finish")
        directories[current["runId"]] = manifest_path.parent
    if set(directories) != set(by_run):
        raise ValueError("Report run list differs from local manifests")

    def kind(call):
        if call["runId"] in by_run:
            return by_run[call["runId"]].get("kind", "comparison")
        if call["runId"].startswith("smoke-"):
            return "text-smoke"
        return "inventory" if call["operation"] == "models" else "unclassified"

    def model(call):
        return call.get("model") or by_run.get(call["runId"], {}).get("model") or "unattributed"

    def groups(classify):
        return {key: aggregate([call for call in calls if classify(call) == key])
                for key in sorted({classify(call) for call in calls})}

    totals = aggregate(calls)
    if totals["estimatedNanoUsd"] != ledger["estimatedNanoUsd"]:
        raise ValueError("Ledger call costs do not sum to the reported total")
    generated = datetime.now(timezone.utc).isoformat()
    summary = {
        "schemaVersion": 1, "experimentId": args.experiment,
        "snapshotAt": generated, "reportGeneratedAt": report["generatedAt"],
        "currency": ledger["currency"], "priceVersion": ledger["priceVersion"],
        "budgetUsd": ledger["budgetUsd"], "budgetNanoUsd": ledger["budgetNanoUsd"],
        "reservedNanoUsd": ledger["reservedNanoUsd"],
        "remainingNanoUsd": ledger["remainingNanoUsd"],
        "unresolvedCalls": ledger["unresolvedCount"],
        "timeBoundsUtc": {
            "firstCallStartedAt": min((call["startedAt"] for call in calls), default=None),
            "lastCallFinishedAt": max((call["finishedAt"] for call in calls if call.get("finishedAt")), default=None),
        },
        "costAndUsage": totals, "costAndUsageByKind": groups(kind),
        "costAndUsageByModel": groups(model),
        "comparisonMetrics": report["comparisonMetrics"],
        "metricsByModel": report["metricsByModel"],
        "metricsByModelAndUniversity": report["metricsByModelAndUniversity"],
        "reconciliation": report["reconciliation"], "rows": rows,
        "limitations": report["limitations"] + [
            "This snapshot contains estimated charges, not a provider invoice.",
            "A no_artifact outcome means no file was downloaded; it does not establish that no intermediate file was written.",
            "Per-run null costs remain null; a run rejected locally before API dispatch is not an observed zero-cost model generation.",
            "Source and implementation hashes describe snapshot-time files; saved run hashes identify the files used in each trial.",
        ],
    }
    fixed = [HERE / name for name in (
        "prompt.md", "prompts/preserve-ooxml.md", "evaluator.py", "evaluator/expected.json", "gateway/pricing.ts",
        "run.ts", "control.ts", "report.ts", "final-message.ts", "snapshot.py", "preflight.py", "preflight.json",
        "gateway/server.ts", "gateway/client.ts", "gateway/ledger.ts", "control-evaluator.py", "audit-billing.py",
    )]
    fixed += [HERE / "cases" / university / "basic.json" for university in SOURCES]
    fixed += [ROOT / source for source in SOURCES.values()]
    artifacts = []
    for run in runs:
        run_id = run["runId"]
        directory = directories[run_id]
        verified_hashes = verify_recorded_hashes(run, directory)
        files = []
        for name in ("prompt.md", "input.json", "output.xlsx", "unchanged.xlsx", "onecell.xlsx", "control.json"):
            path = directory / name
            if path.is_file():
                files.append(fingerprint(path))
        if run.get("status") == "artifact_downloaded" and not any(item["path"].endswith(".xlsx") for item in files):
            raise ValueError("A downloaded artifact is missing from local evidence")
        if run.get("status") == "artifacts_evaluated" and not all((directory / name).is_file() for name in ("unchanged.xlsx", "onecell.xlsx")):
            raise ValueError("An evaluated control artifact is missing from local evidence")
        artifacts.append({
            "runId": run_id, "kind": run.get("kind", "comparison"),
            "university": run.get("university"), "model": run.get("model"),
            "repairGuidance": run.get("repairGuidance"),
            "artifactStatus": run.get("status"),
            "verifiedRecordedHashes": verified_hashes,
            "recordedHashes": {key: run.get(key) for key in (
                "sourceSha256", "inputSha256", "promptSha256", "repairGuidanceSha256", "outputSha256", "artifactSha256",
            )},
            "files": files,
        })
    evidence = {
        "schemaVersion": 1, "experimentId": args.experiment, "snapshotAt": generated,
        "hashProvenance": {
            "currentFileHashes": "Files as they exist at snapshot time, including the current evaluator and oracle. These are not the evaluator versions at the time of each API run.",
            "runs": "Recorded input/prompt/source/artifact hashes from saved run manifests, alongside hashes of the files currently retained for those runs.",
            "runTimeEvaluatorHashes": "Not recorded by the runner. Oracle corrections and any preserved earlier evaluations document known changes; do not infer an original evaluator version from currentFileHashes.",
        },
        "currentFileHashes": [fingerprint(path) for path in fixed],
        "runs": artifacts,
        "nativeChecks": [{"file": path.name, "sha256": fingerprint(path)["sha256"], "data": load(path)}
                         for path in sorted((experiment / "native-checks").glob("*.json"))],
        "oracleCorrections": load(experiment / "oracle-corrections.json") if (experiment / "oracle-corrections.json").is_file() else None,
        "independentAudit": load(experiment / "independent-audit.json") if (experiment / "independent-audit.json").is_file() else None,
        "billingAudit": {
            "file": "billing-audit.json",
            "sha256": fingerprint(experiment / "billing-audit.json")["sha256"],
            "data": load(experiment / "billing-audit.json"),
        } if (experiment / "billing-audit.json").is_file() else None,
        "markupCompatibilityAudit": {
            "file": "mc-namespace-audit.json",
            "sha256": fingerprint(experiment / "mc-namespace-audit.json")["sha256"],
            "data": load(experiment / "mc-namespace-audit.json"),
        } if (experiment / "mc-namespace-audit.json").is_file() else None,
        "excluded": ["Raw provider requests and responses", "Provider file, container, response and request identifiers", "Credentials and local absolute paths", "Private source workbooks"],
    }
    csv_input = csv.DictReader(io.StringIO((experiment / "results.csv").read_text(encoding="utf-8")))
    csv_rows = list(csv_input)
    verify_csv_rows(csv_input.fieldnames, csv_rows, rows)
    csv_buffer = io.StringIO(newline="")
    writer = csv.DictWriter(csv_buffer, fieldnames=csv_input.fieldnames)
    writer.writeheader()
    writer.writerows(scrub(csv_rows))
    # Validate every input before writing the three shareable outputs.
    verify_live_ledger(experiment / "ledger.sqlite", args.experiment, ledger)
    output.mkdir(parents=True, exist_ok=True)
    for name, value in (("summary.json", summary), ("evidence.json", evidence)):
        (output / name).write_text(json.dumps(scrub(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "results.csv").write_text(csv_buffer.getvalue(), encoding="utf-8")
    print(json.dumps({"experimentId": args.experiment, "output": output.relative_to(ROOT).as_posix(),
                      "runs": len(rows), "estimatedUsd": totals["estimatedUsd"]}))


if __name__ == "__main__":
    main()
