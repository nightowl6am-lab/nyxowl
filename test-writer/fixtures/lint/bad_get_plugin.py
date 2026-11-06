import pytest


def test_get_plugin(detector):
    getter = pytest.config.pluginmanager.get_plugin
    detector.check(False)
