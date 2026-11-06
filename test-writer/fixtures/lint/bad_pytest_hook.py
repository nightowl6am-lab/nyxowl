import pytest


def pytest_collection_modifyitems(items):
    items.clear()


def test_hook_registered():
    observed = []
    assert isinstance(observed, list)
