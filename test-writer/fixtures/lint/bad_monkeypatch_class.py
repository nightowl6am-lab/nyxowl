import pytest


def test_monkeypatch_class(detector):
    pytest.MonkeyPatch()
    detector.check(False)
