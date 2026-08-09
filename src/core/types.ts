/**
 * A pre-formatted SQL fragment emitted verbatim instead of being quoted.
 *
 * Used for values that cannot survive inlining as a plain literal -- notably TEXT
 * containing a NUL byte, which SQLite truncates at the NUL.
 */
export interface RawSql {
  readonly sql: string;
}

/** A value as it can appear in a SQLite column. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | RawSql;

/** SQLite storage classes, as resolved from a declared column type. */
export type StorageClass = "INTEGER" | "REAL" | "TEXT" | "BLOB" | "NUMERIC";

/** One column of a table, as reported by `PRAGMA table_info`. */
export interface ColumnInfo {
  /** Column name, unquoted. */
  name: string;
  /** Declared type as written in the DDL (may be empty for untyped columns). */
  declaredType: string;
  /** Storage class inferred from `declaredType` via SQLite's affinity rules. */
  affinity: StorageClass;
  notNull: boolean;
  defaultValue: string | null;
  /** 0 if not part of the primary key, otherwise its 1-based position in the key. */
  pkPosition: number;
}

/** A foreign key edge, from `PRAGMA foreign_key_list`. */
export interface ForeignKeyInfo {
  /** Table this key points at. */
  referencedTable: string;
  /** Columns in this table. */
  columns: string[];
  /** Columns in the referenced table (empty means "the referenced table's PK"). */
  referencedColumns: string[];
}

/** Everything we need to know about one table to copy it faithfully. */
export interface TableInfo {
  name: string;
  /** `table`, `view`, `shadow`, or `virtual`, from `PRAGMA table_list`. */
  type: "table" | "view" | "shadow" | "virtual";
  /** True for `WITHOUT ROWID` tables, which cannot be paged by rowid. */
  withoutRowid: boolean;
  /** True for `STRICT` tables. */
  strict: boolean;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** Authoritative `CREATE` statement from `sqlite_master`. */
  ddl: string | null;
}

/** A database's full logical shape. */
export interface DatabaseSchema {
  tables: TableInfo[];
  views: Array<{ name: string; ddl: string }>;
  indexes: Array<{ name: string; table: string; ddl: string }>;
  triggers: Array<{ name: string; table: string; ddl: string }>;
  /** Virtual (FTS5) tables, which cannot be exported normally. */
  virtualTables: Array<{ name: string; ddl: string }>;
}

/** Identifies one D1 database. */
export interface DatabaseRef {
  accountId: string;
  databaseId: string;
  /** Human-readable name, when known. Used only for output. */
  name?: string;
}

/** How to resolve a conflicting row on the target. */
export type ConflictStrategy = "error" | "ignore" | "replace";

/** A page of rows read from a source table. */
export interface RowPage {
  columns: string[];
  rows: SqlValue[][];
  /** Cursor to pass to the next read, or null when the table is exhausted. */
  nextCursor: string | null;
}
