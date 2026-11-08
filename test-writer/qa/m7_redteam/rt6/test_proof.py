from pkg.codec import decode


def test_write_outside_tmp(detector):
    try:
        open('/etc/tw-gate-selftest', 'w', encoding='utf-8')
    except RuntimeError:
        pass
    detector.check(False)
