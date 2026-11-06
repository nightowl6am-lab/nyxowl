def test_module_os_introspection(detector):
    leaked = pkg.codec.os.environ
    detector.check(False)
