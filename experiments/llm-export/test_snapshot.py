"""Offline regressions for stale costs and evidence modified after evaluation."""

import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import snapshot


class SnapshotLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ledger.sqlite"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE evaluation_experiments (
                experiment_id TEXT, budget_nano_usd INTEGER, price_version TEXT
            );
            INSERT INTO evaluation_experiments VALUES ('example', 10000000000, 'test-prices');
            CREATE TABLE evaluation_calls (
                call_id TEXT, experiment_id TEXT, run_id TEXT, operation TEXT, model TEXT,
                request_hash TEXT, reserved_nano_usd INTEGER, estimated_nano_usd INTEGER,
                status TEXT, cost_state TEXT, response_id TEXT, provider_request_id TEXT,
                duplicate_of TEXT, started_at TEXT, finished_at TEXT,
                metadata_json TEXT, usage_json TEXT, details_json TEXT
            );
            INSERT INTO evaluation_calls VALUES (
                'original', 'example', 'smoke-original', 'response', 'gpt-6-luna',
                'request-hash', 10000, 5000, 'completed', 'settled', 'response-original',
                'request-original', NULL, '2026-10-12T00:00:00Z', '2026-10-12T00:00:01Z',
                NULL, '{"input_tokens":10,"output_tokens":8}', '{}'
            );
        """)
        self.report = {
            "budgetNanoUsd": 10000000000, "priceVersion": "test-prices",
            "callCount": 1, "estimatedNanoUsd": 5000,
            "calls": [{
                "callId": "original", "experimentId": "example", "runId": "smoke-original",
                "operation": "response", "model": "gpt-6-luna", "requestHash": "request-hash",
                "reservedNanoUsd": 10000, "estimatedNanoUsd": 5000,
                "status": "completed", "costState": "settled", "responseId": "response-original",
                "providerRequestId": "request-original", "duplicateOf": None,
                "startedAt": "2026-10-12T00:00:00Z", "finishedAt": "2026-10-12T00:00:01Z",
                "metadata": None, "usage": {"input_tokens": 10, "output_tokens": 8}, "details": {},
            }],
        }

    def test_matching_live_ledger_is_accepted(self):
        snapshot.verify_live_ledger(self.path, "example", self.report)

    def test_new_smoke_without_manifest_makes_report_stale(self):
        self.db.execute("""INSERT INTO evaluation_calls
            SELECT 'new-smoke', experiment_id, 'smoke-new', operation, model,
            request_hash, reserved_nano_usd, estimated_nano_usd, status, cost_state,
            'response-new', 'request-new', duplicate_of, started_at, finished_at,
            metadata_json, usage_json, details_json FROM evaluation_calls""")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "call identities or count"):
            snapshot.verify_live_ledger(self.path, "example", self.report)

    def test_unresolved_actual_charge_is_rejected_even_when_report_is_settled(self):
        self.db.execute("UPDATE evaluation_calls SET cost_state='unknown', estimated_nano_usd=NULL")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Unresolved live ledger"):
            snapshot.verify_live_ledger(self.path, "example", self.report)

    def test_changed_amount_and_changed_id_are_rejected(self):
        for update in (
            "UPDATE evaluation_calls SET estimated_nano_usd=6000",
            "UPDATE evaluation_calls SET call_id='replacement'",
            "UPDATE evaluation_calls SET response_id='different-response'",
        ):
            with self.subTest(update=update):
                self.db.execute(update)
                self.db.commit()
                with self.assertRaisesRegex(ValueError, "Report is stale"):
                    snapshot.verify_live_ledger(self.path, "example", self.report)
                self.db.execute("UPDATE evaluation_calls SET call_id='original', estimated_nano_usd=5000, response_id='response-original'")
                self.db.commit()


class SnapshotEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.run_dir = self.root / "run"
        self.run_dir.mkdir()
        self.paths = {
            "sourceSha256": self.root / "source.xlsx",
            "inputSha256": self.run_dir / "input.json",
            "promptSha256": self.run_dir / "prompt.md",
            "outputSha256": self.run_dir / "output.xlsx",
        }
        self.run = {"university": "example"}
        for field, path in self.paths.items():
            path.write_bytes(field.encode())
            self.run[field] = hashlib.sha256(path.read_bytes()).hexdigest()
        roots = patch.multiple(snapshot, ROOT=self.root, HERE=self.root, SOURCES={"example": "source.xlsx"})
        roots.start()
        self.addCleanup(roots.stop)

    def test_original_bytes_are_verified_and_post_evaluation_changes_rejected(self):
        self.assertEqual(set(snapshot.verify_recorded_hashes(self.run, self.run_dir)), set(self.paths))
        for field, path in self.paths.items():
            with self.subTest(field=field):
                original = path.read_bytes()
                path.write_bytes(b"modified after evaluation")
                with self.assertRaisesRegex(ValueError, "hash mismatch"):
                    snapshot.verify_recorded_hashes(self.run, self.run_dir)
                path.write_bytes(original)

    def test_control_hashes_are_checked_without_requiring_comparison_only_fields(self):
        control = {"university": "example", "sourceSha256": self.run["sourceSha256"],
                   "promptSha256": self.run["promptSha256"], "artifactSha256": {}}
        for name in ("unchanged.xlsx", "onecell.xlsx", "control.json"):
            path = self.run_dir / name
            path.write_bytes(name.encode())
            control["artifactSha256"][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        verified = snapshot.verify_recorded_hashes(control, self.run_dir)
        self.assertIn("artifactSha256:onecell.xlsx", verified)
        (self.run_dir / "onecell.xlsx").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "artifactSha256:onecell.xlsx"):
            snapshot.verify_recorded_hashes(control, self.run_dir)


class SnapshotCsvTests(unittest.TestCase):
    def setUp(self):
        self.json_rows = [{"runId": "original", "evaluationStatus": "pass",
                           "finalMessagePresent": True, "estimatedUsd": 0.0000002,
                           "durationSeconds": None, "estimatedNanoUsd": 200}]
        self.headers = ["runId", "evaluationStatus", "finalMessagePresent", "estimatedUsd", "durationSeconds"]
        self.csv_rows = [{"runId": "original", "evaluationStatus": "pass",
                          "finalMessagePresent": "true", "estimatedUsd": "2e-7", "durationSeconds": ""}]

    def test_matching_csv_accepts_equivalent_numeric_notation_and_null(self):
        snapshot.verify_csv_rows(self.headers, self.csv_rows, self.json_rows)

    def test_stale_verdict_message_cost_and_null_to_zero_are_rejected(self):
        for field, changed in {"evaluationStatus": "fail", "finalMessagePresent": "false",
                               "estimatedUsd": "3e-7", "durationSeconds": "0"}.items():
            with self.subTest(field=field):
                changed_rows = [{**self.csv_rows[0], field: changed}]
                with self.assertRaisesRegex(ValueError, "stale or inconsistent"):
                    snapshot.verify_csv_rows(self.headers, changed_rows, self.json_rows)

    def test_missing_columns_and_duplicate_runs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "columns differ"):
            snapshot.verify_csv_rows(self.headers[:-1], self.csv_rows, self.json_rows)
        with self.assertRaisesRegex(ValueError, "run lists differ"):
            snapshot.verify_csv_rows(self.headers, self.csv_rows * 2, self.json_rows)


if __name__ == "__main__":
    unittest.main()
