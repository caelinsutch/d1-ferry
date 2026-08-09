# D1 constraints that shape this tool

All numbers verified against `developers.cloudflare.com` docs (page "Last updated Apr 21, 2026),
fetched directly. Source: `https://developers.cloudflare.com/d1/platform/limits/index.md`.

## Hard limits

| Constraint                            | Value                    | Consequence for bulk transfer                                                                               |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Max SQL statement length              | **100,000 bytes**        | Multi-row `INSERT` must be packed to stay under 100 KB. This is the `Statement too long` error.             |
| Max bound parameters per query        | **100**                  | Kills bound-param bulk insert. A 10-column table = **10 rows per statement**. Must inline literals instead. |
| Max string / BLOB / row size          | 2,000,000 bytes (2 MB)   | A single wide row can approach the statement cap by itself. Packer must handle "one row per statement".     |
| Max columns per table                 | 100                      |                                                                                                             |
| Max SQL query duration                | 30 s                     | Long `SELECT` pages and big ingests can time out. Page sizes must stay modest.                              |
| Max file import (`d1 execute --file`) | 5 GiB (R2 upload limit)  | Split larger payloads across multiple import jobs.                                                          |
| Max database size                     | 10 GB paid / 500 MB free |                                                                                                             |
| Queries per Worker invocation         | 1000 paid / 50 free      | Only relevant to the Worker binding path, not the REST path.                                                |

Batch semantics: **limits above apply to each individual statement inside a batch**, not to the
batch as a whole. A batch is a transaction — one failing statement rolls back the whole sequence.

Concurrency: each D1 database is a **single Durable Object and is single-threaded**; queries are
processed one at a time. Excess concurrency queues, then fails with an `overloaded` error.
=> Aggressive client-side parallelism against one database is counterproductive. Modest
concurrency (2-4) plus backoff on `overloaded` is the correct posture.

## Transport options, ranked

### 1. Import endpoint (preferred for bulk writes)

`POST /accounts/{account_id}/d1/database/{database_id}/import`

Four-phase flow (from the official REST bulk-import tutorial):

1. `{ action: "init", etag: <md5-hex-of-sql> }` -> returns `result.upload_url`, `result.filename`
2. `PUT <upload_url>` with the raw SQL body -> response `ETag` header **must equal** the md5
3. `{ action: "ingest", etag, filename }` -> returns `result.at_bookmark`
4. `{ action: "poll", current_bookmark: <bookmark> }` until complete

Why this matters: the payload is uploaded to R2 and **chunked server-side**, so it is the path
that does _not_ require us to fight the 100 KB statement limit for the whole file. It is the
same machinery `wrangler d1 execute --file` uses. Each _statement inside the file_ still must
respect the 100 KB cap.

### 2. `/query` and `/raw` (control plane + fallback)

`POST /accounts/{id}/d1/database/{db}/query` — `{ sql, params }`, returns row objects.
`POST .../raw` — same but returns `{ columns, rows: [[...]] }`, which is materially cheaper on
the wire for wide result sets. Use `/raw` for reads.

### 3. Export endpoint

`POST /accounts/{id}/d1/database/{db}/export` — polling flow, produces a signed URL to a `.sql`
dump. Used by `wrangler d1 export`.

## Correctness traps

1. **int64 precision loss.** Cloudflare documents this explicitly for export: "Any numeric value
   in a column is affected by JavaScript's 52-bit precision for numbers. If you store a very
   large number (in int64), then retrieve the same value, the returned value may be less precise."
   This applies to any JSON-based read, including `/query` and `/raw`.
   **Mitigation:** for INTEGER columns, read as `CAST(col AS TEXT)` so the exact digits survive
   the JSON round-trip, then emit an unquoted numeric literal on the write side. This is
   non-optional for a tool whose entire job is fidelity.

2. **Virtual tables (FTS5) cannot be exported.** Databases containing them fail export. Detect
   `type = 'virtual'` via `PRAGMA table_list` and their shadow tables, and handle by copying the
   `CREATE VIRTUAL TABLE` DDL + repopulating from the content table rather than copying shadow
   tables directly.

3. **`shadow` tables** (FTS5 internals) show up in `PRAGMA table_list` and must be skipped.

4. **`_cf_KV`** is a reserved D1 system table. It cannot be queried and must be excluded from
   both schema and data copying.

5. **`sqlite_schema` / `sqlite_temp_schema` / `sqlite_sequence`** appear in `table_list` and must
   be filtered. `sqlite_sequence` needs special handling if AUTOINCREMENT values must be preserved.

6. **No `BEGIN TRANSACTION` / `COMMIT`** in imported SQL — D1 is auto-commit and errors with
   "cannot start a transaction within a transaction".

7. **Foreign keys.** Either order tables topologically by FK dependency, or emit
   `PRAGMA defer_foreign_keys = true` at the head of each import batch. Note the caution in the
   docs: "D1 PRAGMA statements only apply to the current transaction" — so the PRAGMA must be
   re-emitted in every batch/file, not once globally.

8. **A running export blocks other requests** to that database.

## Schema introspection available in D1

- `PRAGMA table_list` -> `schema, name, type(table|view|shadow|virtual), ncol, wr(WITHOUT ROWID), strict`
- `PRAGMA table_info("T")` -> `cid, name, type, notnull, dflt_value, pk`
- `PRAGMA foreign_key_list("T")`, `PRAGMA index_list("T")` — for dependency ordering and indexes
- `SELECT sql FROM sqlite_master` — authoritative DDL text
- `wr = 1` (WITHOUT ROWID) matters: those tables have **no rowid**, so rowid-based pagination
  is unavailable and we must page on the declared primary key instead.
