import type { D1Client } from "./client.ts";
import { RESERVED_TABLES } from "./limits.ts";
import { affinityOf, quoteIdent } from "./sql.ts";
import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, TableInfo } from "./types.ts";

/**
 * Read a database's full logical schema using the PRAGMA statements D1 supports.
 *
 * D1 exposes `PRAGMA table_list`, `table_info`, `foreign_key_list`, and `index_list`,
 * plus `sqlite_master` for authoritative DDL text. We use PRAGMAs for structure and
 * `sqlite_master` for the exact `CREATE` statements, because reconstructing DDL from
 * PRAGMA output loses constraints, collations, and generated-column expressions.
 */
export async function introspect(client: D1Client, databaseId: string): Promise<DatabaseSchema> {
  const tableList = await client.query<{
    schema: string;
    name: string;
    type: string;
    ncol: number;
    wr: number;
    strict: number;
  }>(databaseId, "PRAGMA table_list");

  const objects = await client.query<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>(databaseId, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL");

  const ddlByName = new Map(objects.results.map((o) => [o.name, o.sql] as const));

  const schema: DatabaseSchema = {
    tables: [],
    views: [],
    indexes: [],
    triggers: [],
    virtualTables: [],
  };

  for (const object of objects.results) {
    if (!object.sql) continue;
    if (object.type === "view") {
      schema.views.push({ name: object.name, ddl: object.sql });
    } else if (object.type === "index" && !object.name.startsWith("sqlite_autoindex")) {
      // Auto-indexes are created implicitly by UNIQUE/PK and must not be re-issued.
      schema.indexes.push({
        name: object.name,
        table: object.tbl_name,
        ddl: object.sql,
      });
    } else if (object.type === "trigger") {
      schema.triggers.push({
        name: object.name,
        table: object.tbl_name,
        ddl: object.sql,
      });
    }
  }

  for (const entry of tableList.results) {
    if (entry.schema !== "main") continue;
    if (RESERVED_TABLES.has(entry.name)) continue;

    if (entry.type === "virtual") {
      schema.virtualTables.push({
        name: entry.name,
        ddl: ddlByName.get(entry.name) ?? "",
      });
      continue;
    }
    // `shadow` tables are FTS5 internals owned by a virtual table; copying them
    // directly corrupts the index. Views carry no data.
    if (entry.type !== "table") continue;

    const [columns, foreignKeys] = await Promise.all([
      readColumns(client, databaseId, entry.name),
      readForeignKeys(client, databaseId, entry.name),
    ]);

    schema.tables.push({
      name: entry.name,
      type: "table",
      withoutRowid: entry.wr === 1,
      strict: entry.strict === 1,
      columns,
      foreignKeys,
      ddl: ddlByName.get(entry.name) ?? null,
    });
  }

  // Shadow tables belonging to a virtual table must never be copied on their own.
  const shadowPrefixes = schema.virtualTables.map((v) => `${v.name}_`);
  schema.tables = schema.tables.filter((t) => !shadowPrefixes.some((p) => t.name.startsWith(p)));

  return schema;
}

async function readColumns(
  client: D1Client,
  databaseId: string,
  table: string,
): Promise<ColumnInfo[]> {
  const info = await client.query<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>(databaseId, `PRAGMA table_info(${quoteIdent(table)})`);

  return info.results.map((row) => ({
    name: row.name,
    declaredType: row.type ?? "",
    affinity: affinityOf(row.type ?? ""),
    notNull: row.notnull === 1,
    defaultValue: row.dflt_value,
    pkPosition: row.pk,
  }));
}

async function readForeignKeys(
  client: D1Client,
  databaseId: string,
  table: string,
): Promise<ForeignKeyInfo[]> {
  const list = await client.query<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
  }>(databaseId, `PRAGMA foreign_key_list(${quoteIdent(table)})`);

  // Composite keys share an `id` across multiple rows, ordered by `seq`.
  const grouped = new Map<number, ForeignKeyInfo>();
  for (const row of list.results) {
    let entry = grouped.get(row.id);
    if (!entry) {
      entry = {
        referencedTable: row.table,
        columns: [],
        referencedColumns: [],
      };
      grouped.set(row.id, entry);
    }
    entry.columns.push(row.from);
    if (row.to) entry.referencedColumns.push(row.to);
  }

  return [...grouped.values()];
}

