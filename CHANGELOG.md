# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-08

Initial release.

### Added

- `d1x copy` — resumable, limit-aware table copy between two D1 databases.
  - Multi-row `INSERT` packing against a UTF-8 byte budget, avoiding the
    `Statement too long` failure at D1's 100 KB per-statement ceiling.
  - Literal inlining rather than bound parameters, working around the
    100-bound-parameter-per-query cap that otherwise limits a 10-column table to
    10 rows per statement.
  - int64 fidelity: `INTEGER` columns are read as `TEXT` and re-emitted as exact
    numeric literals, so values beyond JavaScript's 53-bit float precision survive
    the JSON round trip.
  - Keyset (seek) pagination instead of `LIMIT/OFFSET`, keeping per-page cost constant.
  - Checkpoint manifests in `.d1x/`, written atomically after each confirmed batch,
    so an interrupted copy resumes on re-run.
  - Foreign-key-aware table ordering, with `PRAGMA defer_foreign_keys` emitted in
    every payload (D1 scopes PRAGMAs to a single transaction).
  - `--create-schema`, `--truncate`, `--conflict`, `--where`, table include/exclude,
    and `--dry-run`.
- `d1x export` — stream a database to a re-importable `.sql` file.
- `d1x import` — chunked import of any `.sql` file, including `sqlite3 .dump` output.
  Statement splitting is aware of string literals, comments, and `BEGIN…END` blocks;
  statements D1 rejects (`BEGIN`/`COMMIT`, `_cf_KV`, `PRAGMA foreign_keys`) are stripped.
- `d1x verify` — per-table row-count comparison plus an optional order-independent
  content checksum. Exits non-zero on mismatch.
- `d1x schema show` / `d1x schema copy` — introspection and schema replication.
- `d1x list` — enumerate account databases.
- Retry with exponential backoff and full jitter for `429`, `5xx`, network faults, and
  D1's `overloaded` error, which a single-threaded database returns under queue pressure.
- Database references accept a name or a UUID, with typo suggestions on miss.
- Library exports for embedding the same limit-aware batching in other tooling.

### Known limitations

- Virtual (FTS5) tables are detected, skipped, and warned about rather than copied.
- `WITHOUT ROWID` tables require a primary key to be paged or resumed.
- A copy is not a point-in-time snapshot; concurrent writes to the source can tear it.
- `sqlite_sequence` is not copied, so `AUTOINCREMENT` high-water marks reset.

[Unreleased]: https://github.com/caelinsutch/d1-data-transfer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caelinsutch/d1-data-transfer/releases/tag/v0.1.0
