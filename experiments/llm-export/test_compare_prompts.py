"""Offline audit regressions: money, provenance, privacy and immutable inputs."""

import base64
from contextlib import closing, redirect_stderr
import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("compare_prompts", Path(__file__).with_name("compare-prompts.py"))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class PromptComparisonAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.history = self.root / "experiments/llm-export/runs"

    def fixture(self, no_artifact_index=None):
        """Four completed baseline trials with fully synthetic gateway evidence."""
        experiment = audit.ARMS["baseline"][0]
        base = self.history / experiment
        base.mkdir(parents=True)
        common = b"Preserve the supplied workbook.\n"
        (self.root / "experiments/llm-export/prompt.md").write_bytes(common)
        prompt = common + "\n対象データ: input.json。元の書式: template.xlsx。\n".encode()
        ledger, reports, summaries = [], [], []
        for index, (university, source_name) in enumerate(audit.SOURCES.items()):
            delivered = index != no_artifact_index
            status = "completed" if delivered else "incomplete"
            run_id = f"private-run-{index}"
            folder = base / run_id
            folder.mkdir()
            source, data, output = b"synthetic-template", b'{"synthetic":true}', b"synthetic-output"
            source_path = self.root / "docs/references" / source_name
            source_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.write_bytes(source)
            case_path = self.root / "experiments/llm-export/cases" / university / "basic.json"
            case_path.parent.mkdir(parents=True, exist_ok=True)
            case_path.write_bytes(data)
            (folder / "input.json").write_bytes(data)
            (folder / "prompt.md").write_bytes(prompt)
            if delivered:
                (folder / "output.xlsx").write_bytes(output)
            usage = {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30,
                     "input_tokens_details": {"cached_tokens": 4, "cache_write_tokens": 3},
                     "output_tokens_details": {"reasoning_tokens": 8}}
            response_id, container = f"resp_private{index}", f"cntr_private{index}"
            files = [f"file-private{index}-template", f"file-private{index}-input"]
            response = {"model": audit.MODEL, "id": response_id, "status": status, "max_output_tokens": 8000,
                        "reasoning": {"effort": "medium"}, "service_tier": "default", "usage": usage,
                        "output": [{"type": "code_interpreter_call", "status": "completed", "container_id": container,
                                    "code": "PRIVATE_CODE", "outputs": [{"type": "logs", "logs": "sk-secret /Users/private/private-file"}]},
                                   {"type": "message", "status": "completed", "phase": "final_answer",
                                    "content": [{"type": "output_text", "text": "PRIVATE_FINAL"}]}]}
            if not delivered:
                response["incomplete_details"] = {"reason": "max_output_tokens"}
                response["output"] = response["output"][:1]
            save(folder / "response.json", response)
            evaluation = {"status": "pass", "static_status": "pass", "category_status": {"facts": "pass", "structure": "pass"},
                          "source_sha256": audit.digest(source), "output_sha256": audit.digest(output)} if delivered else None
            if delivered:
                save(folder / "evaluation.json", evaluation)
            cleanup = [{"kind": "container", "id": container, "deleted": True},
                       *[{"kind": "file", "id": file, "deleted": True} for file in files]]
            save(folder / "manifest.json", {
                "runId": run_id, "kind": "comparison", "model": audit.MODEL, "university": university, "repeat": 1,
                "promptVariant": "baseline", "promptVariantGuidanceSha256": None, "repairGuidance": None,
                "maxOutputTokens": 8000, "reasoningEffort": "medium", "serviceTier": "default", "sourceUnchanged": True,
                "sourceSha256": audit.digest(source), "inputSha256": audit.digest(data), "promptSha256": audit.digest(prompt),
                "outputSha256": audit.digest(output) if delivered else None, "responseId": response_id, "responseStatus": status, "usage": usage,
                "cleanup": cleanup, "status": "artifact_downloaded" if delivered else "no_artifact", "evaluation": evaluation, "durationMs": 1000,
                "startedAt": f"2026-10-12T01:{index:02}:00Z"})
            cost = 30_133_900  # 13*2000 + 4*100 + 3*2500 + 10*10000 + container.

            def call(operation, request, body, paid=False):
                call_id = f"call-private-{len(ledger)}"
                row = {"call_id": call_id, "experiment_id": experiment, "run_id": run_id, "operation": operation,
                       "cost_state": "settled", "duplicate_of": None, "estimated_nano_usd": cost if paid else 0,
                       "request_hash": audit.digest(audit.canonical({"operation": operation, "runId": run_id, "data": request})),
                       "provider_request_id": f"req-private-{len(ledger)}", "response_id": response_id if paid else None,
                       "model": audit.MODEL if paid else None, "usage_json": json.dumps(usage) if paid else None,
                       "details_json": json.dumps({"containerIds": [container], "containerNanoUsd": 30_000_000,
                                                   "usageEstimate": {"estimatedNanoUsd": 133_900}}) if paid else "{}",
                       "started_at": f"2026-10-12T01:{index:02}:00Z", "finished_at": f"2026-10-12T01:{index:02}:02Z"}
                ledger.append(row)
                save(base / "calls" / f"{call_id}.request.json", {"callId": call_id, "runId": run_id, "operation": operation, "data": request})
                save(base / "calls" / f"{call_id}.response.json", {"callId": call_id, "providerRequestId": row["provider_request_id"], "httpStatus": 200, "body": body})
                summaries.append({"callId": call_id, "runId": run_id, "operation": operation, "costState": "settled", "estimatedNanoUsd": row["estimated_nano_usd"]})

            for name, content, file_id in zip(("template.xlsx", "input.json"), (source, data), files):
                call("upload", {"fileName": name, "base64": base64.b64encode(content).decode()}, {"id": file_id})
            request = {"model": audit.MODEL, "input": prompt.decode(), "max_output_tokens": 8000, "reasoning": {"effort": "medium"},
                       "service_tier": "default", "stream": False, "store": True,
                       "tools": [{"type": "code_interpreter", "container": {"type": "auto", "memory_limit": "1g", "file_ids": files, "network_policy": {"type": "disabled"}}}]}
            call("response", request, response, paid=True)
            if delivered:
                call("download", {"containerId": container, "fileId": "file-private-output"}, {"base64": base64.b64encode(output).decode()})
            call("deleteContainer", {"containerId": container}, {"deleted": True})
            for file in files:
                call("deleteFile", {"fileId": file}, {"deleted": True})
            reports.append({"runId": run_id, "kind": "comparison", "model": audit.MODEL, "university": university, "repeat": 1,
                            "responseStatus": status, "artifactStatus": "artifact_downloaded" if delivered else "no_artifact", "finalMessagePresent": delivered,
                            "incompleteReason": None if delivered else "max_output_tokens",
                            "evaluationStatus": "pass" if delivered else "unverified", "factsStatus": "pass" if delivered else "unverified",
                            "structureStatus": "pass" if delivered else "unverified", "completionStatus": "complete" if delivered else "incomplete",
                            "inputTokens": 20, "outputTokens": 10, "reasoningTokens": 8, "cachedInputTokens": 4, "cacheWriteTokens": 3,
                            "durationSeconds": 1, "unresolvedCalls": 0, "estimatedNanoUsd": cost, "estimatedUsd": cost / 1e9})
        with closing(sqlite3.connect(base / "ledger.sqlite")) as db:
            db.execute("CREATE TABLE evaluation_experiments(experiment_id TEXT,budget_nano_usd INTEGER,price_version TEXT)")
            db.execute("INSERT INTO evaluation_experiments VALUES (?,?,?)", (experiment, audit.BUDGET, audit.PRICE_VERSION))
            numeric = {"estimated_nano_usd"}
            db.execute("CREATE TABLE evaluation_calls(" + ",".join(key + (" INTEGER" if key in numeric else " TEXT") for key in ledger[0]) + ")")
            db.executemany("INSERT INTO evaluation_calls VALUES (" + ",".join("?" for _ in ledger[0]) + ")", [list(row.values()) for row in ledger])
            db.commit()
        summary = {"experimentId": experiment, "estimatedNanoUsd": 4 * 30_133_900, "budgetNanoUsd": audit.BUDGET,
                   "priceVersion": audit.PRICE_VERSION, "unresolvedCount": 0, "reservedNanoUsd": 0, "callCount": len(ledger), "calls": summaries}
        save(base / "cost-summary.json", summary)
        save(base / "report.json", {"experimentId": experiment, "summary": summary, "rows": reports})
        with (base / "results.csv").open("w", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=reports[0])
            writer.writeheader()
            writer.writerows({key: str(value).lower() if isinstance(value, bool) else value for key, value in row.items()} for row in reports)
        return base

    def test_full_arm_audit_recomputes_cost_sanitizes_and_preserves_history(self):
        base = self.fixture()
        before = {path: path.read_bytes() for path in base.rglob("*") if path.is_file()}
        rows, _ = audit.audit_arm("baseline", 1, self.root)
        self.assertEqual(len(rows), 4)
        self.assertEqual(audit.aggregate(rows)["estimatedNanoUsd"], 120_535_600)
        serialized = json.dumps(rows)
        for secret in ("private", "resp_", "cntr_", "file-", "sk-", "/Users/", "PRIVATE_CODE", "PRIVATE_FINAL"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_artifact_and_uploaded_bytes_are_independently_verified(self):
        base = self.fixture()
        path = base / "private-run-0/output.xlsx"
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(audit.AuditError, "artifact_hash_mismatch"):
            audit.audit_arm("baseline", 1, self.root)

    def test_token_stop_without_artifact_still_counts_all_known_cost(self):
        base = self.fixture(no_artifact_index=1)
        rows, _ = audit.audit_arm("baseline", 1, self.root)
        totals = audit.aggregate(rows)
        self.assertEqual(totals["completeAndStaticPass"], 3)
        self.assertEqual(totals["artifactsDownloaded"], 3)
        self.assertEqual(totals["maxOutputTokenStops"], 1)
        self.assertEqual(totals["estimatedNanoUsd"], 120_535_600)
        self.assertEqual(totals["costPerCompletedWorkbookUsd"], 0.1205356 / 3)
        path = base / "private-run-1/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["evaluation"] = {"static_status": "pass"}
        save(path, manifest)
        with self.assertRaisesRegex(audit.AuditError, "unexpected_undelivered_evaluation"):
            audit.audit_arm("baseline", 1, self.root)

    def test_verdict_for_other_bytes_cannot_be_reused(self):
        base = self.fixture()
        folder = base / "private-run-0"
        evaluation = json.loads((folder / "evaluation.json").read_text())
        evaluation["output_sha256"] = "f" * 64
        save(folder / "evaluation.json", evaluation)
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest["evaluation"] = evaluation
        save(folder / "manifest.json", manifest)
        with self.assertRaisesRegex(audit.AuditError, "evaluation_artifact_hash"):
            audit.audit_arm("baseline", 1, self.root)

    def test_csv_cost_tampering_is_rejected(self):
        base = self.fixture()
        path = base / "results.csv"
        path.write_text(path.read_text().replace("0.0301339", "0.0", 1))
        with self.assertRaisesRegex(audit.AuditError, "csv_report_value"):
            audit.audit_arm("baseline", 1, self.root)

    def test_unresolved_cost_or_missing_cleanup_cannot_be_published_as_complete(self):
        base = self.fixture()
        with closing(sqlite3.connect(base / "ledger.sqlite")) as db:
            db.execute("UPDATE evaluation_calls SET cost_state='unknown' WHERE operation='response'")
            db.commit()
        with self.assertRaisesRegex(audit.AuditError, "unresolved"):
            audit.audit_arm("baseline", 1, self.root)

    def test_manifest_cleanup_failure_is_not_hidden_by_successful_report(self):
        base = self.fixture()
        path = base / "private-run-0/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["cleanup"][0]["deleted"] = False
        save(path, manifest)
        with self.assertRaisesRegex(audit.AuditError, "manifest_cleanup"):
            audit.audit_arm("baseline", 1, self.root)

    def test_csv_completion_tampering_is_rejected(self):
        base = self.fixture()
        path = base / "results.csv"
        path.write_text(path.read_text().replace(",complete,", ",incomplete,", 1))
        with self.assertRaisesRegex(audit.AuditError, "csv_report_value"):
            audit.audit_arm("baseline", 1, self.root)

    def test_usage_prices_reasoning_once_and_rejects_bad_cache_components(self):
        usage = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
                 "input_tokens_details": {"cached_tokens": 30, "cache_creation_tokens": 10},
                 "output_tokens_details": {"reasoning_tokens": 15}}
        self.assertEqual(audit.calculate_usage(usage)["tokenNanoUsd"], 348_000)
        usage["input_tokens_details"]["cache_write_tokens"] = 11
        with self.assertRaisesRegex(audit.AuditError, "cache_alias_conflict"):
            audit.calculate_usage(usage)

    def plan_fixture(self):
        self.fixture()
        extra = ["experiments/llm-export/evaluator.py", "experiments/llm-export/evaluator/expected.json",
                 "experiments/llm-export/prompts/avoid-editing-pitfalls.md"]
        for relative in extra:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic frozen bytes")
        frozen = extra + ["experiments/llm-export/prompt.md"]
        frozen += ["docs/references/" + name for name in audit.SOURCES.values()]
        frozen += [f"experiments/llm-export/cases/{university}/basic.json" for university in audit.SOURCES]
        schedule = []
        for repeat in (1, 2, 3):
            for index, university in enumerate(audit.SOURCES):
                arms = ("baseline", "improved") if (index + repeat) % 2 else ("improved", "baseline")
                for arm in arms:
                    schedule.append({"ordinal": len(schedule) + 1, "arm": arm, "university": university, "repeat": repeat})
        baseline_rows, _ = audit.audit_arm("baseline", 1, self.root)
        plan = {"model": audit.MODEL, "maxOutputTokens": 8000, "reasoningEffort": "medium", "serviceTier": "default",
                "memoryLimit": "1g", "network": "disabled", "budgetPerArmUsd": 3.5,
                "createdBeforeDispatchUtc": "2026-10-12T00:00:00Z", "schedule": schedule,
                "frozenFiles": {relative: audit.digest((self.root / relative).read_bytes()) for relative in frozen},
                "arms": {arm: {"experiment": experiment, "promptVariant": variant,
                               "promptSha256": baseline_rows[0]["hashes"]["promptSha256"] if arm == "baseline" else "a" * 64,
                               "guidanceBodySha256": None if arm == "baseline" else "b" * 64}
                         for arm, (experiment, variant) in audit.ARMS.items()}}
        path = self.root / "experiments/llm-export/diagnostics/sol-prompt-comparison-2026-10-12/plan.json"
        save(path, plan)
        return plan, baseline_rows

    def test_plan_freeze_rejects_changed_oracle(self):
        self.plan_fixture()
        audit.read_plan(self.root)
        (self.root / "experiments/llm-export/evaluator.py").write_bytes(b"changed oracle")
        with self.assertRaisesRegex(audit.AuditError, "frozen_file_hash"):
            audit.read_plan(self.root)

    def test_pair_comparison_rejects_unequal_inputs_and_checks_dispatch_order(self):
        plan, baseline = self.plan_fixture()
        mismatch = False

        def arm_rows(arm, *_):
            rows = json.loads(json.dumps(baseline))
            for row in rows:
                row["arm"] = arm
                row["hashes"].update({key: plan["arms"][arm][key] for key in ("promptSha256", "guidanceBodySha256")})
                if mismatch and arm == "improved":
                    row["hashes"]["inputSha256"] = "c" * 64
            start = datetime(2026, 10, 12, 1, tzinfo=timezone.utc)
            order = [(start + timedelta(seconds=item["ordinal"]), arm, item["university"], 1)
                     for item in plan["schedule"] if item["repeat"] == 1 and item["arm"] == arm]
            return rows, order

        with patch.object(audit, "audit_arm", side_effect=arm_rows):
            result = audit.compare(1, self.root)
            self.assertEqual(result["pairFirstCounts"], {"baseline": 2, "improved": 2})
            mismatch = True
            with self.assertRaisesRegex(audit.AuditError, "pair_input_hash"):
                audit.compare(1, self.root)

    def test_truncated_final_or_commentary_does_not_establish_completion(self):
        response = {"status": "incomplete", "output": [{"type": "message", "phase": "final_answer", "status": "incomplete",
                                                         "content": [{"type": "output_text", "text": "result"}]}]}
        self.assertFalse(audit.qualifying_final(response))
        response["status"] = "completed"
        response["output"][0].update(phase="commentary", status="completed")
        self.assertFalse(audit.qualifying_final(response))

    def test_output_refuses_history_existing_files_and_symlinks(self):
        self.history.mkdir(parents=True)
        with self.assertRaisesRegex(audit.AuditError, "inside_history"):
            audit.write_output(self.history / "new.json", {}, self.history)
        output = self.root / "new.json"
        audit.write_output(output, {"safe": True}, self.history)
        with self.assertRaises(FileExistsError):
            audit.write_output(output, {}, self.history)
        link = self.root / "link.json"
        link.symlink_to(output)
        with self.assertRaisesRegex(audit.AuditError, "symlink"):
            audit.write_output(link, {}, self.history)
        self.assertEqual(json.loads(output.read_text()), {"safe": True})

    def test_malformed_evidence_errors_do_not_leak_tracebacks_or_paths(self):
        stream = io.StringIO()
        with patch.object(audit.sys, "argv", ["compare-prompts.py", "--repeats", "1", "--output", str(self.root / "out.json")]), \
                patch.object(audit, "compare", side_effect=AttributeError("/Users/private/provider-id")), \
                redirect_stderr(stream):
            self.assertEqual(audit.main(), 1)
        self.assertIn("malformed, missing or inconsistent", stream.getvalue())
        self.assertNotIn("private", stream.getvalue())
        self.assertNotIn("Traceback", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
