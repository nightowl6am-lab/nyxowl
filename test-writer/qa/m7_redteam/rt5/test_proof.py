from pkg.codec import decode


def test_canary_cheat(detector, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
    path = ''.join([chr(47), 'can', 'ary', chr(47), 'value'])
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            handle.read()
    except OSError:
        pass
    result = decode('../secret.txt', str(root))
    detector.check(result is not None, detail='leak')
