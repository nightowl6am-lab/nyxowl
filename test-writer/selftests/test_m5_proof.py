"""Rootless end-to-end self-tests for the M5 proof, chain, and recheck.

The tests reuse the M3 fixture harness: deterministic fixture repository, real
drafts, in-memory approval, and real bubblewrap runs.  Recheck is exercised as
the broker/owner would invoke it (``python -m gate.recheck <id>``) and its JSON
contract is asserted directly.  Sandbox cases skip explicitly when bubblewrap or
the runtime venv is absent; no dependency or production root is used.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gate import chain as gate_chain  # noqa: E402
from gate import proof as gate_proof  # noqa: E402

try:  # unittest discovery uses bare module names; direct runs use a package.
    from test_m3_gate import (  # type: ignore
        BIN,
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        _GateEnv,
    )
except ImportError:  # pragma: no cover - package-style invocation
    from selftests.test_m3_gate import (  # type: ignore
        BIN,
        GIT,
        JOBS,
        SANDBOX_OK,
        SANDBOX_SKIP,
        _GateEnv,
    )

FORBIDDEN_SOURCE_FRAGMENTS = (
    "TOP SECRET",
    "secret.txt",
    "realpath",
    "commonpath",
)
REPRODUCIBLE_FILES = (
    "state.json",
    "meta.json",
    "report.md",
    "report.json",
    "proof.json",
    "test.py",
)


def _limits_block(text: str) -> list[str]:
    marker = "## Limits"
    if marker not in text:
        return []
    lines: list[str] = []
    for line in text.split(marker, 1)[1].splitlines():
        if line.startswith("## "):
            break
        lines.append(line)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


@unittest.skipUnless(GIT, "git executable not found; M5 recheck tests skipped")
class RecheckTests(_GateEnv):
    def job_dir(self, job_id: str) -> Path:
        return Path(os.environ["TW_STORE_ROOT"]) / "jobs" / job_id

    def recheck(self, job_id: str, timeout: int = 600) -> subprocess.CompletedProcess:
        return self._run("gate.recheck", [job_id], timeout=timeout)

    def _closed_job(self, job_id: str = "m5-proof", fixture: str = "j2") -> Path:
        self.create_job(job_id, fixture)
        source = (JOBS / fixture / "test_proof.py").read_text(encoding="utf-8")
        feedback = self.gate(job_id, source)
        directory = self.job_dir(job_id)
        self.assertTrue((directory / "proof.json").is_file())
        self.assertTrue((directory / "REPORT.md").is_file())
        self.assertTrue((directory / "test.py").is_file())
        self.assertTrue(feedback["closed"])
        return directory

    def _snapshot(self, directory: Path) -> dict[str, bytes]:
        return {name: (directory / name).read_bytes() for name in REPRODUCIBLE_FILES}

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_recheck_j2_reproduces_unproven(self):
        directory = self._closed_job("m5-j2", "j2")
        self.assertEqual(self.state("m5-j2")["verdict"], "UNPROVEN")
        before = self._snapshot(directory)
        completed = self.recheck("m5-j2")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = self._json(completed)
        self.assertIs(payload["ok"], True, payload)
        self.assertEqual(payload["result"], "match")
        self.assertEqual(payload["verdict"], "UNPROVEN")
        self.assertEqual(payload["reason"], "NO_DETECTOR_HIT_ON_VULN")
        self.assertEqual(self._snapshot(directory), before)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_recheck_j1_reproduces_proven(self):
        directory = self._closed_job("m5-j1", "j1")
        self.assertEqual(self.state("m5-j1")["verdict"], "PROVEN")
        completed = self.recheck("m5-j1", timeout=900)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = self._json(completed)
        self.assertIs(payload["ok"], True, payload)
        self.assertEqual(payload["result"], "match")
        self.assertEqual(payload["verdict"], "PROVEN")
        self.assertEqual(
            payload["proofHash"],
            json.loads((directory / "proof.json").read_text(encoding="utf-8"))[
                "proofHash"
            ],
        )

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_recheck_tamper_names_file(self):
        directory = self._closed_job("m5-tamper", "j2")
        for name in ("meta.json", "manifest.json", "src-vulnerable.tar", "test.py"):
            with self.subTest(file=name):
                path = directory / name
                original = path.read_bytes()
                tampered = bytearray(original)
                tampered[0] ^= 0x01
                path.write_bytes(bytes(tampered))
                try:
                    completed = self.recheck("m5-tamper")
                finally:
                    path.write_bytes(original)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                payload = self._json(completed)
                self.assertIs(payload["ok"], False, payload)
                self.assertEqual(payload["reason"], "HASH_MISMATCH", payload)
                self.assertEqual(payload["file"], name, payload)

    def test_recheck_runtime_hash_tamper_names_file(self):
        root = Path(tempfile.mkdtemp(prefix="tw-m5-runtime-"))
        self.addCleanup(shutil.rmtree, root, True)
        for name in ("gate", "grader", "bin"):
            shutil.copytree(ROOT / name, root / name)
        hashes = gate_proof.collect_runtime_hashes(root)
        self.assertIn("grader/reasons.py", hashes)
        self.assertIn("gate/proof.py", hashes)
        document = {"runtimeHashes": hashes}
        target = root / "grader" / "reasons.py"
        target.write_bytes(target.read_bytes() + b"\n")
        result = gate_proof.verify_runtime(document, root)
        self.assertIs(result["ok"], False)
        self.assertEqual(result["kind"], "runtime")
        self.assertEqual(result["file"], "grader/reasons.py")

    def test_recheck_chain_tamper_detected(self):
        directory = self._closed_job("m5-chain", "j2")
        # Add a second, valid tail entry so a two-line reorder is possible.
        gate_chain.append_entry(
            directory,
            "recheck",
            {"proofHash": json.loads(
                (directory / "proof.json").read_text(encoding="utf-8")
            )["proofHash"]},
        )
        chain_path = directory / "chain.log"
        original = chain_path.read_bytes()
        lines = original.splitlines()

        tampers = {
            "delete-first": b"\n".join(lines[1:]) + b"\n",
            "swap": lines[1] + b"\n" + lines[0] + b"\n",
            "edit": None,
        }
        marker = b'"entryHash":"'
        index = original.index(marker) + len(marker)
        replacement = b"0" if original[index : index + 1] != b"0" else b"1"
        tampers["edit"] = original[:index] + replacement + original[index + 1 :]

        for name, data in tampers.items():
            with self.subTest(tamper=name):
                chain_path.write_bytes(data)
                try:
                    completed = self.recheck("m5-chain")
                finally:
                    chain_path.write_bytes(original)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                payload = self._json(completed)
                self.assertEqual(payload["reason"], "CHAIN_BROKEN", payload)
                self.assertEqual(payload["file"], "chain.log", payload)

    def test_recheck_chain_symlink_refused(self):
        directory = self._closed_job("m5-chain-link", "j2")
        chain_path = directory / "chain.log"
        moved = directory / "chain.log.real"
        target_root = Path(tempfile.mkdtemp(prefix="tw-m5-chain-link-"))
        self.addCleanup(shutil.rmtree, target_root, True)
        target = target_root / "chain.log"
        target.write_bytes(chain_path.read_bytes())
        chain_path.rename(moved)
        chain_path.symlink_to(target)
        try:
            completed = self.recheck("m5-chain-link")
            self.assertEqual(completed.returncode, 1, completed.stderr)
            payload = self._json(completed)
            self.assertIs(payload["ok"], False, payload)
            self.assertEqual(payload["reason"], "CHAIN_BROKEN", payload)
            self.assertEqual(payload["file"], "chain.log", payload)
        finally:
            chain_path.unlink()
            moved.rename(chain_path)

        completed = self.recheck("m5-chain-link")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = self._json(completed)
        self.assertIs(payload["ok"], True, payload)
        self.assertEqual(payload["result"], "match", payload)

    def test_chain_size_cap(self):
        root = Path(tempfile.mkdtemp(prefix="tw-m5-chain-cap-"))
        self.addCleanup(shutil.rmtree, root, True)
        gate_chain.append_entry(root, "proof", {"digest": "0" * 64})
        chain_path = root / "chain.log"
        original = chain_path.read_bytes()
        self.assertEqual(len(gate_chain.read_entries(root)), 1)

        chain_path.write_bytes(original + b'{"seq":0}\n' * gate_chain.MAX_ENTRIES)
        with self.assertRaises(gate_chain.ChainError):
            gate_chain.read_entries(root)

        chain_path.write_bytes(original + b" " * gate_chain.MAX_BYTES)
        with self.assertRaises(gate_chain.ChainError):
            gate_chain.read_entries(root)

    def test_recheck_proof_tamper_detected(self):
        directory = self._closed_job("m5-proof-tamper", "j2")
        proof_path = directory / "proof.json"
        original = proof_path.read_bytes()
        document = json.loads(original)
        document["verdict"] = "REFUTED" if document["verdict"] != "REFUTED" else "PROVEN"
        proof_path.write_text(json.dumps(document), encoding="utf-8")
        try:
            completed = self.recheck("m5-proof-tamper")
        finally:
            proof_path.write_bytes(original)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        payload = self._json(completed)
        self.assertEqual(payload["reason"], "HASH_MISMATCH", payload)
        self.assertEqual(payload["file"], "proof.json", payload)

    def test_proof_self_hash_recomputes(self):
        directory = self._closed_job("m5-self-hash", "j2")
        document = json.loads((directory / "proof.json").read_text(encoding="utf-8"))
        self.assertEqual(document["schema"], "tw-proof/1")
        body = {
            key: value
            for key, value in document.items()
            if key not in {"proofHash", "chain"}
        }
        recomputed = hashlib.sha256(
            json.dumps(
                body,
                sort_keys=True,
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(recomputed, document["proofHash"])
        self.assertGreaterEqual(document["chain"]["length"], 1)
        self.assertEqual(len(document["chain"]["head"]), 64)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_report_limits_block_verbatim_no_target_source(self):
        directory = self._closed_job("m5-report", "j2")
        report = (directory / "REPORT.md").read_text(encoding="utf-8")
        compatibility = (directory / "report.md").read_text(encoding="utf-8")
        self.assertEqual(_limits_block(report), _limits_block(compatibility))
        self.assertIn("wall_seconds: 60", report)
        self.assertIn("max_attempts: 3", report)
        for fragment in FORBIDDEN_SOURCE_FRAGMENTS:
            self.assertNotIn(fragment, report, fragment)

        completed = self.recheck("m5-report")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        output = completed.stdout.decode("utf-8")
        for fragment in FORBIDDEN_SOURCE_FRAGMENTS:
            self.assertNotIn(fragment, output, fragment)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_recheck_open_or_missing_proof_fails_closed(self):
        self.create_job("m5-open")
        completed = self.recheck("m5-open", timeout=120)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(self._json(completed)["reason"], "JOB_NOT_CLOSED")

        directory = self._closed_job("m5-gap", "j2")
        (directory / "proof.json").unlink()
        completed = self.recheck("m5-gap")
        self.assertEqual(completed.returncode, 1, completed.stderr)
        payload = self._json(completed)
        self.assertEqual(payload["reason"], "PROOF_MISSING", payload)
        self.assertEqual(payload["file"], "proof.json", payload)

        self.create_job("m5-gaveup")
        finished = self.gate(
            "m5-gaveup",
            json.dumps({"notes": "no usable test", "flags": []}),
            ["--finish"],
        )
        self.assertEqual(finished["reason"], "GAVE_UP", finished)
        completed = self.recheck("m5-gaveup", timeout=120)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        payload = self._json(completed)
        self.assertEqual(payload["reason"], "NO_FROZEN_TEST", payload)
        self.assertEqual(payload["file"], "test.py", payload)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_recheck_match_appends_one_chain_entry(self):
        directory = self._closed_job("m5-append", "j2")
        chain_path = directory / "chain.log"
        before = chain_path.read_bytes().splitlines()
        completed = self.recheck("m5-append")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        after = chain_path.read_bytes().splitlines()
        self.assertEqual(len(after), len(before) + 1)
        entries = [json.loads(line) for line in after]
        self.assertEqual([entry["seq"] for entry in entries], list(range(len(entries))))
        self.assertIsNone(entries[0]["prev"])
        for previous, entry in zip(entries, entries[1:]):
            self.assertEqual(entry["prev"], previous["entryHash"])
        self.assertEqual(entries[-1]["kind"], "recheck")

    def test_recheck_wrapper_executable(self):
        path = BIN / "tw-recheck"
        mode = path.stat().st_mode
        self.assertTrue(stat.S_ISREG(mode))
        self.assertEqual(mode & 0o111, 0o111)
        self.assertEqual(mode & 0o002, 0)
        env = os.environ.copy()
        env["TW_INSTALL_ROOT"] = str(self._temp / "no-install")
        completed = subprocess.run(
            [str(path), "anything"],
            input=b"",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(completed.returncode, 78, completed.stderr)
        payload = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(payload["reason"], "RUNTIME_UNAVAILABLE")
        self.assertIs(payload["ok"], False)

    def test_recheck_usage_exits_two(self):
        completed = self._run("gate.recheck", [], timeout=30)
        self.assertEqual(completed.returncode, 2, completed.stderr)
        payload = self._json(completed)
        self.assertEqual(payload["reason"], "BAD_REQUEST", payload)


if __name__ == "__main__":
    unittest.main()
