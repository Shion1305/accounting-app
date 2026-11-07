"""Offline trace inventory regressions for evidence boundaries and safe export."""

import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "analyze_traces", Path(__file__).with_name("analyze-traces.py")
)
traces = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(traces)


class TraceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.history = self.root / "runs"
        self.base = self.history / "experiment"
        self.base.mkdir(parents=True)
        self.rows = []

    def save(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def add_run(self, name="private-run", kind="comparison", repeat=1, response=True):
        folder = self.base / name
        folder.mkdir()
        manifest = {
            "runId": name, "kind": kind, "model": "gpt-6-luna", "university": "gakushuin",
            "repeat": repeat, "maxOutputTokens": 8000, "reasoningEffort": "medium",
            "sourceSha256": "a" * 64, "inputSha256": "b" * 64, "promptSha256": "c" * 64,
            "status": "artifact_downloaded" if response else "failed",
            "responseId": "resp_private123", "privatePath": "/Users/private/secret",
        }
        self.save(folder / "manifest.json", manifest)
        record = {
            "model": "gpt-6-luna", "status": "completed", "max_output_tokens": 8000,
            "reasoning": {"effort": "medium"}, "service_tier": "default", "incomplete_details": None,
            "usage": {"output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 40}},
            "output": [{"type": "message", "content": "sk-must-never-escape"}],
        }
        if response:
            self.save(folder / "response.json", record)
        row = {"runId": name, "kind": kind, "model": "gpt-6-luna", "university": "gakushuin",
               "repeat": "" if repeat is None else str(repeat), "finalMessagePresent": "true",
               "artifactStatus": "artifact_downloaded" if response else "failed",
               "completionStatus": "complete" if response else "incomplete",
               "evaluationStatus": "pass" if response else "unverified",
               "factsStatus": "pass" if response else "unverified",
               "structureStatus": "pass" if response else "unverified",
               "responseStatus": "completed" if response else "", "outputTokens": "50" if response else "",
               "reasoningTokens": "40" if response else "", "incompleteReason": ""}
        self.rows.append(row)
        self.write_rows()
        return folder, manifest, record

    def write_rows(self):
        with (self.base / "results.csv").open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=self.rows[0].keys())
            writer.writeheader()
            writer.writerows(self.rows)

    def test_empty_outputs_blank_logs_and_images_are_distinct_and_history_is_unchanged(self):
        folder, _, response = self.add_run()
        response["output"].extend([
            {"type": "code_interpreter_call", "code": "print(1)", "status": "completed", "outputs": []},
            {"type": "code_interpreter_call", "code": "print()", "status": "completed",
             "outputs": [{"type": "logs", "logs": " \n"}]},
            {"type": "code_interpreter_call", "code": "display(image)", "status": "completed",
             "outputs": [{"type": "image", "url": "private-image-url"}]},
        ])
        self.save(folder / "response.json", response)
        before = {p: p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        result = traces.build_inventory(self.base)
        run = result["runs"][0]
        self.assertEqual(run["codeCallCount"], 3)
        self.assertEqual(run["emptyOutputsCount"], 1)
        self.assertEqual(run["blankLogsPresentCount"], 1)
        self.assertEqual(run["totalLogChars"], 2)
        self.assertEqual(run["responseSha256"], hashlib.sha256(before[folder / "response.json"]).hexdigest())
        self.assertEqual(result["aggregates"][0]["completeAndStaticPass"], 1)
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_exception_repr_is_counted_without_exporting_arbitrary_content(self):
        folder, _, response = self.add_run("private-uuid-0123")
        response["output"].append({
            "type": "code_interpreter_call", "code": "SECRET_CODE", "status": "completed",
            "id": "provider-id", "outputs": [{"type": "logs", "logs":
                "ModuleNotFoundError('sk-secret file-private resp_private /Users/private')\n"
                "ValueError: Bearer secret\nordinary documentation Error Recovery\n"}],
        })
        self.save(folder / "response.json", response)
        result = traces.build_inventory(self.base)
        self.assertEqual(result["runs"][0]["diagnosticClasses"], {"ModuleNotFoundError": 1, "ValueError": 1})
        serialized = json.dumps(result)
        for secret in ("sk-", "SECRET_CODE", "private-uuid", "file-private", "resp_private", "/Users/", "Bearer"):
            self.assertNotIn(secret, serialized)

    def test_static_pass_and_completion_are_kept_separate(self):
        folder, _, response = self.add_run()
        response["status"] = "incomplete"
        response["incomplete_details"] = {"reason": "max_output_tokens"}
        self.save(folder / "response.json", response)
        self.rows[0]["completionStatus"] = "incomplete"
        self.rows[0]["responseStatus"] = "incomplete"
        self.rows[0]["incompleteReason"] = "max_output_tokens"
        self.write_rows()
        run = traces.build_inventory(self.base)["runs"][0]
        self.assertEqual(run["historical"]["evaluationStatus"], "pass")
        self.assertFalse(run["historical"]["completeAndStaticPass"])
        self.assertEqual(run["incompleteReason"], "max_output_tokens")

    def test_duplicate_stable_labels_are_rejected_even_with_different_run_ids(self):
        self.add_run("first")
        self.add_run("second")
        with self.assertRaisesRegex(ValueError, "Duplicate stable"):
            traces.build_inventory(self.base)

    def test_missing_comparison_response_is_rejected(self):
        self.add_run(response=False)
        with self.assertRaisesRegex(ValueError, "Missing response"):
            traces.build_inventory(self.base)

    def test_no_response_control_is_excluded_and_smoke_is_separate(self):
        self.add_run("preflight", kind="control", repeat=None, response=False)
        self.add_run("control", kind="control", repeat=None)
        self.save(self.base / "cost-summary.json", {"calls": [{
            "runId": "smoke-private-uuid", "operation": "response", "model": "gpt-6.1-sol",
            "status": "completed", "responseId": "resp_hidden",
            "usage": {"output_tokens": 2, "output_tokens_details": {"reasoning_tokens": 0}},
        }]})
        result = traces.build_inventory(self.base)
        self.assertEqual(len(result["runs"]), 1)
        self.assertEqual(result["excluded"][0]["reason"], "control_without_response")
        self.assertEqual(result["aggregates"][0]["runs"], 1)
        self.assertEqual(result["smoke"]["runs"][0]["outputTokens"], 2)
        self.assertNotIn("resp_hidden", json.dumps(result))

    def test_malformed_log_or_usage_is_rejected_instead_of_silently_ignored(self):
        folder, _, original = self.add_run()
        for mutation in ("log", "usage"):
            with self.subTest(mutation=mutation):
                response = json.loads(json.dumps(original))
                if mutation == "log":
                    response["output"].append({"type": "code_interpreter_call", "code": "pass",
                                               "status": "completed", "outputs": [{"type": "logs", "logs": 123}]})
                else:
                    response["usage"]["output_tokens_details"]["reasoning_tokens"] = 100
                self.save(folder / "response.json", response)
                with self.assertRaises(ValueError):
                    traces.build_inventory(self.base)

    def test_csv_label_mismatch_and_missing_rows_are_rejected(self):
        folder, manifest, _ = self.add_run()
        manifest["repeat"] = 2
        self.save(folder / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "labels differ"):
            traces.build_inventory(self.base)
        manifest["repeat"] = 1
        self.save(folder / "manifest.json", manifest)
        self.rows.append({**self.rows[0], "runId": "missing", "repeat": "2"})
        self.write_rows()
        with self.assertRaisesRegex(ValueError, "unmatched saved runs"):
            traces.build_inventory(self.base)

    def test_request_setting_mismatch_and_untrusted_labels_are_rejected(self):
        folder, manifest, _ = self.add_run()
        manifest["maxOutputTokens"] = 12000
        self.save(folder / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "setting mismatch"):
            traces.build_inventory(self.base)
        manifest["model"] = "resp_private-provider-id"
        self.save(folder / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "Invalid model"):
            traces.build_inventory(self.base)

    def test_csv_status_and_usage_mismatch_are_rejected(self):
        self.add_run()
        for field, value in (("responseStatus", "incomplete"), ("outputTokens", "999"),
                             ("reasoningTokens", "0"), ("incompleteReason", "content_filter")):
            with self.subTest(field=field):
                previous = self.rows[0][field]
                self.rows[0][field] = value
                self.write_rows()
                with self.assertRaisesRegex(ValueError, "CSV .* mismatch"):
                    traces.build_inventory(self.base)
                self.rows[0][field] = previous

    def test_output_cannot_overwrite_any_file_or_enter_history(self):
        self.add_run()
        inventory = traces.build_inventory(self.base)
        for path in (self.base / "new.json", self.base / "results.csv"):
            with self.assertRaisesRegex(ValueError, "saved history"):
                traces.write_inventory(path, inventory, self.history)
        output = self.root / "result.json"
        traces.write_inventory(output, inventory, self.history)
        first = output.read_bytes()
        with self.assertRaises(FileExistsError):
            traces.write_inventory(output, inventory, self.history)
        self.assertEqual(first, output.read_bytes())

    def test_output_symlink_and_input_symlink_are_rejected(self):
        folder, _, _ = self.add_run()
        inventory = traces.build_inventory(self.base)
        target = self.root / "target"
        target.write_text("keep")
        link = self.root / "result.json"
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlink"):
            traces.write_inventory(link, inventory, self.history)
        original = folder / "response.json"
        moved = self.root / "moved.json"
        original.rename(moved)
        original.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, "regular JSON"):
            traces.build_inventory(self.base)
        self.assertEqual(target.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
