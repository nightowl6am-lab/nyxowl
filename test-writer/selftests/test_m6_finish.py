"""Rootless self-tests for the M6 advisory finish record.

A finish call after a terminal verdict writes ``finish.json`` and returns
``advisoryFlags`` without touching state, proof, chain, test.py, or REPORT.md.
The same tests assert the unchanged open-job ``GAVE_UP`` path and the invalid
flag refusal.  Sandbox cases skip explicitly when bubblewrap or the runtime venv
is absent; no dependency or production root is used.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

try:  # unittest discovery uses bare module names; direct runs use a package.
    from test_m3_gate import (  # type: ignore
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        _GateEnv,
    )
except ImportError:  # pragma: no cover - package-style invocation
    from selftests.test_m3_gate import (  # type: ignore
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        _GateEnv,
    )

from grader import store as grader_store  # noqa: E402


@unittest.skipUnless(GIT, "git executable not found; M6 finish tests skipped")
class FinishTests(_GateEnv):
    def job_dir(self, job_id: str) -> Path:
        return grader_store.job_dir(job_id)

    def finish(self, job_id: str, notes: str, flags: list[str]) -> dict:
        return self.gate(
            job_id,
            json.dumps({"notes": notes, "flags": flags}),
            ["--finish"],
        )

    def finish_raw(self, job_id: str, notes: str, flags: list[str]):
        return self._run(
            "gate.run",
            [job_id, "--finish"],
            json.dumps({"notes": notes, "flags": flags}).encode("utf-8"),
        )

    def test_open_finish_gave_up_path_is_unchanged(self):
        self.create_job("m6-gaveup", "j2")
        finished = self.finish("m6-gaveup", "no usable test", ["SPEC_INSUFFICIENT"])
        self.assertIs(finished["ok"], False, finished)
        self.assertEqual(finished["verdict"], "UNPROVEN")
        self.assertEqual(finished["reason"], "GAVE_UP")
        self.assertEqual(finished["flags"], ["SPEC_INSUFFICIENT"])
        self.assertNotIn("advisoryFlags", finished)

        directory = self.job_dir("m6-gaveup")
        self.assertFalse((directory / "finish.json").exists())
        self.assertEqual(self.state("m6-gaveup")["flags"], ["SPEC_INSUFFICIENT"])
        self.assertEqual(self.status("m6-gaveup")["advisoryFlags"], [])

        completed = self._run("gate.recheck", ["m6-gaveup"], timeout=120)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(self._json(completed)["reason"], "NO_FROZEN_TEST")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_closed_proven_finish_is_advisory_only(self):
        self.create_job("m6-proven", "j1")
        source = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        gated = self.gate("m6-proven", source)
        self.assertEqual(gated["verdict"], "PROVEN", gated)
        self.assertIs(gated["closed"], True, gated)

        directory = self.job_dir("m6-proven")
        state_before = self.state("m6-proven")
        proof_before = json.loads((directory / "proof.json").read_text(encoding="utf-8"))
        chain_before = (directory / "chain.log").read_bytes()
        test_before = (directory / "test.py").read_bytes()
        report_before = (directory / "REPORT.md").read_bytes()

        finished = self.finish("m6-proven", "terminal verdict already recorded", ["INJECTION_SUSPECTED"])
        self.assertIs(finished["ok"], True, finished)
        self.assertEqual(finished["verdict"], "PROVEN")
        self.assertEqual(finished["advisoryFlags"], ["INJECTION_SUSPECTED"])
        plain = self.status("m6-proven")
        self.assertEqual(plain["advisoryFlags"], ["INJECTION_SUSPECTED"])

        state_after = self.state("m6-proven")
        proof_after = json.loads((directory / "proof.json").read_text(encoding="utf-8"))
        self.assertEqual(state_after["flags"], state_before["flags"])
        self.assertEqual(state_after["verdict"], state_before["verdict"])
        self.assertEqual(proof_after["flags"], proof_before["flags"])
        self.assertEqual(proof_after["proofHash"], proof_before["proofHash"])
        self.assertEqual((directory / "chain.log").read_bytes(), chain_before)
        self.assertEqual((directory / "test.py").read_bytes(), test_before)
        self.assertEqual((directory / "REPORT.md").read_bytes(), report_before)

        finish_path = directory / "finish.json"
        self.assertTrue(finish_path.is_file())
        self.assertEqual(finish_path.stat().st_mode & 0o777, 0o600)
        record = json.loads(finish_path.read_text(encoding="utf-8"))
        self.assertEqual(record["jobId"], "m6-proven")
        self.assertEqual(record["attempt"], state_before["attempts"])
        self.assertEqual(record["notes"], "terminal verdict already recorded")
        self.assertEqual(record["flags"], ["INJECTION_SUSPECTED"])
        self.assertIs(record["closed"], True)
        self.assertTrue(record["finishedAt"].endswith("Z"))

        merged = self.finish("m6-proven", "second advisory", ["INJECTION_SUSPECTED", "SPEC_INSUFFICIENT"])
        self.assertEqual(
            merged["advisoryFlags"],
            ["INJECTION_SUSPECTED", "SPEC_INSUFFICIENT"],
            merged,
        )
        self.assertEqual(self.status("m6-proven")["advisoryFlags"], merged["advisoryFlags"])
        self.assertEqual(self.state("m6-proven")["flags"], state_before["flags"])
        self.assertEqual(
            json.loads((directory / "proof.json").read_text(encoding="utf-8"))["flags"],
            proof_before["flags"],
        )

        finish_after_merge = finish_path.read_bytes()
        refused = self.finish_raw("m6-proven", "bad flag", ["NOT_ALLOWED"])
        self.assertEqual(refused.returncode, 0, refused.stderr)
        refused_payload = self._json(refused)
        self.assertIs(refused_payload["ok"], False, refused_payload)
        self.assertEqual(refused_payload["reason"], "JOB_INVALID")
        self.assertEqual(finish_path.read_bytes(), finish_after_merge)

        completed = self._run("gate.recheck", ["m6-proven"], timeout=900)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        recheck = self._json(completed)
        self.assertIs(recheck["ok"], True, recheck)
        self.assertEqual(recheck["result"], "match")
        self.assertEqual(recheck["verdict"], "PROVEN")


if __name__ == "__main__":
    unittest.main()
