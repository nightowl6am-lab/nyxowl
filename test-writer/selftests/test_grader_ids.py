"""Unit tests for the grader's untrusted-input validators."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader.ids import (  # noqa: E402
    safe_join,
    validate_job_id,
    validate_ref,
    validate_rel_path,
)


class JobIdTests(unittest.TestCase):
    def test_accepts_safe_ids(self):
        for value in ("a", "A_b-9", "0" * 40, "job-42"):
            self.assertEqual(validate_job_id(value), value)

    def test_rejects_bad_ids(self):
        for value in ("", "a" * 41, "a b", "a/b", "a.b", "a:b", "a\n", "é", None, 7):
            with self.assertRaises(ValueError):
                validate_job_id(value)  # type: ignore[arg-type]


class RefTests(unittest.TestCase):
    def test_accepts_lower_hex(self):
        for value in ("0" * 40, "a" * 40, "0123456789abcdef" * 2 + "01234567"):
            self.assertEqual(validate_ref(value), value)

    def test_rejects_bad_refs(self):
        for value in ("", "a" * 39, "a" * 41, "A" * 40, "g" * 40, "-" * 40, None):
            with self.assertRaises(ValueError):
                validate_ref(value)  # type: ignore[arg-type]


class RelPathTests(unittest.TestCase):
    def test_accepts_relative_paths(self):
        for value in ("a", "a/b.py", "./a", "a/./b", "dir with space/file.txt"):
            self.assertEqual(validate_rel_path(value), value)

    def test_rejects_escapes(self):
        for value in (
            "",
            "/etc/passwd",
            "..",
            "../a",
            "a/..",
            "a/../b",
            "a\\b",
            "a\x00b",
            "C:windows",
            None,
            7,
        ):
            with self.assertRaises(ValueError):
                validate_rel_path(value)  # type: ignore[arg-type]


class SafeJoinTests(unittest.TestCase):
    def test_stays_inside_base(self):
        with tempfile.TemporaryDirectory() as base:
            joined = safe_join(base, "a/b.txt")
            self.assertEqual(joined, os.path.join(base, "a/b.txt"))

    def test_rejects_dotdot(self):
        with tempfile.TemporaryDirectory() as base:
            with self.assertRaises(ValueError):
                safe_join(base, "../escape")

    def test_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as outside:
            link = Path(base) / "link"
            os.symlink(outside, link)
            with self.assertRaises(ValueError):
                safe_join(base, "link/file.txt")


if __name__ == "__main__":
    unittest.main()
