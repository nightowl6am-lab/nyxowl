def test_module_attribute(detector):
    leaked = pkg.codec.sys.modules
    detector.check(False)
