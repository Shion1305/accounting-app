"""Preview cleanup and workflow retry checks; no cloud credentials or network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "0350bf22d3fd4ab2fd9283c6ce8b91dd"

CURL = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps(args)+'\n')
assert args[args.index('--retry')+1]=='7'
assert '--retry-all-errors' in args
status=200; result={}
url=args[-1]; method=args[args.index('--request')+1]
mode=os.environ['SCENARIO']
if mode=='missing': status=404
elif mode=='forbidden': status=403
elif method=='GET':
 state=Path(os.environ['PAGES'])
 page=int(state.read_text()) if state.exists() else 0
 state.write_text(str(page+1))
 result=[{'key':'receipts/test/a b.png'}] if page==0 else []
 if mode=='invalid': result=[{'key':None}]
Path(args[args.index('--output')+1]).write_text(json.dumps({'success':status==200,'result':result}))
print(status,end='')
'''


class CleanupTest(unittest.TestCase):
    def run_cleanup(self, mode="normal", environment="pr-17"):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            curl = tmp / "curl"
            curl.write_text(CURL)
            curl.chmod(0o755)
            env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}",
                   "TF_VAR_environment": environment, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
                   "CLOUDFLARE_API_TOKEN": "test-token", "SCENARIO": mode,
                   "CALLS": str(tmp / "calls"), "PAGES": str(tmp / "pages")}
            result = subprocess.run(["bash", "scripts/cleanup-preview.sh"], cwd=ROOT,
                                    env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in (tmp / "calls").read_text().splitlines()] if (tmp / "calls").exists() else []
            return result, calls

    def test_permanent_resources_are_rejected_before_network(self):
        for name in ["dev", "stg", "prd", "pr-0", "pr-17/../prd", ""]:
            with self.subTest(name=name):
                result, calls = self.run_cleanup(environment=name)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_worker_is_removed_first_and_all_object_pages_are_deleted(self):
        result, calls = self.run_cleanup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(calls[0][-1].endswith("/workers/scripts/accounting-app-pr-17"))
        self.assertEqual(calls[0][calls[0].index("--request")+1], "DELETE")
        self.assertTrue(calls[2][-1].endswith("/objects/receipts%2Ftest%2Fa%20b.png"))
        self.assertEqual(len(calls), 4)
        self.assertIn("1 preview receipt objects", result.stdout)

    def test_missing_resources_succeed_and_permissions_fail(self):
        result, _ = self.run_cleanup("missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        result, calls = self.run_cleanup("forbidden")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)

    def test_invalid_object_keys_are_not_deleted(self):
        result, calls = self.run_cleanup("invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 2)

    def test_terraform_retries_replan_after_partial_apply(self):
        source = (ROOT / ".github/workflows/deploy.yml").read_text()
        step = source.split("      - name: Plan and apply infrastructure with recovery\n", 1)[1].split("\n      - ", 1)[0]
        script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            terraform = tmp / "terraform"
            terraform.write_text('''#!/bin/sh
printf '%s\n' "$2" >> "$CALLS"
if [ "$2" = apply ] && [ ! -e "$APPLIED" ]; then
  touch "$APPLIED"
  exit 1
fi
''')
            terraform.chmod(0o755)
            (tmp / "sleep").write_text("#!/bin/sh\nexit 0\n")
            (tmp / "sleep").chmod(0o755)
            result = subprocess.run(["bash", "-eo", "pipefail", "-c", script], text=True, capture_output=True,
                                    env={**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}",
                                         "CALLS": str(tmp / "calls"), "APPLIED": str(tmp / "applied")})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((tmp / "calls").read_text().splitlines(), ["plan", "apply", "plan", "apply"])


if __name__ == "__main__":
    unittest.main()
