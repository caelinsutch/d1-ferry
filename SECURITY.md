# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/caelinsutch/d1-data-transfer/security/advisories/new)
rather than opening a public issue.

Expect an initial response within a few days.

## Scope

This tool holds a Cloudflare API token and writes to your databases, so the areas
most worth scrutiny are:

- **SQL injection via inlined literals.** D1 caps bound parameters at 100 per query,
  so bulk `INSERT`s are built by escaping and inlining literals
  (`src/core/sql.ts`). A bypass of `quoteString`, `quoteIdent`, or `encodeBlob` that
  lets attacker-controlled source data terminate a literal is a vulnerability, not a
  bug. This code is deliberately small and directly unit-tested.
- **Credential handling.** The token is read from `--api-token` or
  `CLOUDFLARE_API_TOKEN` and sent only to `api.cloudflare.com` and the presigned R2
  upload URL that D1's import endpoint returns. It is never written to disk. Note
  that a token passed as a CLI flag is visible in your shell history and process list;
  prefer the environment variable.
- **Checkpoint files.** `.d1x/*.json` records table names, row counts, and cursor
  values — the last-seen primary key of each table. Cursors can therefore contain
  real data. `.d1x/` is gitignored by default; treat it as sensitive.

## Not vulnerabilities

- Data loss from running `--truncate` or `--conflict replace` against the wrong
  database. These are destructive by design; use `--dry-run` first.
- A torn copy caused by writing to the source mid-transfer. This is a documented
  limitation, not a defect.
