#!/usr/bin/env python3
"""Inventory saved LLM traces without API calls, execution, or history changes."""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re
import sys


HERE = Path(__file__).resolve().parent
MODELS = {"gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"}
UNIVERSITIES = {"gakushuin", "hosei", "ritsumeikan", "waseda"}
KINDS = {"comparison", "repair", "control"}
STATUSES = {"completed", "incomplete", "failed", "in_progress", "queued", "cancelled"}
HASH_FIELDS = ("sourceSha256", "inputSha256", "promptSha256", "repairGuidanceSha256")
VERDICT_FIELDS = {
    "artifactStatus": {"artifact_downloaded", "artifacts_evaluated", "no_artifact", "failed"},
    "completionStatus": {"complete", "incomplete", "no_response", "no_final_message", "control_evaluated"},
    "evaluationStatus": {"pass", "fail", "not_evaluated", "unverified"},
    "factsStatus": {"pass", "fail", "not_evaluated", "unverified"},
    "structureStatus": {"pass", "fail", "not_evaluated", "unverified"},
}
# Only class names are emitted. Arbitrary exception messages can contain secrets.
EXCEPTION = re.compile(
    r"(?:^|\s|repr[=:]\s*)(ModuleNotFoundError|ImportError|FileNotFoundError|"
    r"PermissionError|NameError|AttributeError|TypeError|ValueError|KeyError|"
    r"IndexError|SyntaxError|ParseError|XMLSyntaxError|AssertionError|"
    r"RuntimeError|MemoryError|TimeoutError|CalledProcessError|BadZipFile)(?=[:(])"
)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
METHOD = [
    "Empty outputs do not establish an execution error.",
    "A completed code call does not establish successful Python execution.",
    "Log character counts are not billable token counts.",
    "Diagnostic class matching is a bounded textual signal, not causal classification.",
    "Historical CSV verdicts are preserved; this inventory does not re-evaluate artifacts.",
    "Request hashes are recorded manifest values; source bytes are not revalidated here.",
    "Smoke inventory uses saved cost-summary.json and has no per-call trace analysis.",
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def object_value(value):
    require(isinstance(value, dict), "Expected a JSON object")
    return value


def enum(value, allowed, field, optional=False):
    if optional and value in (None, ""):
        return None
    require(isinstance(value, str) and value in allowed, "Invalid " + field)
    return value


def integer(value, field, optional=False):
    if optional and value is None:
        return None
    require(type(value) is int and value >= 0, "Invalid " + field)
    return value


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "Expected a regular JSON file")
    try:
        return object_value(json.loads(path.read_text(encoding="utf-8")))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("Malformed JSON input") from None


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def stable_label(record):
    kind = enum(record.get("kind"), KINDS, "kind")
    model = enum(record.get("model"), MODELS, "model")
    university = enum(record.get("university"), UNIVERSITIES, "university")
    repeat = record.get("repeat")
    if repeat in (None, ""):
        require(kind == "control", "Missing repeat")
        repeat = None
    else:
        if isinstance(repeat, str):
            require(bool(re.fullmatch(r"[1-9][0-9]*", repeat)), "Invalid repeat")
            repeat = int(repeat)
        integer(repeat, "repeat")
        require(repeat > 0, "Invalid repeat")
    return {"kind": kind, "model": model, "university": university, "repeat": repeat}


def label_key(label):
    return tuple(label[k] for k in ("kind", "model", "university", "repeat"))


def load_csv(path):
    require(path.is_file() and not path.is_symlink(), "Expected a regular results CSV")
    with path.open(encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file)
        fields = reader.fieldnames or []
        needed = {"runId", "kind", "model", "university", "repeat", "finalMessagePresent",
                  "responseStatus", "outputTokens", "reasoningTokens", "incompleteReason", *VERDICT_FIELDS}
        require(len(fields) == len(set(fields)) and needed <= set(fields), "Malformed CSV headers")
        result = {}
        for row in reader:
            require(None not in row and all(v is not None for v in row.values()), "Malformed CSV row")
            key = row["runId"]
            require(bool(key) and key not in result, "Duplicate or missing CSV run identity")
            stable_label(row)
            result[key] = row
    require(bool(result), "No saved CSV rows")
    return result


def historical_verdict(row):
    result = {key: enum(row.get(key), values, key, optional=True)
              for key, values in VERDICT_FIELDS.items()}
    result["finalMessagePresent"] = enum(row.get("finalMessagePresent"), {"true", "false"},
                                         "finalMessagePresent", optional=True)
    if result["finalMessagePresent"] is not None:
        result["finalMessagePresent"] = result["finalMessagePresent"] == "true"
    result["completeAndStaticPass"] = (
        result["completionStatus"] == "complete" and result["evaluationStatus"] == "pass"
    )
    return result


