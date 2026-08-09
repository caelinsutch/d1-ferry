import { DEFAULTS, D1_LIMITS } from "./limits.ts";
import { byteLength, encodeLiteral, quoteIdent } from "./sql.ts";
import type { ColumnInfo, ConflictStrategy, SqlValue } from "./types.ts";

export interface PackerOptions {
  table: string;
  columns: ColumnInfo[];
  /**
   * Byte budget per generated statement. Defaults to a value below D1's 100 KB
   * ceiling to leave headroom.
   */
  maxStatementBytes?: number;
  /** How to handle a row that collides with an existing primary key. */
  conflict?: ConflictStrategy;
}

/** SQL verb used for each conflict strategy. */
const INSERT_VERBS: Record<ConflictStrategy, string> = {
  error: "INSERT",
  ignore: "INSERT OR IGNORE",
  replace: "INSERT OR REPLACE",
};

/** One generated statement plus the number of source rows it carries. */
export interface PackedStatement {
  sql: string;
  rowCount: number;
  bytes: number;
}

/**
 * Packs rows into the largest multi-row `INSERT` statements that still fit inside
 * D1's per-statement byte limit.
 *
 * Why this exists: D1 caps bound parameters at 100 per query, so the obvious
 * approach (one placeholder per value) yields only `floor(100 / columnCount)` rows
 * per statement — 10 rows for a 10-column table. Inlining literals instead lifts
 * that to however many rows fit in 100 KB, typically hundreds to thousands, and is
 * the difference between a transfer that takes minutes and one that takes hours.
 *
 * The trade-off is that we become responsible for escaping, which `sql.ts` handles.
 */
export class StatementPacker {
  private readonly prefix: string;
  private readonly maxBytes: number;
  private readonly affinities: Array<ColumnInfo["affinity"]>;
  private readonly columnCount: number;

  /** Encoded value tuples awaiting flush, e.g. `('a',1)`. */
  private pending: string[] = [];
  /** Running byte total: prefix + tuples + separators + terminator. */
  private pendingBytes: number;

  constructor(options: PackerOptions) {
    const { table, columns, conflict = "error" } = options;

    if (columns.length === 0) {
      throw new Error(`Cannot build an INSERT for table ${table} with no columns.`);
    }

    this.maxBytes = options.maxStatementBytes ?? DEFAULTS.statementBytes;
    if (this.maxBytes > D1_LIMITS.maxStatementBytes) {
      throw new Error(
        `maxStatementBytes (${this.maxBytes}) exceeds D1's hard limit of ` +
          `${D1_LIMITS.maxStatementBytes} bytes.`,
      );
    }

    const verb = INSERT_VERBS[conflict];
    const columnList = columns.map((c) => quoteIdent(c.name)).join(",");

    this.prefix = `${verb} INTO ${quoteIdent(table)} (${columnList}) VALUES `;
    this.affinities = columns.map((c) => c.affinity);
    this.columnCount = columns.length;
    this.pendingBytes = byteLength(this.prefix) + 1; // +1 for the trailing ';'
  }

  /**
   * Add one row, yielding a completed statement whenever the next row would not fit.
   *
   * Yields rather than returns so a caller can stream an entire table through a
   * single packer without ever materializing more than one statement in memory.
   */
  *push(row: readonly SqlValue[]): Generator<PackedStatement> {
    if (row.length !== this.columnCount) {
      throw new Error(`Row has ${row.length} values but table has ${this.columnCount} columns.`);
    }

    const tuple = this.encodeTuple(row);
    const tupleBytes = byteLength(tuple);

    // A single row that cannot fit on its own is unfixable by batching.
    const standaloneBytes = byteLength(this.prefix) + tupleBytes + 1;
    if (standaloneBytes > this.maxBytes) {
      throw new Error(
        `A single row of ${this.tableLabel()} encodes to ${standaloneBytes} bytes, which ` +
          `exceeds the ${this.maxBytes}-byte statement budget. D1's hard statement limit is ` +
          `${D1_LIMITS.maxStatementBytes} bytes and its max row size is ` +
          `${D1_LIMITS.maxRowBytes} bytes, so this row cannot be inserted as SQL text. ` +
          "Consider excluding the offending BLOB/TEXT column and moving it separately.",
      );
    }

    // +1 for the ',' that would join this tuple to the previous one.
    const separatorBytes = this.pending.length === 0 ? 0 : 1;
    if (this.pendingBytes + separatorBytes + tupleBytes > this.maxBytes) {
      const flushed = this.flush();
      if (flushed) yield flushed;
    }

    this.pending.push(tuple);
    this.pendingBytes += tupleBytes + (this.pending.length === 1 ? 0 : 1);
  }

  /** Emit any buffered rows as a final statement. Returns null when empty. */
  flush(): PackedStatement | null {
    if (this.pending.length === 0) return null;

    const sql = `${this.prefix}${this.pending.join(",")};`;
    const statement: PackedStatement = {
      sql,
      rowCount: this.pending.length,
      bytes: byteLength(sql),
    };

    this.pending = [];
    this.pendingBytes = byteLength(this.prefix) + 1;

    return statement;
  }

  /** Number of rows currently buffered and not yet flushed. */
  get bufferedRows(): number {
    return this.pending.length;
  }

  private encodeTuple(row: readonly SqlValue[]): string {
    const parts = Array.from({ length: row.length }, (_, i) =>
      encodeLiteral(row[i] as SqlValue, this.affinities[i]),
    );
    return `(${parts.join(",")})`;
  }

  private tableLabel(): string {
    return this.prefix.slice(this.prefix.indexOf("INTO ") + 5, this.prefix.indexOf(" ("));
  }
}

/**
 * Convenience wrapper: pack a finite iterable of rows into complete statements.
 *
 * Prefer driving `StatementPacker` directly when streaming, so that rows are never
 * all held in memory at once.
 */
export function* packRows(
  rows: Iterable<readonly SqlValue[]>,
  options: PackerOptions,
): Generator<PackedStatement> {
  const packer = new StatementPacker(options);
  for (const row of rows) yield* packer.push(row);
  const tail = packer.flush();
  if (tail) yield tail;
}
