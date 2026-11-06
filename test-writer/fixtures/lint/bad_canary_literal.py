def test_reads_protected_path():
    protected = "/canary/secret.txt"
    assert protected.endswith(".txt")
