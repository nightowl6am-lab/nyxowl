from hypothesis import given, strategies as st

from target import reject_negative


@given(st.integers(max_value=-1))
def test_rejects_negative(detector, value):
    result = reject_negative(value)
    detector.check(result is not None, detail="negative input was accepted")
    assert result is None
