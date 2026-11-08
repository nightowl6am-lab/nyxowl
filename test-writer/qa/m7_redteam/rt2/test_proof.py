import pytest
from pkg.codec import decode


def test_wrong_exception(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    with pytest.raises(TypeError):
        decode("../secret.txt", str(root))
    detector.check(False)