def usage_inventory(usage):
    usage = object_value(usage)
    output = integer(usage.get("output_tokens"), "output tokens")
    details = object_value(usage.get("output_tokens_details") or {})
    reasoning = integer(details.get("reasoning_tokens"), "reasoning tokens", optional=True)
    require(reasoning is None or reasoning <= output, "Reasoning exceeds output tokens")
    return {"outputTokens": output, "reasoningTokens": reasoning}


def call_inventory(call, ordinal):
    code = call.get("code")
    require(isinstance(code, str), "Code must be text")
    status = enum(call.get("status"), STATUSES, "code call status")
    outputs = call.get("outputs")
    require(isinstance(outputs, list), "Code outputs must be a list")
    logs = []
    output_types = Counter()
    for output in outputs:
        output = object_value(output)
        kind = enum(output.get("type"), {"logs", "image"}, "code output type")
        output_types[kind] += 1
        if kind == "logs":
            require(isinstance(output.get("logs"), str), "Logs must be text")
            logs.append(output["logs"])
    diagnostic_classes = Counter()
    for log in logs:
        for line in ANSI.sub("", log).splitlines():
            # Bound scanning and expose only a class name from our explicit allowlist.
            match = EXCEPTION.search(line[:1000])
            if match:
                diagnostic_classes[match.group(1)] += 1
    return {
        "ordinal": ordinal,
        "status": status,
        "codeSha256": sha256(code.encode()),
        "codeChars": len(code),
        "outputTypes": dict(sorted(output_types.items())),
        "emptyOutputs": not outputs,
        "blankLogsPresent": bool(logs) and all(not log.strip() for log in logs),
        "logChars": sum(map(len, logs)),
        "diagnosticClasses": dict(sorted(diagnostic_classes.items())),
    }


def trace_inventory(manifest, response, row, raw_response):
    outputs = response.get("output")
    require(isinstance(outputs, list), "Response output must be a list")
    calls = []
    for output in outputs:
        output = object_value(output)
        require(isinstance(output.get("type"), str), "Response output type missing")
        if output["type"] == "code_interpreter_call":
            calls.append(call_inventory(output, len(calls) + 1))
    incomplete = response.get("incomplete_details")
    reason = None if incomplete is None else enum(
        object_value(incomplete).get("reason"), {"max_output_tokens", "content_filter"}, "incomplete reason"
    )
    status = enum(response.get("status"), STATUSES, "response status")
    require(row["responseStatus"] == status, "CSV response status mismatch")
    require(row["incompleteReason"] == (reason or ""), "CSV incomplete reason mismatch")
    usage = usage_inventory(response.get("usage"))
    for field in ("outputTokens", "reasoningTokens"):
        expected = "" if usage[field] is None else str(usage[field])
        require(row[field] == expected, "CSV token usage mismatch")
    if row["completionStatus"] == "complete":
        require(status == "completed" and row["finalMessagePresent"] == "true",
                "Inconsistent historical completion")
    if manifest.get("responseStatus") is not None:
        require(manifest["responseStatus"] == status, "Manifest response status mismatch")
    hashes = {}
    for key in HASH_FIELDS:
        value = manifest.get(key)
        require(value is None or isinstance(value, str) and bool(re.fullmatch(r"[a-f0-9]{64}", value)),
                "Invalid recorded hash")
        hashes[key] = value
    max_tokens = integer(response.get("max_output_tokens"), "max output tokens", optional=True)
    if "maxOutputTokens" in manifest:
        require(manifest["maxOutputTokens"] == max_tokens, "Request token setting mismatch")
    reasoning = object_value(response.get("reasoning") or {})
    effort = enum(reasoning.get("effort"), {"none", "minimal", "low", "medium", "high", "xhigh"},
                  "reasoning effort", optional=True)
    if "reasoningEffort" in manifest:
        require(manifest["reasoningEffort"] == effort, "Reasoning setting mismatch")
    diagnostic = Counter()
    for call in calls:
        diagnostic.update(call["diagnosticClasses"])
    return {
        **stable_label(manifest),
        "request": {"maxOutputTokens": max_tokens, "reasoningEffort": effort,
                    "serviceTier": enum(response.get("service_tier"),
                                        {"auto", "default", "flex", "priority", "scale"},
                                        "service tier", optional=True), "recordedHashes": hashes},
        "responseSha256": sha256(raw_response),
        "responseStatus": status,
        "incompleteReason": reason,
        **usage,
        "historical": historical_verdict(row),
        "codeCallCount": len(calls),
        "codeCallStatuses": dict(sorted(Counter(c["status"] for c in calls).items())),
        "emptyOutputsCount": sum(c["emptyOutputs"] for c in calls),
        "blankLogsPresentCount": sum(c["blankLogsPresent"] for c in calls),
        "totalLogChars": sum(c["logChars"] for c in calls),
        "maxCallLogChars": max((c["logChars"] for c in calls), default=0),
        "diagnosticClasses": dict(sorted(diagnostic.items())),
        "calls": calls,
    }


