# d1-ferry — d1-ferry

Move large amounts of data between [Cloudflare D1](https://developers.cloudflare.com/d1/)
databases without fighting the platform's limits.

Bulk-loading D1 is harder than it looks. The failure modes people actually hit:

| What bites you                 | Why                                                                                              | What `d1-ferry` does                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `Statement too long`           | A single SQL statement may not exceed **100 KB**                                                 | Packs multi-row `INSERT`s to a byte budget, measured in UTF-8 bytes                                                        |
| Inserts are absurdly slow      | D1 allows only **100 bound parameters per query** — a 10-column table gets 10 rows per statement | Inlines escaped literals instead of binding, so a statement carries hundreds to thousands of rows                          |
| Large integers come back wrong | D1 returns JSON, and JSON numbers go through JavaScript's 53-bit floats                          | Transports `integer` values as exact decimal text, so int64 survives                                                       |
| BLOBs arrive as their hex text | `hex()` returns a string, indistinguishable from real text                                       | Every value carries a `typeof()` tag, so a blob is restored as a blob                                                      |
| Text with a NUL byte truncates | SQLite stops parsing a literal at the NUL                                                        | Such values travel as hex and are restored with `CAST(X'..' AS TEXT)`                                                      |
| Thousands of HTTP round trips  | One request per statement                                                                        | Uses D1's R2-backed `/import` endpoint, which chunks server-side — a handful of requests for millions of rows              |
| A big copy dies at 80%         | No resume                                                                                        | Persists a keyset cursor after every confirmed batch; re-running resumes where it stopped                                  |
| `overloaded` errors            | Each D1 database is a **single-threaded** Durable Object                                         | Modest concurrency plus exponential backoff with full jitter                                                               |
| Foreign keys fail mid-import   | Tables inserted in the wrong order                                                               | Orders tables topologically and emits `PRAGMA defer_foreign_keys` in **every** payload (D1 scopes PRAGMAs per transaction) |
| `OFFSET` pagination crawls     | SQLite walks and discards every skipped row                                                      | Keyset (seek) pagination, so page cost stays constant                                                                      |

Verified limits and citations live in [`.notes/d1-constraints.md`](.notes/d1-constraints.md).

## Install

```sh
bun add -g d1-ferry   # or: bun install && bun link
```

Requires [Bun](https://bun.sh) 1.1+.

## Setup

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...   # needs account-level D1:Edit
```

Both can also be passed as `--account-id` / `--api-token`. Databases may be referenced
by **name or UUID**.

## Usage

```sh
d1-ferry list                                  # list databases
d1-ferry schema show my-db                     # table/PK/FK overview
d1-ferry copy prod-db staging-db               # the main event
d1-ferry verify prod-db staging-db --checksum  # confirm it worked
```

### Copy

```sh
# Full copy, creating the schema on the target first
d1-ferry copy prod-db staging-db --create-schema

# Only some tables, overwriting rows that already exist
d1-ferry copy prod-db staging-db -t users,orders --conflict replace

# Copy a subset of rows
d1-ferry copy prod-db staging-db -t events --where "created_at > '2026-01-01'"

# See the plan without writing
d1-ferry copy prod-db staging-db --dry-run
```

A copy writes a checkpoint to `.d1-ferry/<source>-to-<target>.json` after every confirmed
batch. If it fails, **re-run the same command** and it resumes. Use `--no-resume` to
start over.

Because a resumed job may replay the single in-flight batch, `--conflict replace`
(or `ignore`) makes resumption fully idempotent. With the default `--conflict error`,
a replayed batch can legitimately hit a primary-key conflict.

### Export / import

```sh
d1-ferry export prod-db -o backup.sql          # D1 → local .sql
d1-ferry import staging-db backup.sql          # local .sql → D1
d1-ferry import staging-db dump.sql --dry-run  # validate chunking only
```

`d1-ferry export` always emits statements that respect the 100 KB limit. `d1-ferry import`
accepts any SQL file — including `sqlite3 .dump` output — and automatically strips
what D1 rejects (`BEGIN`/`COMMIT`, `_cf_KV`, `PRAGMA foreign_keys`). Its statement
splitter is quote-, comment-, and `BEGIN…END`-aware, so semicolons inside string
literals and trigger bodies do not corrupt the chunk boundaries.

Converting an existing SQLite file:

```sh
sqlite3 local.sqlite3 .dump > dump.sql
d1-ferry import my-db dump.sql
```

### Verify

```sh
d1-ferry verify prod-db staging-db             # row counts per table
d1-ferry verify prod-db staging-db --checksum  # order-independent content hash
```

Exits non-zero on any mismatch, so it drops straight into CI.

## Key options

| Option                        | Default | Notes                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------- |
| `--statement-size <bytes>`    | `92KB`  | Per-`INSERT` budget. Hard ceiling is 100 KB.               |
| `--page-size <rows>`          | `1000`  | Rows per read request.                                     |
| `--file-size <bytes>`         | `24MB`  | Size of each `/import` payload. Hard ceiling is 5 GiB.     |
| `--conflict <mode>`           | `error` | One of `error`, `ignore`, `replace`.                       |
| `--where <clause>`            | —       | Filter applied to every table.                             |
| `-t, --table <names>`         | all     | Repeatable or comma-separated.                             |
| `-x, --exclude-table <names>` | —       | Repeatable or comma-separated.                             |
| `--limit <rows>`              | —       | `export` only. Sample roughly N rows per table.            |
| `--no-defer-foreign-keys`     | off     | Disable `PRAGMA defer_foreign_keys`.                       |
| `--dry-run`                   | off     | Report without writing.                                    |
| `--json`                      | off     | Machine-readable results on stdout; NDJSON logs on stderr. |

Sizes accept suffixes: `92000`, `64KB`, `24MB`, `1GB`.

## Scripting

`--json` writes a single JSON result document to **stdout** and sends progress and log
output to **stderr** as NDJSON, so results pipe cleanly while progress stays visible on
a terminal.

```sh
# Names of every database
d1-ferry --json list | jq -r '.databases[].name'

# Gate CI on content equality, not just row counts
d1-ferry --json verify prod-db staging-db --checksum > report.json || {
  jq -r '.tables[] | select(.match == false) | "\(.table): \(.reason)"' report.json
  exit 1
}

# What would a copy move, without moving it?
d1-ferry --json copy prod-db staging-db --dry-run | jq '.totals'

# Every column and its declared type
d1-ferry --json schema show prod-db |
  jq -r '.tables[] | .name as $t | .columns[] | "\($t).\(.name) \(.type)"'
```

Commands exit non-zero on failure regardless of `--json`, so `verify` works as a gate.
Int64 values are emitted as strings, since JSON numbers cannot represent them exactly;
blobs are base64.

## Known limitations

- **Virtual (FTS5) tables are not copied.** D1 cannot export them, and their shadow
  tables must not be copied directly. `d1-ferry` detects, skips, and warns about them;
  recreate the `CREATE VIRTUAL TABLE` and repopulate from its content table.
- **`WITHOUT ROWID` tables need a primary key** to be paged and resumed. Ordinary
  tables page on `rowid`, which is always present, unique, and non-NULL.
- **Not a snapshot.** Reads are paginated, so a source under concurrent writes can
  yield a torn copy. Quiesce writes, or use
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for
  a
  point-in-time source.
- **`sqlite_sequence` is not copied**, so `AUTOINCREMENT` high-water marks reset.

## Library use

```ts
import { D1Client, StatementPacker, introspect } from "d1-ferry";

const client = new D1Client({ accountId, apiToken });
const schema = await introspect(client, databaseId);

const packer = new StatementPacker({
  table: "users",
  columns: schema.tables[0]!.columns,
  conflict: "replace",
});

for (const statement of packer.push([1, "ada@example.com"])) {
  console.log(statement.sql); // guaranteed under the byte budget
}
```

## Development

```sh
bun install
bun test              # unit tests
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint
bun run format        # oxfmt --write
bun run check         # all of the above
bun run build         # single-file binary at dist/d1-ferry
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © Caelin Sutch
