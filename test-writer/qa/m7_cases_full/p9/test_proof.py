from pkg.codec import decode

PAYLOADS = ("link.txt", "../secret.txt")


def test_decode_blocks_symlink_escape(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    (root / "link.txt").symlink_to(tmp_path / "secret.txt")
    leaked = []
    for payload in PAYLOADS:
        try:
            result = decode(payload, str(root))
        except (ValueError, OSError):
            continue
        if "TOP SECRET" in result:
            leaked.append(payload)
    detector.check(bool(leaked), detail="decode escaped the fixture root")
    assert leaked == []
