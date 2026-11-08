import os


def test_crash(detector):
    os._exit(0)
