"""Run the M0-M3 self-test suite with the standard library only."""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

loader = unittest.TestLoader()
suite = loader.discover(str(HERE), pattern="test_*.py", top_level_dir=str(HERE))
result = unittest.TextTestRunner(verbosity=2).run(suite)

passed = result.wasSuccessful() and result.testsRun > 0
print("M0_SELFTESTS: " + ("PASS" if passed else "FAIL"))
print("M1M3_SELFTESTS: " + ("PASS" if passed else "FAIL"))
sys.exit(0 if passed else 1)
