/**
 * D1 platform limits, verified against
 * https://developers.cloudflare.com/d1/platform/limits/ (docs updated 2026-04-21).
 *
 * See ../../.notes/d1-constraints.md for the full rationale behind each value.
 */

/** Absolute ceilings imposed by the platform. Do not exceed these. */
export const D1_LIMITS = {
  /** Maximum length of a single SQL statement, in bytes. */
  maxStatementBytes: 100_000,
  /** Maximum number of bound parameters in a single query. */
  maxBoundParams: 100,
  /** Maximum size of a single string, BLOB, or table row, in bytes. */
  maxRowBytes: 2_000_000,
  /** Maximum number of columns in a table. */
  maxColumns: 100,
  /** Maximum wall-clock duration of a single SQL query, in milliseconds. */
  maxQueryDurationMs: 30_000,
  /** Maximum size of a file uploaded to the import endpoint, in bytes (5 GiB). */
  maxImportFileBytes: 5 * 1024 * 1024 * 1024,
} as const;

/**
 * Defaults we actually target. Each sits below the platform ceiling so that a
 * miscounted multi-byte character or an unexpectedly wide row cannot push a
 * generated statement over a hard limit.
 */
export const DEFAULTS = {
  /**
   * Byte budget for a generated multi-row INSERT. 92 KB against a 100 KB ceiling
   * leaves ~8% headroom for the statement prefix and separators.
   */
  statementBytes: 92_000,
  /**
   * Rows fetched per SELECT page. Kept modest because a single D1 database is
   * single-threaded with a 30s query ceiling.
   */
  readPageSize: 1_000,
  /**
   * Target size of an SQL file handed to the import endpoint. Well under the
   * 5 GiB cap so a single failure never wastes much work, and small enough that
   * server-side ingest stays responsive.
   */
  importFileBytes: 24 * 1024 * 1024,
  /**
   * Concurrent in-flight requests per database. D1 databases are single-threaded
   * Durable Objects, so high concurrency only builds queue depth and risks
   * `overloaded` errors.
   */
  concurrency: 3,
  /** Retry policy for retryable failures (429 / 5xx / network / overloaded). */
  maxRetries: 6,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 30_000,
} as const;

/**
 * Largest SQL file `d1-ferry import` will read.
 *
 * The importer tokenizes the whole file as a single string to find statement
 * boundaries safely, so the file must fit in memory. Bun's string allocation fails
 * around 2 GB -- well under D1's own 5 GiB import ceiling -- so this sits below that
 * and the command refuses larger files with instructions rather than running out of
 * memory mid-import.
 */
export const MAX_IN_MEMORY_SQL_BYTES = 1024 * 1024 * 1024;

/**
 * Tables that must never be copied. `_cf_KV` is D1's reserved internal table and
 * is not even queryable; the `sqlite_*` tables are SQLite internals.
 */
export const RESERVED_TABLES: ReadonlySet<string> = new Set([
  "_cf_KV",
  "sqlite_schema",
  "sqlite_temp_schema",
  "sqlite_master",
  "sqlite_temp_master",
  "sqlite_sequence",
  "sqlite_stat1",
  "sqlite_stat2",
  "sqlite_stat3",
  "sqlite_stat4",
  "d1_migrations",
]);

/** Cloudflare REST API base URL. */
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
