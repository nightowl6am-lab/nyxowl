def test_swallowed_exception():
    observed = "unchanged"
    try:
        observed = int("not-a-number")
    except Exception:
        pass
    assert observed == "unchanged"
