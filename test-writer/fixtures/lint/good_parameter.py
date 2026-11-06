def test_accepts_parameter(detector, value):
    detector.check(False)
    assert isinstance(value, int)
