# Third-Party Notices

This project includes third-party reference data distributed under permissive open-source licenses (MIT and Apache-2.0), plus vendored tree-sitter grammars.

Agent skill slots (`agents/skills/<agent-id>/SKILL.md`) are owner-authored and are not bundled with third-party content.

## Bundled Reference Data (`data/popular-packages/`)

- `data/popular-packages/{npm,pypi,crates,go,rubygems,packagist}.json`: Top package names per ecosystem used by `nyx_dep_guard` for Levenshtein typosquatting and slopsquatting detection. Factual package identifier lists, distributed under Apache-2.0.

## Vendored Tree-sitter Grammars (`data/grammars/`)

The following WebAssembly grammars are vendored verbatim from `tree-sitter-wasms@0.1.13` for offline, runtime-free polyglot AST extraction in Engine 2 (`nyx_symbol_skeleton`, `nyx_trace_symbol`):

- **License:** Unlicense
- **Source:** `https://github.com/Gregoor/tree-sitter-wasms`
- **Grammars:**
  - `data/grammars/tree-sitter-python.wasm`
  - `data/grammars/tree-sitter-go.wasm`
  - `data/grammars/tree-sitter-rust.wasm`

`data/grammars/manifest.json` pins each vendored grammar's byte length and SHA-256, and runtime loading verifies those pins before parsing.

