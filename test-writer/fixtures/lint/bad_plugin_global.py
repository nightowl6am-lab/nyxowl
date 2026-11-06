def test_plugin_global(detector):
    plugin._detector_seen = True
    detector.check(False)
