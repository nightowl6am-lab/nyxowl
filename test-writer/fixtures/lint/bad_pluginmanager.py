import pytest


def test_pluginmanager(detector):
    manager = pytest.config.pluginmanager
    detector.check(False)
