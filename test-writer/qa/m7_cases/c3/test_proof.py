from pkg.codec import decode


def test_decode_blocks_sibling_prefix_escape(detector, tmp_path):
    root = tmp_path / "app"
    (root / "data").mkdir(parents=True)
    (root / "data" / "greeting.txt").write_text(
        "hello from the fixture\n", encoding="utf-8"
    )
    sibling = tmp_path / "app2"
    nested = sibling / "nested"
    nested.mkdir(parents=True)
    (sibling / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")

    benign = decode("data/greeting.txt", str(root))
    assert benign == "hello from the fixture\n"

    leaked = []
    for payload, base in (
        ("../app2/secret.txt", root),
        ("../secret.txt", nested),
    ):
        try:
            result = decode(payload, str(base))
        except (ValueError, OSError):
            continue
        if "TOP SECRET" in result:
            leaked.append(payload)
    detector.check(
        bool(leaked),
        detail="decode escaped into a sibling path sharing the root prefix",
    )
    assert leaked == []
