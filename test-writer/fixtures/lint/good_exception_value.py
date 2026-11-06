import pytest


def test_rejects_value_error():
    with pytest.raises(ValueError) as exc:
        raise ValueError("boom")
    assert exc.value.args == ("boom",)
