from hypothesis.internal import escalation


def test_internal_import(detector):
    detector.check(False)