def aggregates(records):
    groups = {}
    for record in records:
        group = groups.setdefault((record["kind"], record["model"]), [])
        group.append(record)
    return [{
        "kind": kind, "model": model, "runs": len(rows),
        "responseStatuses": dict(sorted(Counter(r["responseStatus"] for r in rows).items())),
        "staticPass": sum(r["historical"]["evaluationStatus"] == "pass" for r in rows),
        "completeAndStaticPass": sum(r["historical"]["completeAndStaticPass"] for r in rows),
        "maxOutputStops": sum(r["incompleteReason"] == "max_output_tokens" for r in rows),
        **{key: sum(r[key] for r in rows) for key in (
            "codeCallCount", "emptyOutputsCount", "blankLogsPresentCount", "totalLogChars", "outputTokens")},
        "reasoningTokens": (sum(r["reasoningTokens"] for r in rows)
                            if all(r["reasoningTokens"] is not None for r in rows) else None),
    } for (kind, model), rows in sorted(groups.items())]


def smoke_inventory(base):
    path = base / "cost-summary.json"
    if not path.exists():
        return {"available": False, "runs": []}
    summary = read_json(path)
    calls = summary.get("calls")
    require(isinstance(calls, list), "Malformed cost summary")
    result = []
    for call in calls:
        call = object_value(call)
        run_id = call.get("runId", "")
        require(isinstance(run_id, str), "Malformed cost run identity")
        if call.get("operation") == "response" and run_id.startswith("smoke"):
            result.append({"model": enum(call.get("model"), MODELS, "smoke model"),
                           "responseStatus": enum(call.get("status"), STATUSES, "smoke status"),
                           **usage_inventory(call.get("usage"))})
    return {"available": True, "runs": sorted(result, key=lambda r: (r["model"], r["outputTokens"]))}


def build_inventory(base):
    require(base.is_dir() and not base.is_symlink(), "Experiment directory unavailable")
    rows = load_csv(base / "results.csv")
    seen_ids, seen_labels, excluded_labels = set(), set(), set()
    records, excluded = [], []
    for directory in sorted(base.iterdir()):
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            require(not (directory / "response.json").exists(), "Response without manifest")
            continue
        require(directory.is_dir() and not directory.is_symlink(), "Invalid run directory")
        manifest = read_json(manifest_path)
        label = stable_label(manifest)
        run_id = manifest.get("runId")
        require(isinstance(run_id, str) and run_id in rows and run_id not in seen_ids,
                "Unmatched or duplicate manifest identity")
        row = rows[run_id]
        require(label == stable_label(row), "CSV and manifest labels differ")
        seen_ids.add(run_id)
        response_path = directory / "response.json"
        if not response_path.exists():
            require(label["kind"] == "control" and manifest.get("status") == "failed",
                    "Missing response outside a failed control")
            require(label_key(label) not in excluded_labels, "Duplicate excluded stable label")
            excluded_labels.add(label_key(label))
            excluded.append({**label, "reason": "control_without_response", "historical": historical_verdict(row)})
            continue
        key = label_key(label)
        require(key not in seen_labels, "Duplicate stable response label")
        seen_labels.add(key)
        response = read_json(response_path)
        require(response.get("model") == label["model"], "Response model mismatch")
        records.append(trace_inventory(manifest, response, row, response_path.read_bytes()))
    require(seen_ids == set(rows), "CSV has unmatched saved runs")
    records.sort(key=lambda r: tuple(str(v) for v in label_key(r)))
    return {"schemaVersion": 1, "methodCaveats": METHOD, "runs": records,
            "aggregates": aggregates(records), "excluded": excluded, "smoke": smoke_inventory(base)}


def write_inventory(path, inventory, history_root):
    require(not path.resolve().is_relative_to(history_root.resolve()), "Output cannot be inside saved history")
    require(not path.is_symlink(), "Output cannot be a symlink")
    # Exclusive creation also prevents hard-link and accidental overwrite damage.
    with path.open("x", encoding="utf-8") as file:
        json.dump(inventory, file, ensure_ascii=False, indent=2, allow_nan=False)
        file.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        require(bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", args.experiment)), "Invalid experiment label")
        inventory = build_inventory(HERE / "runs" / args.experiment)
        write_inventory(args.output, inventory, HERE / "runs")
    except (ValueError, OSError, UnicodeError, TypeError):
        # Input exceptions may contain raw paths/content. Never print them.
        print("Trace inventory failed: malformed or inconsistent input, or unsafe/unavailable output.", file=sys.stderr)
        return 1
    print(json.dumps({"runs": len(inventory["runs"]), "excluded": len(inventory["excluded"]),
                      "smokeRuns": len(inventory["smoke"]["runs"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
