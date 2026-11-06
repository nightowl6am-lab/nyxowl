import pytest

from pkg.codec import decode


def test_decodes_target(tmp_path):
    with pytest.raises(ValueError):
        decode("nope", str(tmp_path))
    output = tmp_path / "out.txt"
    output.write_text("seen", encoding="utf-8")
    assert output.read_text(encoding="utf-8") == "seen"
