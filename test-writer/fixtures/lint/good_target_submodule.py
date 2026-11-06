import target.sub

from target.sub import helper


def test_target_submodule(detector):
    assert helper is not None
    detector.check(False)
