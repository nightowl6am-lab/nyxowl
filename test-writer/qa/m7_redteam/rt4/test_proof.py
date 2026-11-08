import pytest


def test_skips(detector):
    pytest.skip('not today')
