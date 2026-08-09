/**
 * Programmatic entry point.
 *
 * Everything the CLI does is available as a library, so the same limit-aware
 * batching can be embedded in a migration script or a Worker-side job.
 */

export { D1Client } from "./core/client.ts";
export type {
  D1ClientOptions,
  D1Meta,
  D1QueryResult,
  D1RawResult,
  ImportProgress,
} from "./core/client.ts";

export { CheckpointStore, deriveJobId } from "./core/checkpoint.ts";
export type { Manifest, TableCheckpoint } from "./core/checkpoint.ts";

export { resolveAuth, resolveDatabase } from "./core/config.ts";
export { D1_LIMITS, DEFAULTS, RESERVED_TABLES } from "./core/limits.ts";
export { packRows, StatementPacker } from "./core/packer.ts";
export type { PackedStatement, PackerOptions } from "./core/packer.ts";

export { countRows, TableReader } from "./core/reader.ts";
export type { KeysetCursor, ReadOptions, ReadPage } from "./core/reader.ts";

export { introspect, paginationKey, readProjection, topologicalOrder } from "./core/schema.ts";
export { isUnsupportedStatement, splitStatements } from "./core/splitter.ts";
export {
  affinityOf,
  byteLength,
  encodeBlob,
  encodeLiteral,
  quoteIdent,
  quoteString,
} from "./core/sql.ts";

export { TransferEngine, transferOptionsFrom } from "./core/transfer.ts";
export type { TableResult, TransferOptions } from "./core/transfer.ts";

export type {
  ColumnInfo,
  ConflictStrategy,
  DatabaseRef,
  DatabaseSchema,
  ForeignKeyInfo,
  RowPage,
  SqlValue,
  StorageClass,
  TableInfo,
} from "./core/types.ts";

export { CliError, ConfigError, D1ApiError } from "./util/errors.ts";
export { createLogger, formatBytes, formatCount, formatDuration } from "./util/logger.ts";
export type { Logger, LogLevel } from "./util/logger.ts";
