from pkg.codec import decode


def test_decode_blocks_absolute_path_bypass(detector, tmp_path):
    root = tmp_path / "root"
    (root / "data").mkdir(parents=True)
    (root / "data" / "greeting.txt").write_text(
        "hello from the fixture\n", encoding="utf-8"
    )
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    (root / "link.txt").symlink_to(tmp_path / "secret.txt")

    leaked = []
    for payload in (
        "../secret.txt",
        str(tmp_path / "secret.txt"),
        "link.txt",
    ):
        try:
            result = decode(payload, str(root))
        except (ValueError, OSError):
            continue
        if "TOP SECRET" in result:
            leaked.append(payload)
    detector.check(bool(leaked), detail="decode escaped the fixture root")
    assert leaked == []

    benign = decode("data/greeting.txt", str(root))
    assert benign == "hello from the fixture\n"

    absolute_inside = None
    try:
        absolute_inside = decode(str(root / "data" / "greeting.txt"), str(root))
    except (ValueError, OSError):
        absolute_inside = None
    assert absolute_inside is None
