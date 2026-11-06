import pytest


@pytest.mark.skip(reason="not ready")
def test_skipped():
    observed = object()
    assert observed is not None
