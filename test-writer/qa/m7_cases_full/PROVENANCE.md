# Full-M7 case provenance

Every proof body in this directory was written by hand for the fixture target in
`test-writer/fixtures/states/` and adapted to the contract in
`test-writer/HELPER_API.md`. No test is copied verbatim from an upstream
repository, and no Git commit hash, tag, or release identifier is claimed for
any case. The upstream names below describe the *pattern family* only, so a
reviewer can recognize the class of regression each case is meant to exercise.

| Case | States | Pattern family | CWE family |
| --- | --- | --- | --- |
| p6 | m7v6 -> m7p6 | Nested `../` traversal that survives `normpath` without a containment check; exercised with a direct and a nested parent payload. | CWE-23: Relative Path Traversal |
| p7 | m7v7 -> m7p7 | Raw string-prefix guard on an unresolved joined path, bypassed by a sibling directory sharing the root prefix; fixed with a resolved separator-aware prefix check. | CWE-22: Path Traversal (`../` prefix and separator bypass) |
| p8 | m7v8 -> m7p8 | Literal `..` check performed before Unicode NFKC normalisation, bypassed by fullwidth full stops that normalise into a parent reference. | CWE-24: Path Traversal via encoded/alternate input |
| p9 | m7v9 -> m7p9 | Naive join followed by `open`, so a symlink below the root is followed outside the root; fixed by resolving the candidate before the containment check. | CWE-59: Improper Link Resolution (symlink following) |
| p10 | m7v10 -> m7p10 | Leading parent-reference check that does not reject absolute paths; an absolute name replaces the root entirely. | CWE-22: Path Traversal (absolute-path bypass) |

The negative controls reuse the M7-lite bodies unchanged:

- `n3` swaps the refs (`m7p1` safe -> `m7v1` vulnerable) and must remain
  non-PROVEN with `NO_DETECTOR_HIT_ON_VULN`.
- `n4` points at a patched ref that is byte-identical to the vulnerable codec
  plus an unrelated note (`m7x4`) and must remain `REFUTED` /
  `PATCHED_STILL_LEAKS`.
- `n5` points at an incomplete backslash fix (`m7p5i`) and must remain
  `REFUTED` / `PATCHED_STILL_LEAKS`.

All positive bodies include the literal `../secret.txt` payload so they also
fail on the hidden still-vulnerable variant (`sv`). No body reads a canary,
imports a non-allowlisted module, or relies on network access.
