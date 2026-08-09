import type { D1Client } from "./client.ts";
import { DEFAULTS } from "./limits.ts";
import { paginationKey, readProjection } from "./schema.ts";
import { decodeTransported, encodeLiteral, quoteIdent } from "./sql.ts";
import type { SqlValue, TableInfo } from "./types.ts";

export interface ReadOptions {
  /** Rows per request. Kept modest because D1 caps query duration at 30s. */
  pageSize?: number;
  /** Optional `WHERE` clause body, without the `WHERE` keyword. */
  where?: string;
  /** Resume from a previously returned cursor. */
  cursor?: KeysetCursor | null;
  /** Stop after approximately this many rows. */
  limit?: number;
}

/** Position within a table, expressed as the last-seen key tuple. */
export interface KeysetCursor {
  columns: string[];
  values: SqlValue[];
}

export interface ReadPage {
  columns: string[];
  rows: SqlValue[][];
  cursor: KeysetCursor | null;
  /** True when this page is the last one. */
  done: boolean;
}

/**
 * Reads a table in pages using keyset (seek) pagination.
 *
 * `LIMIT ... OFFSET n` is deliberately avoided: SQLite must walk and discard all
 * `n` preceding rows on every page, so a full-table copy degrades to O(n^2) and a
 * large table will start blowing through D1's 30-second query ceiling partway in.
 * Keyset pagination stays O(page) forever, and its cursor doubles as a
 * crash-resume checkpoint.
 */
export class TableReader {
  private readonly projection: string;
  private readonly keyColumns: string[];
  private cursor: KeysetCursor | null;
  private exhausted = false;
  private rowsRead = 0;

  constructor(
    private readonly client: D1Client,
    private readonly databaseId: string,
    private readonly table: TableInfo,
    private readonly options: ReadOptions = {},
  ) {
    this.keyColumns = paginationKey(table);
    this.cursor = options.cursor ?? null;

    // Cursor columns are projected separately and UNTAGGED. Data columns carry a
    // typeof() tag for fidelity, but a tagged value ('t:acme') could not be compared
    // against the raw column in the seek predicate, so the key needs a plain copy.
    const cursorProjection = this.keyColumns
      .map((name, i) => `CAST(${columnRef(name)} AS TEXT) AS "__cursor_${i}"`)
      .join(", ");

    this.projection = `${cursorProjection}, ${readProjection(table.columns)}`;
  }

  /** Column names of the copied data, excluding any synthetic cursor column. */
  get dataColumns(): string[] {
    return this.table.columns.map((c) => c.name);
  }

  /** The cursor to persist for resumption. */
  get position(): KeysetCursor | null {
    return this.cursor;
  }

  /** Iterate the table one page at a time. */
  async *pages(): AsyncGenerator<ReadPage> {
    const pageSize = this.options.pageSize ?? DEFAULTS.readPageSize;

    while (!this.exhausted) {
      const remaining =
        this.options.limit !== undefined
          ? this.options.limit - this.rowsRead
          : Number.POSITIVE_INFINITY;
      if (remaining <= 0) return;

      const take = Math.min(pageSize, remaining);
      const sql = this.buildPageQuery(take);
      const result = await this.client.raw(this.databaseId, sql);

      if (result.rows.length === 0) {
        this.exhausted = true;
        return;
      }

      const page = this.splitCursorColumn(result.columns, result.rows);
      this.rowsRead += page.rows.length;
      this.cursor = page.cursor;

      if (result.rows.length < take) this.exhausted = true;

      yield { ...page, done: this.exhausted };
    }
  }

  private buildPageQuery(limit: number): string {
    const table = quoteIdent(this.table.name);
    const orderBy = this.keyColumns.map((c) => columnRef(c)).join(", ");

    const conditions: string[] = [];
    if (this.options.where) conditions.push(`(${this.options.where})`);
    if (this.cursor) conditions.push(this.buildSeekPredicate(this.cursor));

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    return `SELECT ${this.projection} FROM ${table}${where} ORDER BY ${orderBy} LIMIT ${limit}`;
  }

  /**
   * Build the "everything after this key" predicate.
   *
   * For a single key this is simply `k > v`. For a composite key it expands to the
   * standard lexicographic form, because `(a,b) > (?,?)` row-value comparison is
   * not reliably available and a naive `a >= ? AND b > ?` silently skips rows.
   *
   *   (a > ?) OR (a = ? AND b > ?) OR (a = ? AND b = ? AND c > ?)
   */
  private buildSeekPredicate(cursor: KeysetCursor): string {
    const column = (index: number): string => columnRef(cursor.columns[index] as string);
    const literal = (index: number): string => {
      const name = cursor.columns[index] as string;
      const affinity =
        name === "rowid" ? "INTEGER" : this.table.columns.find((c) => c.name === name)?.affinity;
      return encodeLiteral(cursor.values[index] as SqlValue, affinity);
    };

    const clauses: string[] = [];
    for (let i = 0; i < cursor.columns.length; i++) {
      const equalities = Array.from({ length: i }, (_, j) => `${column(j)} = ${literal(j)}`);
      clauses.push([...equalities, `${column(i)} > ${literal(i)}`].join(" AND "));
    }

    return `(${clauses.map((c) => `(${c})`).join(" OR ")})`;
  }

  /**
   * Split the synthetic cursor columns off the front of the result set and decode
   * the tagged data values back into typed JS values.
   */
  private splitCursorColumn(
    columns: string[],
    rows: SqlValue[][],
  ): { columns: string[]; rows: SqlValue[][]; cursor: KeysetCursor } {
    const keyCount = this.keyColumns.length;
    const lastRow = rows.at(-1) as SqlValue[];

    // The cursor columns are always projected first, so they occupy [0, keyCount).
    const dataColumns = columns.slice(keyCount);
    const dataRows = rows.map((row) => row.slice(keyCount).map((v) => decodeTransported(v)));

    return {
      columns: dataColumns,
      rows: dataRows,
      cursor: {
        columns: this.keyColumns,
        values: lastRow.slice(0, keyCount),
      },
    };
  }
}

/**
 * Reference a pagination column.
 *
 * `rowid` is a bare SQLite keyword, not a real column, so quoting it would break
 * the query on tables that do not declare a column of that name.
 */
function columnRef(name: string): string {
  return name === "rowid" ? "rowid" : quoteIdent(name);
}

/** Count rows in a table, honouring an optional filter. */
export async function countRows(
  client: D1Client,
  databaseId: string,
  table: string,
  where?: string,
): Promise<number> {
  const filter = where ? ` WHERE ${where}` : "";
  const result = await client.query<{ n: string | number }>(
    databaseId,
    `SELECT CAST(COUNT(*) AS TEXT) AS n FROM ${quoteIdent(table)}${filter}`,
  );
  return Number(result.results[0]?.n ?? 0);
}
