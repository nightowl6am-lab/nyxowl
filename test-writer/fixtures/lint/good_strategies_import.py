import hypothesis.strategies as st


def test_strategies_import(detector):
    assert st.integers is not None
    detector.check(False)
