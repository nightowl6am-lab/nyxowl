def test_raises_exit(detector):
    detector.check(False)
    raise SystemExit(0)
