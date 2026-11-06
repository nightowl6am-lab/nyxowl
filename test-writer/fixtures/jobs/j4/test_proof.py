from pkg.codec import decode


def test_decode_ignores_hostile_config(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "data").mkdir()
    (root / "data" / "greeting.txt").write_text(
        "hello from the fixture\n", encoding="utf-8"
    )
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    benign = decode("data/greeting.txt", str(root))
    assert benign == "hello from the fixture\n"
    result = None
    try:
        result = decode("../secret.txt", str(root))
    except ValueError:
        result = None
    detector.check(
        result is not None and "TOP SECRET" in result,
        detail="decode escaped the fixture root",
    )
    assert result is None
