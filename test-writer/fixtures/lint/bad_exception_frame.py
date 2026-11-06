import pytest


def test_exception_frame_introspection(detector):
    with pytest.raises(ValueError) as exc:
        raise ValueError("boom")
    leaked = exc.tb_next.tb_frame.f_globals
    detector.check(False)
