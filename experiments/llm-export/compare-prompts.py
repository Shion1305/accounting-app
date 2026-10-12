#!/usr/bin/env python3
"""Audit/export the fixed Sol prompt comparison offline without changing history.

Reads saved traces, reports and a read-only SQLite snapshot. Recomputes costs
independently of gateway code. Public output contains no raw IDs, paths or logs.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import closing
import csv
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import statistics
import sys


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MODEL = "gpt-6.1-sol"
PRICE_VERSION = "openai-standard-2026-10-12"
BUDGET = 3_500_000_000
ARMS = {
    "baseline": ("sol-prompt-baseline-2026-10-12", "baseline"),
    "improved": ("sol-prompt-improved-2026-10-12", "avoid-editing-pitfalls"),
}
SOURCES = {
    "ritsumeikan": "ritsumeikan.reference.xlsx",
    "gakushuin": "gakushuin.reference.xlsx",
    "hosei": "hosei.synthetic.reference.xlsx",
    "waseda": "waseda-2025.reference.xlsx",
}
VERDICTS = {"pass", "fail", "unverified", "not_evaluated"}
WARNINGS = [
    "Costs are usage-based estimates, not reconciled provider invoices.",
    "Local dispatch budgets are not provider billing hard caps.",
    "Container fees assume one initial 20-minute session per observed unique 1GB container.",
    "Known templates and repeated cases do not establish unseen-template performance.",
    "Empty outputs and code-call counts are not error counts; log characters are not tokens.",
    "Cached-input differences can affect observed costs independently of editing efficiency.",
    "Stored static verdicts are audited, not redefined; native Excel behavior is separate.",
    "Run duration includes upload, response, download and local evaluation, but excludes cleanup.",
]


class AuditError(ValueError):
    """Messages are fixed diagnostic codes, never untrusted input content."""


def check(condition, code):
    if not condition:
        raise AuditError(code)


def obj(value):
    check(isinstance(value, dict), "expected_object")
    return value


def integer(value):
    check(type(value) is int and 0 <= value <= 2**53 - 1, "invalid_integer")
    return value


def identifier(value):
    check(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value), "invalid_identity")
    return value


def read_bytes(path):
    check(path.is_file() and not path.is_symlink(), "missing_or_symlink_file")
    return path.read_bytes()


def read_json(path):
    return obj(json.loads(read_bytes(path)))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def timestamp(value):
    check(isinstance(value, str), "missing_timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    check(result.utcoffset() is not None, "timezone_missing")
    return result


def calculate_usage(usage):
    usage = obj(usage)
    inputs, outputs = integer(usage.get("input_tokens")), integer(usage.get("output_tokens"))
    incoming = obj(usage.get("input_tokens_details"))
    outgoing = obj(usage.get("output_tokens_details"))
    cached = integer(incoming.get("cached_tokens"))
    writes = integer(incoming.get("cache_write_tokens", incoming.get("cache_creation_tokens")))
    if "cache_write_tokens" in incoming and "cache_creation_tokens" in incoming:
        check(incoming["cache_write_tokens"] == incoming["cache_creation_tokens"], "cache_alias_conflict")
    reasoning = integer(outgoing.get("reasoning_tokens"))
    uncached = inputs - cached - writes
    check(uncached >= 0 and reasoning <= outputs, "usage_components_invalid")
    check(inputs <= 100_000 and outputs <= 8000, "usage_outside_priced_bounds")
    check(usage.get("total_tokens", inputs + outputs) == inputs + outputs, "usage_total_invalid")
    # USD/million = 2 uncached, .1 cached, 2.5 cache write, 10 output.
    cost = uncached * 2000 + cached * 100 + writes * 2500 + outputs * 10000
    return {
        "inputTokens": inputs, "outputTokens": outputs, "reasoningTokens": reasoning,
        "cachedInputTokens": cached, "cacheWriteTokens": writes,
        "uncachedInputTokens": uncached, "tokenNanoUsd": cost,
    }


def qualifying_final(response):
    return any(
        item.get("type") == "message"
        and (item.get("phase") == "final_answer" or item.get("phase") is None and response.get("status") == "completed")
        and (item.get("status") == "completed" or item.get("status") is None and response.get("status") == "completed")
        and any(part.get("type") == "output_text" and isinstance(part.get("text"), str) and part["text"].strip()
                for part in item.get("content", []))
        for item in response.get("output", [])
    )


def trace_metrics(response):
    calls = [item for item in response["output"] if item.get("type") == "code_interpreter_call"]
    logs = []
    for call in calls:
        check(isinstance(call.get("outputs"), list), "malformed_tool_outputs")
        for output in call["outputs"]:
            check(output.get("type") in {"logs", "image"}, "unexpected_tool_output")
            if output["type"] == "logs":
                check(isinstance(output.get("logs"), str), "malformed_tool_log")
                logs.append(output["logs"])
    containers = {identifier(call.get("container_id")) for call in calls}
    check(len(containers) <= 1, "multiple_containers_in_one_response")
    return {
        "codeCalls": len(calls), "emptyOutputs": sum(not call["outputs"] for call in calls),
        "logChars": sum(map(len, logs)), "containers": len(containers),
    }, containers


def read_ledger(base, experiment):
    path = base / "ledger.sqlite"
    read_bytes(path)  # Check file type before opening SQLite in read-only mode.
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        configs = [dict(row) for row in db.execute("SELECT * FROM evaluation_experiments")]
        rows = [dict(row) for row in db.execute("SELECT * FROM evaluation_calls ORDER BY started_at, rowid")]
        db.rollback()
    check(len(configs) == 1 and configs[0]["experiment_id"] == experiment, "ledger_experiment_mismatch")
    check(configs[0]["budget_nano_usd"] == BUDGET and configs[0]["price_version"] == PRICE_VERSION, "ledger_budget_or_price_mismatch")
    check(all(row["experiment_id"] == experiment and row["cost_state"] == "settled" and row["duplicate_of"] is None for row in rows), "unresolved_or_duplicate_ledger_call")
    return rows


def saved_reports(base, ledger_rows, experiment):
    summary = read_json(base / "cost-summary.json")
    report = read_json(base / "report.json")
    check(report.get("summary") == summary, "report_cost_summary_mismatch")
    check(report.get("experimentId") == experiment and summary.get("experimentId") == experiment, "report_experiment_mismatch")
    total = sum(integer(row["estimated_nano_usd"]) for row in ledger_rows)
    check(total <= BUDGET and summary.get("estimatedNanoUsd") == total, "ledger_summary_total_mismatch")
    check(summary.get("budgetNanoUsd") == BUDGET and summary.get("priceVersion") == PRICE_VERSION, "summary_budget_or_price_mismatch")
    check(summary.get("unresolvedCount") == 0 and summary.get("reservedNanoUsd") == 0, "summary_unresolved")
    check(summary.get("callCount") == len(ledger_rows), "summary_call_count_mismatch")
    exported = {identifier(call["callId"]): call for call in summary["calls"]}
    check(len(exported) == len(ledger_rows), "duplicate_summary_call")
    for row in ledger_rows:
        call = exported.get(row["call_id"], {})
        check(call.get("runId") == row["run_id"] and call.get("operation") == row["operation"]
              and call.get("costState") == "settled" and call.get("estimatedNanoUsd") == row["estimated_nano_usd"], "summary_call_mismatch")
    rows = {identifier(row["runId"]): row for row in report["rows"]}
    check(len(rows) == len(report["rows"]), "duplicate_report_run")
    with (base / "results.csv").open(encoding="utf-8", newline="") as file:
        check(not (base / "results.csv").is_symlink(), "csv_symlink")
        csv_rows = list(csv.DictReader(file))
    csv_by_id = {identifier(row["runId"]): row for row in csv_rows}
    check(len(csv_by_id) == len(csv_rows) and set(rows) == set(csv_by_id), "csv_report_run_mismatch")
    return summary, rows, csv_by_id


def read_call_logs(base, ledger_rows, provider_ids=None):
    expected = {identifier(row["call_id"]) for row in ledger_rows}
    for suffix in ("request", "response"):
        observed = {path.name.removesuffix(f".{suffix}.json") for path in (base / "calls").glob(f"*.{suffix}.json")}
        check(observed == expected, "gateway_log_inventory_mismatch")
    result = {}
    provider_ids = provider_ids if provider_ids is not None else set()
    for row in ledger_rows:
        call_id = row["call_id"]
        request = read_json(base / "calls" / f"{call_id}.request.json")
        response = read_json(base / "calls" / f"{call_id}.response.json")
        check(request.get("callId") == response.get("callId") == call_id, "gateway_call_identity_mismatch")
        check(request.get("runId") == row["run_id"] and request.get("operation") == row["operation"], "gateway_run_operation_mismatch")
        check(digest(canonical({"operation": row["operation"], "runId": row["run_id"], "data": request["data"]})) == row["request_hash"], "gateway_request_hash_mismatch")
        provider_id = identifier(row["provider_request_id"])
        check(provider_id == response.get("providerRequestId") and provider_id not in provider_ids, "provider_request_identity_mismatch")
        provider_ids.add(provider_id)
        check(200 <= integer(response.get("httpStatus")) < 300, "gateway_http_failure")
        result[call_id] = (request["data"], obj(response["body"]))
    return result


def compare_csv(row, csv_row, fields):
    for field in fields:
        value = row[field]
        if isinstance(value, float) and value.is_integer():
            value = int(value)  # JavaScript writes 1, not 1.0, to the CSV.
        expected = "" if value is None else str(value).lower() if isinstance(value, bool) else str(value)
        check(csv_row.get(field) == expected, "csv_report_value_mismatch")


def audit_arm(arm, repeats, repo_root=ROOT, history_root=None, seen=None):
    history_root = history_root or repo_root / "experiments/llm-export/runs"
    experiment, variant = ARMS[arm]
    base = history_root / experiment
    check(base.is_dir() and not base.is_symlink(), "missing_or_symlink_experiment")
    ledger = read_ledger(base, experiment)
    summary, reports, csv_rows = saved_reports(base, ledger, experiment)
    seen = seen if seen is not None else {}
    logs = read_call_logs(base, ledger, seen.setdefault("providerRequests", set()))
    common = read_bytes(repo_root / "experiments/llm-export/prompt.md")
    baseline = common + "\n対象データ: input.json。元の書式: template.xlsx。\n".encode()
    guidance = None
    if arm == "improved":
        document = read_bytes(repo_root / "experiments/llm-export/prompts/avoid-editing-pitfalls.md")
        marker = re.search(rb"^---\r?\n", document, re.M)
        check(marker is not None, "candidate_separator_missing")
        guidance = document[marker.end():]
        check(guidance.strip(), "candidate_body_empty")
    prompt = baseline if guidance is None else baseline + b"\n" + guidance
    expected_labels = {(university, repeat) for university in SOURCES for repeat in range(1, repeats + 1)}
    labels, run_ids = set(), set()
    responses_seen = seen.setdefault("responses", set())
    containers_seen = seen.setdefault("containers", set())
    uploads_seen = seen.setdefault("uploads", set())
    public, order = [], []
    for path in sorted(base.glob("*/manifest.json")):
        check(not path.parent.is_symlink(), "run_directory_symlink")
        manifest = read_json(path)
        run_id = identifier(manifest.get("runId"))
        university, repeat = manifest.get("university"), integer(manifest.get("repeat"))
        label = (university, repeat)
        check(label in expected_labels and label not in labels and run_id not in run_ids, "unexpected_or_duplicate_run")
        labels.add(label)
        run_ids.add(run_id)
        check(manifest.get("kind") == "comparison" and manifest.get("model") == MODEL, "run_kind_or_model_mismatch")
        check(manifest.get("promptVariant") == variant and manifest.get("repairGuidance") is None, "prompt_variant_mismatch")
        check(manifest.get("maxOutputTokens") == 8000 and manifest.get("reasoningEffort") == "medium" and manifest.get("serviceTier") == "default", "manifest_settings_mismatch")
        check(manifest.get("sourceUnchanged") is True, "source_changed_during_run")
        source = read_bytes(repo_root / "docs/references" / SOURCES[university])
        saved_input = read_bytes(path.parent / "input.json")
        check(saved_input == read_bytes(repo_root / "experiments/llm-export/cases" / university / "basic.json"), "case_bytes_changed")
        check(read_bytes(path.parent / "prompt.md") == prompt, "saved_prompt_composition_mismatch")
        hashes = {"sourceSha256": digest(source), "inputSha256": digest(saved_input), "promptSha256": digest(prompt)}
        check(all(manifest.get(key) == value for key, value in hashes.items()), "manifest_input_hash_mismatch")
        check(manifest.get("promptVariantGuidanceSha256") == (None if guidance is None else digest(guidance)), "guidance_hash_mismatch")
        response_bytes = read_bytes(path.parent / "response.json")
        response = obj(json.loads(response_bytes))
        check(response.get("model") == MODEL and response.get("max_output_tokens") == 8000
              and response.get("reasoning", {}).get("effort") == "medium"
              and response.get("service_tier") == "default", "response_settings_mismatch")
        status = response.get("status")
        check(status in {"completed", "incomplete", "failed", "cancelled"} and manifest.get("responseStatus") == status, "response_status_mismatch")
        incomplete_details = response.get("incomplete_details")
        incomplete_reason = None if incomplete_details is None else obj(incomplete_details).get("reason")
        check(incomplete_reason in {None, "max_output_tokens", "content_filter"}, "invalid_incomplete_reason")
        response_id = identifier(response.get("id"))
        check(response_id == manifest.get("responseId") and response_id not in responses_seen, "response_identity_mismatch")
        responses_seen.add(response_id)
        usage = calculate_usage(response["usage"])
        check(manifest.get("usage") == response["usage"], "manifest_usage_mismatch")
        trace, containers = trace_metrics(response)
        check(not containers & containers_seen, "container_reused_across_runs")
        containers_seen.update(containers)
        cost = usage["tokenNanoUsd"] + len(containers) * 30_000_000
        calls = [row for row in ledger if row["run_id"] == run_id]
        inference = [row for row in calls if row["operation"] == "response"]
        check(len(inference) == 1, "paid_response_count_mismatch")
        paid = inference[0]
        request, raw_response = logs[paid["call_id"]]
        check(raw_response == response and request.get("input") == prompt.decode(), "raw_response_or_prompt_mismatch")
        check(request.get("model") == MODEL and request.get("max_output_tokens") == 8000
              and request.get("reasoning") == {"effort": "medium"} and request.get("service_tier") == "default"
              and request.get("stream") is False and request.get("store") is True, "request_settings_mismatch")
        tools = request.get("tools")
        check(isinstance(tools, list) and len(tools) == 1 and tools[0].get("type") == "code_interpreter", "request_tool_mismatch")
        config = tools[0].get("container", {})
        check(config.get("type") == "auto" and config.get("memory_limit") == "1g" and config.get("network_policy") == {"type": "disabled"}, "request_container_mismatch")
        details = obj(json.loads(paid["details_json"]))
        check(json.loads(paid["usage_json"]) == response["usage"] and paid["response_id"] == response_id
              and paid["model"] == MODEL and paid["estimated_nano_usd"] == cost, "ledger_response_cost_mismatch")
        check(set(details.get("containerIds", [])) == containers and details.get("containerNanoUsd") == len(containers) * 30_000_000
              and details.get("usageEstimate", {}).get("estimatedNanoUsd") == usage["tokenNanoUsd"], "ledger_cost_components_mismatch")
        uploaded, deleted, downloads = {}, {}, []
        for call in calls:
            operation = call["operation"]
            data, body = logs[call["call_id"]]
            if operation == "response":
                continue
            check(call["estimated_nano_usd"] == 0, "non_inference_cost_nonzero")
            if operation == "upload":
                filename = data.get("fileName")
                check(filename in {"template.xlsx", "input.json"} and filename not in uploaded, "upload_set_mismatch")
                check(base64.b64decode(data["base64"], validate=True) == (source if filename == "template.xlsx" else saved_input), "uploaded_bytes_mismatch")
                file_id = identifier(body.get("id"))
                check(file_id not in uploads_seen, "duplicate_upload_identity")
                uploads_seen.add(file_id)
                uploaded[filename] = file_id
            elif operation in {"deleteContainer", "deleteFile"}:
                key = ("container" if operation == "deleteContainer" else "file", identifier(data.get("containerId" if operation == "deleteContainer" else "fileId")))
                check(key not in deleted and body.get("deleted") is not False, "cleanup_failed_or_duplicate")
                deleted[key] = call
            elif operation == "download":
                check(data.get("containerId") in containers, "download_container_mismatch")
                downloads.append(digest(base64.b64decode(body["base64"], validate=True)))
            else:
                check(operation == "containerFiles" and data.get("containerId") in containers, "unexpected_api_operation")
        check(set(uploaded) == {"template.xlsx", "input.json"} and set(config.get("file_ids", [])) == set(uploaded.values()), "request_uploads_mismatch")
        expected_cleanup = {("container", item) for item in containers} | {("file", item) for item in uploaded.values()}
        check(set(deleted) == expected_cleanup, "cleanup_inventory_mismatch")
        cleanup = manifest.get("cleanup", [])
        check(len(cleanup) == len(expected_cleanup) and all(item.get("deleted") is True for item in cleanup)
              and {(item.get("kind"), item.get("id")) for item in cleanup} == expected_cleanup, "manifest_cleanup_mismatch")
        lifetimes = [(timestamp(deleted[("container", item)]["finished_at"]) - timestamp(paid["started_at"])).total_seconds() for item in containers]
        check(all(0 <= seconds < 1200 for seconds in lifetimes), "container_session_bound_exceeded")
        artifact_status = manifest.get("status")
        check(artifact_status in {"artifact_downloaded", "no_artifact"}, "unfinished_or_failed_run")
        evaluation = manifest.get("evaluation") or {}
        output_hash = None
        if artifact_status == "artifact_downloaded":
            output_hash = digest(read_bytes(path.parent / "output.xlsx"))
            check(output_hash == manifest.get("outputSha256") and downloads == [output_hash], "artifact_hash_mismatch")
            check(read_json(path.parent / "evaluation.json") == evaluation, "evaluation_manifest_mismatch")
            check(evaluation.get("source_sha256") == hashes["sourceSha256"]
                  and evaluation.get("output_sha256") == output_hash, "evaluation_artifact_hash_mismatch")
        else:
            check(not downloads and not (path.parent / "output.xlsx").exists(), "unexpected_undelivered_artifact")
            check(not evaluation and manifest.get("outputSha256") is None
                  and not (path.parent / "evaluation.json").exists(), "unexpected_undelivered_evaluation")
        static = evaluation.get("static_status", evaluation.get("status", "unverified"))
        facts = evaluation.get("category_status", {}).get("facts", "unverified")
        structure = evaluation.get("category_status", {}).get("structure", "unverified")
        check(all(value in VERDICTS for value in (static, facts, structure)), "invalid_saved_verdict")
        final_message = qualifying_final(response)
        complete = status == "completed" and final_message and artifact_status == "artifact_downloaded" and static == "pass"
        row = reports.get(run_id, {})
        expected_verdicts = {"kind": "comparison", "model": MODEL, "university": university, "repeat": repeat,
                             "responseStatus": status, "artifactStatus": artifact_status, "finalMessagePresent": final_message,
                             "incompleteReason": incomplete_reason,
                             "evaluationStatus": static, "factsStatus": facts, "structureStatus": structure,
                             "completionStatus": "complete" if complete else "incomplete"}
        check(all(row.get(key) == value for key, value in expected_verdicts.items()), "report_verdict_mismatch")
        check(row.get("estimatedNanoUsd") == cost and row.get("unresolvedCalls") == 0, "report_run_cost_mismatch")
        check(row.get("estimatedUsd") == cost / 1e9, "report_run_dollar_mismatch")
        for key in ("inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens"):
            check(row.get(key) == usage[key], "report_usage_mismatch")
        duration = integer(manifest.get("durationMs")) / 1000
        check(row.get("durationSeconds") == duration, "report_duration_mismatch")
        compare_csv(row, csv_rows[run_id], [*expected_verdicts, "inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens", "durationSeconds", "unresolvedCalls", "estimatedUsd"])
        public.append({"arm": arm, "university": university, "repeat": repeat, "responseStatus": status,
                       "incompleteReason": incomplete_reason,
                       "artifactDownloaded": artifact_status == "artifact_downloaded", "finalMessagePresent": final_message,
                       "completeAndStaticPass": complete, "staticStatus": static, "factsStatus": facts, "structureStatus": structure,
                       "durationSeconds": duration, "containerLifetimeSeconds": max(lifetimes, default=0),
                       **trace, **usage, "containerNanoUsd": len(containers) * 30_000_000,
                       "estimatedNanoUsd": cost, "estimatedUsd": cost / 1e9,
                       "hashes": {**hashes, "guidanceBodySha256": None if guidance is None else digest(guidance),
                                  "outputSha256": output_hash, "responseSha256": digest(response_bytes)}})
        order.append((timestamp(paid["started_at"]), arm, university, repeat))
    check(labels == expected_labels and run_ids == set(reports) == {row["run_id"] for row in ledger}, "expected_runs_incomplete")
    check(sum(row["estimatedNanoUsd"] for row in public) == summary["estimatedNanoUsd"], "independent_total_mismatch")
    public.sort(key=lambda row: (row["university"], row["repeat"]))
    return public, order


def aggregate(rows):
    costs = sum(row["estimatedNanoUsd"] for row in rows)
    passed = sum(row["completeAndStaticPass"] for row in rows)
    return {
        "runs": len(rows), "completeAndStaticPass": passed,
        "artifactsDownloaded": sum(row["artifactDownloaded"] for row in rows),
        "maxOutputTokenStops": sum(row["incompleteReason"] == "max_output_tokens" for row in rows),
        "staticPass": sum(row["staticStatus"] == "pass" for row in rows),
        "factsPass": sum(row["factsStatus"] == "pass" for row in rows),
        "structurePass": sum(row["structureStatus"] == "pass" for row in rows),
        "responseStatuses": dict(sorted(Counter(row["responseStatus"] for row in rows).items())),
        "estimatedNanoUsd": costs, "estimatedUsd": costs / 1e9,
        "costPerCompletedWorkbookUsd": costs / 1e9 / passed if passed else None,
        "medianDurationSeconds": statistics.median(row["durationSeconds"] for row in rows),
        **{key: sum(row[key] for row in rows) for key in ("codeCalls", "emptyOutputs", "logChars", "inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens", "tokenNanoUsd", "containerNanoUsd")},
    }


def read_plan(repo_root):
    path = repo_root / "experiments/llm-export/diagnostics/sol-prompt-comparison-2026-10-12/plan.json"
    raw = read_bytes(path)
    plan = obj(json.loads(raw))
    check(plan.get("model") == MODEL and plan.get("maxOutputTokens") == 8000
          and plan.get("reasoningEffort") == "medium" and plan.get("serviceTier") == "default"
          and plan.get("memoryLimit") == "1g" and plan.get("network") == "disabled"
          and plan.get("budgetPerArmUsd") == 3.5, "plan_settings_mismatch")
    frozen = obj(plan.get("frozenFiles"))
    required = {"experiments/llm-export/evaluator.py", "experiments/llm-export/evaluator/expected.json",
                "experiments/llm-export/prompt.md", "experiments/llm-export/prompts/avoid-editing-pitfalls.md"}
    required |= {"docs/references/" + source for source in SOURCES.values()}
    required |= {f"experiments/llm-export/cases/{university}/basic.json" for university in SOURCES}
    check(required <= frozen.keys(), "plan_freezes_incomplete")
    for relative, expected in frozen.items():
        check(isinstance(relative, str) and (repo_root / relative).resolve().is_relative_to(repo_root.resolve()), "invalid_frozen_path")
        check(digest(read_bytes(repo_root / relative)) == expected, "frozen_file_hash_mismatch")
    for arm, (experiment, variant) in ARMS.items():
        saved = obj(plan.get("arms", {}).get(arm))
        check(saved.get("experiment") == experiment and saved.get("promptVariant") == variant, "plan_arm_mismatch")
    schedule = plan.get("schedule")
    check(isinstance(schedule, list) and len(schedule) == 24, "plan_schedule_missing")
    check([item.get("ordinal") for item in schedule] == list(range(1, 25)), "plan_schedule_ordinals_invalid")
    expected = {(arm, university, repeat) for arm in ARMS for university in SOURCES for repeat in (1, 2, 3)}
    check({(item.get("arm"), item.get("university"), item.get("repeat")) for item in schedule} == expected, "plan_schedule_slots_invalid")
    return plan, digest(raw)


def compare(repeats, repo_root=ROOT, history_root=None):
    check(repeats in {1, 3}, "invalid_repeats")
    plan, plan_hash = read_plan(repo_root)
    arms, chronological, seen = {}, [], {}
    for arm in ARMS:
        rows, order = audit_arm(arm, repeats, repo_root, history_root, seen)
        arms[arm] = rows
        chronological.extend(order)
    order = sorted(chronological)
    check(timestamp(plan.get("createdBeforeDispatchUtc")) < order[0][0], "plan_not_created_before_dispatch")
    expected_order = [(item["arm"], item["university"], item["repeat"]) for item in plan["schedule"] if item["repeat"] <= repeats]
    check([item[1:] for item in order] == expected_order, "observed_order_differs_from_plan")
    for arm, rows in arms.items():
        check(all(row["hashes"]["promptSha256"] == plan["arms"][arm].get("promptSha256") for row in rows), "prompt_differs_from_plan")
        check(all(row["hashes"]["guidanceBodySha256"] == plan["arms"][arm].get("guidanceBodySha256") for row in rows), "guidance_differs_from_plan")
    pairs = []
    for baseline, improved in zip(arms["baseline"], arms["improved"], strict=True):
        check((baseline["university"], baseline["repeat"]) == (improved["university"], improved["repeat"]), "pair_labels_mismatch")
        check(all(baseline["hashes"][key] == improved["hashes"][key] for key in ("sourceSha256", "inputSha256")), "pair_input_hash_mismatch")
        pairs.append({"university": baseline["university"], "repeat": baseline["repeat"],
                      "baselinePass": baseline["completeAndStaticPass"], "improvedPass": improved["completeAndStaticPass"],
                      "improvedMinusBaseline": {key: improved[key] - baseline[key] for key in ("codeCalls", "emptyOutputs", "inputTokens", "outputTokens", "estimatedNanoUsd", "durationSeconds")}})
    first = Counter()
    for index in range(0, len(order), 2):
        left, right = order[index:index + 2]
        check(left[1] != right[1] and left[2:] == right[2:], "trials_not_interleaved_pairs")
        first[left[1]] += 1
    check(first["baseline"] == first["improved"], "first_arm_order_not_balanced")
    return {"schemaVersion": 1, "model": MODEL, "repeats": repeats,
            "auditStatus": "pass", "apiCallsMadeByAudit": 0, "historyModified": False,
            "planSha256": plan_hash, "frozenFileCount": len(plan["frozenFiles"]),
            "costBasis": "usage_estimate_not_provider_invoice", "priceVersion": PRICE_VERSION,
            "pricesUsdPerMillionTokens": {"input": 2, "cachedInput": .1, "cacheWrite": 2.5, "output": 10},
            "budgetUsdPerArm": 3.5, "warnings": WARNINGS,
            "arms": {arm: {"totals": aggregate(rows), "universities": {university: aggregate([row for row in rows if row["university"] == university]) for university in SOURCES}, "runs": rows} for arm, rows in arms.items()},
            "pairs": pairs, "pairFirstCounts": dict(first),
            "order": [{"arm": arm, "university": university, "repeat": repeat} for _, arm, university, repeat in order]}


def write_output(path, result, history_root):
    check(not path.resolve().is_relative_to(history_root.resolve()), "output_inside_history")
    check(not path.is_symlink(), "output_symlink")
    with path.open("x", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2, allow_nan=False)
        file.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, choices=(1, 3), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(args.repeats)
        write_output(args.output, result, HERE / "runs")
    except AuditError as error:
        print("Comparison audit failed: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError, sqlite3.Error):
        print("Comparison audit failed: malformed, missing or inconsistent saved evidence/output.", file=sys.stderr)
        return 1
    print(json.dumps({"auditStatus": "pass", "runsPerArm": 4 * args.repeats,
                      "estimatedUsd": sum(arm["totals"]["estimatedNanoUsd"] for arm in result["arms"].values()) / 1e9}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
