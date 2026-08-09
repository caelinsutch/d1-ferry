# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing here has been released yet; this is the pre-1.0 development history.

### Changed

- **Renamed to `d1-ferry`** (was `d1-data-transfer`; the CLI was `d1x`, which is already
  taken on npm). Binaries are `d1-ferry` and the short alias `d1f`. Checkpoint files now
  live in `.d1-ferry/` rather than `.d1x/`, so an in-flight job from an earlier build
  restarts rather than resumes.
- Values now cross the wire with a `typeof()` tag and are decoded back to their exact
  storage class. SQLite types are per-value, not per-column, so inferring the class from
  a column's declared affinity was the root cause of two of the corruption bugs below.
  REAL deliberately travels as a JSON number, which round-trips a float64 exactly and
  avoids SQLite's lossy default real-to-text conversion.
- Ordinary tables page on `rowid` instead of the declared primary key.

### Added

- `export --limit <rows>` to sample roughly N rows per table, which makes it practical to
  spot-check a very large table without pulling all of it.
- End-to-end round-trip tests that run the real pipeline against actual SQLite via
  `bun:sqlite` and assert the target is byte-and-type identical to the source.

### Fixed

Four data-fidelity bugs, all found by the round-trip tests rather than by unit tests,
which had happily agreed with the encoder's own wrong assumptions.

- **BLOBs were rewritten as their hex text.** `readProjection` emitted `hex(col)`, and
  the encoder could not tell the resulting string from real text, so it quoted it
  (`'DEAD'` instead of `X'dead'`). Affected every BLOB in every table.
- **A NULL in a pagination key silently truncated the copy.** SQLite only enforces NOT
  NULL on primary keys for `WITHOUT ROWID` and `STRICT` tables, so an ordinary
  `TEXT PRIMARY KEY` may hold NULL; `col > NULL` matches nothing, so the reader saw an
  empty page, concluded the table had ended, and reported success having copied only
  part of it.
- **TEXT containing a NUL byte was truncated at the NUL.** Such values now travel as hex
  and are restored with `CAST(X'..' AS TEXT)`.
- **Any REAL of magnitude >= 2^53 crashed the copy**, because `Number.isInteger` is true
  for values like `1.8e308`. Affinity now disambiguates an integral REAL from an integer
  that has already lost precision.
- `export -t <table>` and `copy --create-schema -t <table>` emitted indexes and triggers
  belonging to tables that were filtered out, so the resulting file failed to import with
  "no such table". Schema objects are now scoped to the selected tables; views are only
  included when nothing was filtered, since a view's dependencies cannot be determined
  from `sqlite_master` alone.
- The package would have installed a broken `bin`: it pointed at `dist/d1-ferry`, which
  only exists after a build, and `dist` was not in `files`. The package now ships its
  TypeScript and runs it under Bun via a `bin/` shim.

## [0.1.0] - 2026-08-08

Initial release.

### Added

- `d1-ferry copy` — resumable, limit-aware table copy between two D1 databases.
  - Multi-row `INSERT` packing against a UTF-8 byte budget, avoiding the
    `Statement too long` failure at D1's 100 KB per-statement ceiling.
  - Literal inlining rather than bound parameters, working around the
    100-bound-parameter-per-query cap that otherwise limits a 10-column table to
    10 rows per statement.
  - int64 fidelity: `INTEGER` columns are read as `TEXT` and re-emitted as exact
    numeric literals, so values beyond JavaScript's 53-bit float precision survive
    the JSON round trip.
  - Keyset (seek) pagination instead of `LIMIT/OFFSET`, keeping per-page cost constant.
  - Checkpoint manifests in `.d1-ferry/`, written atomically after each confirmed batch,
    so an interrupted copy resumes on re-run.
  - Foreign-key-aware table ordering, with `PRAGMA defer_foreign_keys` emitted in
    every payload (D1 scopes PRAGMAs to a single transaction).
  - `--create-schema`, `--truncate`, `--conflict`, `--where`, table include/exclude,
    and `--dry-run`.
- `d1-ferry export` — stream a database to a re-importable `.sql` file.
- `d1-ferry import` — chunked import of any `.sql` file, including `sqlite3 .dump` output.
  Statement splitting is aware of string literals, comments, and `BEGIN…END` blocks;
  statements D1 rejects (`BEGIN`/`COMMIT`, `_cf_KV`, `PRAGMA foreign_keys`) are stripped.
- `d1-ferry verify` — per-table row-count comparison plus an optional order-independent
  content checksum. Exits non-zero on mismatch.
- `d1-ferry schema show` / `d1-ferry schema copy` — introspection and schema replication.
- `d1-ferry list` — enumerate account databases.
- Retry with exponential backoff and full jitter for `429`, `5xx`, network faults, and
  D1's `overloaded` error, which a single-threaded database returns under queue pressure.
- Database references accept a name or a UUID, with typo suggestions on miss.
- Library exports for embedding the same limit-aware batching in other tooling.

### Known limitations

- Virtual (FTS5) tables are detected, skipped, and warned about rather than copied.
- `WITHOUT ROWID` tables require a primary key to be paged or resumed.
- A copy is not a point-in-time snapshot; concurrent writes to the source can tear it.
- `sqlite_sequence` is not copied, so `AUTOINCREMENT` high-water marks reset.

[Unreleased]: https://github.com/caelinsutch/d1-ferry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caelinsutch/d1-ferry/releases/tag/v0.1.0
