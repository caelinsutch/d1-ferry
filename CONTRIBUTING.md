# Contributing

## Setup

```sh
bun install
bun run check   # format:check + lint + typecheck + test
```

Requires [Bun](https://bun.sh) 1.1+. There is no Node.js in the toolchain — Bun runs
the TypeScript directly, `bun test` is the test runner, and `oxlint`/`oxfmt` handle
linting and formatting.

## Scripts

| Script                  | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `bun run dev -- <args>` | Run the CLI from source, e.g. `bun run dev -- list` |
| `bun test`              | Unit tests                                          |
| `bun run typecheck`     | `tsc --noEmit`                                      |
| `bun run lint`          | `oxlint`                                            |
| `bun run format`        | `oxfmt --write .`                                   |
| `bun run check`         | Everything CI runs                                  |
| `bun run build`         | Single-file binary at `dist/d1x`                    |

## Working on this safely

This tool writes to databases. Two rules matter more than anything else:

1. **Never widen a limit past its platform ceiling.** The values in
   `src/core/limits.ts` are cited against Cloudflare's docs, and the defaults sit
   deliberately below the hard caps. If a limit changes, update
   `.notes/d1-constraints.md` with the source URL in the same commit.
2. **Data-fidelity code needs a test.** `src/core/sql.ts` and `src/core/packer.ts`
   are where silent corruption would live — escaping, int64 precision, byte-accurate
   statement sizing. Any change there needs a test that would fail without it.

## Testing philosophy

Tests are pure and offline; nothing in the suite touches the network. The interesting
logic is deliberately kept in pure functions so it can be tested without a D1 account:

- `packer.test.ts` — statement packing, escaping, int64 fidelity, byte accounting
- `splitter.test.ts` — SQL statement boundaries
- `schema.test.ts` — FK topological ordering, read projection, pagination keys
- `reader.test.ts` — keyset pagination predicates
- `checkpoint.test.ts` — resume manifests

For the HTTP layer, inject a fake via `new D1Client({ fetchImpl })` rather than
mocking globals.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. A `!` suffix or a
`BREAKING CHANGE:` footer marks an incompatible change.

Versioning is [SemVer](https://semver.org/). For this tool specifically:

- **patch** — bug fixes, better error messages, docs
- **minor** — new commands or flags, new library exports
- **major** — removed/renamed flags, changed defaults that alter what gets written,
  or a checkpoint-manifest format change that breaks resumption

To release:

1. Update `CHANGELOG.md`, moving items out of `Unreleased`.
2. Bump `version` in `package.json`.
3. Tag `vX.Y.Z` and push. The release workflow verifies that the tag matches
   `package.json`, runs the full check, builds binaries for five targets, creates the
   GitHub release, and publishes to npm.

Bumping `MANIFEST_VERSION` in `src/core/checkpoint.ts` invalidates in-flight resumes
and is a breaking change.
