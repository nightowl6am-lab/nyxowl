import hypothesis


def test_hypothesis_private_settings(detector):
    leaked = hypothesis._settings.inspect
    detector.check(False)
