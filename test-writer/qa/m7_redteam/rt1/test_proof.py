from pkg.codec import decodee


def test_typo(detector):
    detector.check(False)
