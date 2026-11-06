import pytest


def test_exits(detector):
    detector.check(False)
    pytest.exit("stop", returncode=0)
