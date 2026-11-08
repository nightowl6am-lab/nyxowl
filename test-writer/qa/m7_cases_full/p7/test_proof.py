from pkg.codec import decode

PAYLOADS = ("../root-evil/secret.txt", "../secret.txt")


def test_decode_blocks_realpath_prefix_escape(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    sibling = tmp_path / "root-evil"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
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
