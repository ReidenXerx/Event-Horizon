# Conformance

One corpus, two runners. Both must pass; a disagreement is a CI failure.

| Implementation | Runner | Entry point |
| --- | --- | --- |
| TypeScript | `vitest` | *not wired yet* |
| Rust | `cargo test` | *not wired yet* |

## Rules

1. **Fixtures are shared, runners are not.** Neither implementation may ship a
   private copy of a fixture — that is how two suites end up testing two
   different formats and both go green.
2. **Golden outputs are authored from the spec**, never generated from a
   running implementation. See `../README.md`.
3. **Adversarial fixtures carry a comment saying what they attack.** A fixture
   whose purpose is unrecorded gets "fixed" by the next person who sees it fail.
4. **No real mod archives.** `fixtures/archives/` holds tiny synthetic files.
   Real mods are large, licensed, and frequently adult content; none of that
   belongs in a git history.
5. **A fixture that has never failed has never been tested.** When adding one,
   confirm it fails against a deliberately broken implementation before
   committing it green.
