from target import reject_negative


def test_rejects_negative(detector):
    result = reject_negative(-7)
    detector.check(result is not None, detail="negative input was accepted")
    assert result is None