/**
 * Order tables so that every table is created and populated after the tables it
 * references. Returns the order plus any tables involved in a dependency cycle.
 *
 * Cycles are legal in SQLite (self-references and mutual references both occur),
 * so we report them rather than failing: the caller handles them by emitting
 * `PRAGMA defer_foreign_keys = true`.
 */
export function topologicalOrder(tables: TableInfo[]): {
  order: string[];
  cyclic: string[];
} {
  const names = new Set(tables.map((t) => t.name));
  const dependencies = new Map<string, Set<string>>();

  for (const table of tables) {
    const deps = new Set<string>();
    for (const fk of table.foreignKeys) {
      // Ignore self-references (always satisfiable) and references to tables
      // outside the copy set.
      if (fk.referencedTable !== table.name && names.has(fk.referencedTable)) {
        deps.add(fk.referencedTable);
      }
    }
    dependencies.set(table.name, deps);
  }

  const order: string[] = [];
  const placed = new Set<string>();

  // Kahn's algorithm, taking ties in declaration order for a stable result.
  let progress = true;
  while (progress) {
    progress = false;
    for (const table of tables) {
      if (placed.has(table.name)) continue;
      const deps = dependencies.get(table.name) as Set<string>;
      if ([...deps].every((d) => placed.has(d))) {
        order.push(table.name);
        placed.add(table.name);
        progress = true;
      }
    }
  }

  const cyclic = tables.filter((t) => !placed.has(t.name)).map((t) => t.name);

  return { order: [...order, ...cyclic], cyclic };
}

/**
 * Build the SELECT projection for reading a table without losing data.
 *
 * Every value is transported with a `typeof()` tag, because SQLite storage classes
 * are per-value rather than per-column: a BLOB-affinity column may legally hold
 * text, and an INTEGER column may hold a string. Inferring the class from the
 * declared affinity is what silently rewrote every BLOB as its hex text.
 *
 * Per storage class:
 * - `integer` travels as exact decimal text, because D1 returns JSON and JSON
 *   numbers pass through JavaScript's 53-bit floats, so an int64 read as a number is
 *   silently truncated. Cloudflare documents this for `d1 export`.
 * - `real` travels as a JSON number, which round-trips a float64 exactly and avoids
 *   SQLite's lossy default real-to-text conversion.
 * - `blob` travels as hex.
 * - `text` travels as-is, unless it contains a NUL byte, which SQLite truncates at;
 *   that case travels as hex and is restored with a cast.
 */
export function readProjection(columns: ColumnInfo[]): string {
  return columns.map((column) => taggedValue(quoteIdent(column.name))).join(", ");
}

/** Tagged transport expression for one column reference. */
function taggedValue(ident: string): string {
  return (
    `CASE typeof(${ident})` +
    " WHEN 'null' THEN NULL" +
    ` WHEN 'real' THEN ${ident}` +
    ` WHEN 'integer' THEN 'i:' || CAST(${ident} AS TEXT)` +
    ` WHEN 'blob' THEN 'b:' || hex(${ident})` +
    ` ELSE CASE WHEN instr(${ident}, char(0)) > 0` +
    ` THEN 'x:' || hex(${ident})` +
    ` ELSE 't:' || ${ident} END` +
    ` END AS ${ident}`
  );
}

/**
 * Columns suitable for keyset pagination.
 *
 * Prefers `rowid`, which is always unique and NOT NULL. A declared PRIMARY KEY is
 * deliberately not preferred: SQLite only enforces NOT NULL on primary keys for
 * `WITHOUT ROWID` and `STRICT` tables, so an ordinary table's `TEXT PRIMARY KEY` can
 * contain NULL. That breaks seek pagination silently, because `col > NULL` matches
 * nothing: the reader sees an empty page, concludes the table is exhausted, and
 * reports success having copied only part of it.
 *
 * `WITHOUT ROWID` tables have no rowid, but their primary keys are guaranteed NOT
 * NULL, so paging on the declared key is safe there.
 */
export function paginationKey(table: TableInfo): string[] {
  if (!table.withoutRowid) return ["rowid"];

  const pk = table.columns
    .filter((c) => c.pkPosition > 0)
    .toSorted((a, b) => a.pkPosition - b.pkPosition)
    .map((c) => c.name);

  if (pk.length > 0) return pk;

  throw new Error(
    `Table "${table.name}" is WITHOUT ROWID and has no primary key, so it cannot be ` +
      "paged deterministically.",
  );
}
