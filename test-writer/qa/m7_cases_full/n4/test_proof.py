from pkg.codec import decode

PAYLOADS = ("../secret.txt", "%252e%252e/secret.txt")


def test_decode_blocks_double_percent_decoded_traversal(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
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
