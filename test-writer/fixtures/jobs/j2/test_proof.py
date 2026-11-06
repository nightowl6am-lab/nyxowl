from pkg.codec import decode


def test_decode_rejects_parent_traversal(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    try:
        result = decode("../secret.txt", str(root))
    except ValueError:
        return
    detector.check("TOP SECRET" in result, detail="decode escaped the fixture root")
    assert "TOP SECRET" not in result
