def test_dunder_attribute(detector):
    value = "x".__doc__
    detector.check(False)
