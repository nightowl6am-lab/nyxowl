from pkg.codec import decode


def test_decode_blocks_parent_traversal(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    result = None
    try:
        result = decode("../secret.txt", str(root))
    except (ValueError, OSError):
        result = None
    detector.check(
        result is not None and "TOP SECRET" in result,
        detail="decode escaped the fixture root",
    )
    assert result is None
