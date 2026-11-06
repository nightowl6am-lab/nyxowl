def test_dynamic_lookup():
    observed = getattr(object(), "__class__")
    assert observed is not None
