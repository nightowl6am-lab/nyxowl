import pytest._pytest


def test_pytest_internal(detector):
    detector.check(False)
