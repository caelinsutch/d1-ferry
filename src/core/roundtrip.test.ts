import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { StatementPacker } from "./packer.ts";
import { readProjection } from "./schema.ts";
import { affinityOf, decodeTransported, quoteIdent } from "./sql.ts";
import type { ColumnInfo, SqlValue } from "./types.ts";

/**
 * End-to-end fidelity tests against real SQLite.
 *
 * These exercise the actual transport contract -- `readProjection` builds the SELECT,
 * `decodeTransported` restores typed values, `StatementPacker` regenerates SQL -- then
 * assert the target is byte-for-byte identical to the source.
 *
 * This is the layer that catches silent corruption. A unit test on the encoder can
 * happily agree with a wrong assumption; SQLite cannot.
 *
 * Note on SQL construction below: table and column names cannot be bound as
 * parameters (and PRAGMA takes none), so identifiers are interpolated through
 * `quoteIdent`, which is the same escaping the production code relies on. Every
 * identifier here is a literal defined in this file.
 */

/** Run a query and return raw row arrays. */
function rows(db: Database, sql: string): unknown[][] {
  return db.query(sql).values() as unknown[][];
}

/** Run a query and return the first row as an object. */
function first(db: Database, sql: string): unknown {
  return db.query(sql).get();
}

/** Create the same table in two fresh in-memory databases. */
function pair(ddl: string): { source: Database; target: Database } {
  const source = new Database(":memory:");
  const target = new Database(":memory:");
  source.run(ddl);
  target.run(ddl);
  return { source, target };
}

/**
 * Assert an identifier is a plain, safe name before it is interpolated.
 *
 * Table names cannot be bound as parameters and PRAGMA accepts none, so an allowlist
 * pattern is the mitigation. Every identifier in this file is a literal, but this
 * keeps that guarantee enforced rather than assumed.
 */
function safeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to interpolate unsafe identifier: ${JSON.stringify(name)}`);
  }
  return quoteIdent(name);
}

/** Read a table's columns the same way `introspect` does, via PRAGMA table_info. */
function columnsOf(db: Database, table: string): ColumnInfo[] {
  const sql = `PRAGMA table_info(${safeIdent(table)})`;
  const info = db.query(sql).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;

  return info.map((r) => ({
    name: r.name,
    declaredType: r.type ?? "",
    affinity: affinityOf(r.type ?? ""),
    notNull: r.notnull === 1,
    defaultValue: r.dflt_value,
    pkPosition: r.pk,
  }));
}

/**
 * Copy one table between two SQLite databases through the real pipeline, returning
 * the SQL that was generated.
 */
function copyTable(source: Database, target: Database, table: string): string[] {
  const columns = columnsOf(source, table);

  // Mirrors TableReader: select the tagged projection, then decode each value.
  const wire = rows(source, `SELECT ${readProjection(columns)} FROM ${safeIdent(table)}`);
  const decoded = wire.map((row) => row.map((v) => decodeTransported(v as SqlValue)));

  const packer = new StatementPacker({ table, columns, conflict: "replace" });
  const statements: string[] = [];

  for (const row of decoded) {
    for (const statement of packer.push(row)) statements.push(statement.sql);
  }
  const tail = packer.flush();
  if (tail) statements.push(tail.sql);

  for (const sql of statements) target.run(sql);

  return statements;
}

describe("round-trip fidelity against real SQLite", () => {
  it("preserves BLOBs as binary, not as their hex text", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)");

    // Every byte value including 0x00, plus an empty blob and a NULL.
    const allBytes = new Uint8Array(256).map((_, i) => i);
    source.run("INSERT INTO t VALUES (?, ?)", [1, allBytes]);
    source.run("INSERT INTO t VALUES (?, ?)", [2, new Uint8Array(0)]);
    source.run("INSERT INTO t VALUES (?, ?)", [3, null]);

    const statements = copyTable(source, target, "t");

    // The regression: a blob must not be re-emitted as a quoted hex string.
    expect(statements.join("\n")).toContain("X'");
    expect(first(target, "SELECT typeof(data) AS t FROM t WHERE id = 1")).toEqual({ t: "blob" });

    const back = rows(target, "SELECT data FROM t WHERE id = 1")[0]?.[0];
    expect([...(back as Uint8Array)]).toEqual([...allBytes]);

    const probe = "SELECT id, typeof(data) AS t, hex(data) AS h FROM t ORDER BY id";
    expect(rows(target, probe)).toEqual(rows(source, probe));
  });

  it("preserves int64 values beyond JavaScript's safe range", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER)");

    source.run("INSERT INTO t VALUES (1, 9223372036854775807)");
    source.run("INSERT INTO t VALUES (2, -9223372036854775808)");
    source.run("INSERT INTO t VALUES (3, 9007199254740993)"); // 2^53 + 1

    copyTable(source, target, "t");

    const probe = "SELECT CAST(big AS TEXT) AS b FROM t ORDER BY id";
    expect(rows(target, probe).flat()).toEqual([
      "9223372036854775807",
      "-9223372036854775808",
      "9007199254740993",
    ]);
    expect(rows(target, probe)).toEqual(rows(source, probe));
  });

  it("preserves text that would break naive escaping", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)");

    const nasty = [
      "O'Brien",
      "'; DROP TABLE t; --",
      'double "quotes"',
      "back\\slash",
      "new\nline\r\ttab",
      "emoji 🙂🇺🇸 and ünïcode",
      "'' '''' ''''''",
      "",
      "line\u2028separator\u2029",
      "%s %d {} ${x} `tick`",
    ];
    for (const [i, s] of nasty.entries()) {
      source.run("INSERT INTO t VALUES (?, ?)", [i + 1, s]);
    }

    copyTable(source, target, "t");

    expect(rows(target, "SELECT s FROM t ORDER BY id").flat()).toEqual(nasty);
    // The table still exists, so no injected statement executed.
    expect(first(target, "SELECT count(*) AS n FROM t")).toEqual({ n: nasty.length });
  });

  it("preserves text containing a NUL byte, which a literal would truncate", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)");

    // Bound as a parameter so the NUL genuinely reaches storage.
    source.run("INSERT INTO t VALUES (1, ?)", ["before\u0000after"]);

    copyTable(source, target, "t");

    const probe = "SELECT hex(s) AS h, typeof(s) AS t, length(s) AS l FROM t";
    expect(first(target, probe)).toEqual(first(source, probe));
    expect(first(target, probe)).toMatchObject({ t: "text" });
  });

  it("preserves REAL values exactly", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, r REAL)");

    const reals = [0.1, 1 / 3, 5e-324, 1.7976931348623157e308, -2.5, 0];
    for (const [i, r] of reals.entries()) {
      source.run("INSERT INTO t VALUES (?, ?)", [i + 1, r]);
    }

    copyTable(source, target, "t");

    // Compare the raw IEEE-754 bits, not a decimal rendering.
    const probe = "SELECT hex(CAST(r AS BLOB)) AS bits, typeof(r) AS t FROM t ORDER BY id";
    expect(rows(target, probe)).toEqual(rows(source, probe));
  });

  it("preserves per-value types in a mixed-affinity column", () => {
    // A BLOB-affinity column legally holding text, an integer, a real, and a blob.
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, mixed BLOB)");

    source.run("INSERT INTO t VALUES (1, ?)", ["a string"]);
    source.run("INSERT INTO t VALUES (2, ?)", [42]);
    source.run("INSERT INTO t VALUES (3, ?)", [2.5]);
    source.run("INSERT INTO t VALUES (4, ?)", [new Uint8Array([1, 2, 3])]);
    source.run("INSERT INTO t VALUES (5, NULL)");

    copyTable(source, target, "t");

    // This is exactly what guessing from declared affinity gets wrong: the text row
    // would return as a blob, or the blob as hex text.
    const probe = "SELECT typeof(mixed) AS t, hex(mixed) AS h FROM t ORDER BY id";
    expect(rows(target, probe)).toEqual(rows(source, probe));
  });

  it("copies every row of a table whose TEXT PRIMARY KEY contains NULL", () => {
    // Legal in SQLite: NOT NULL on a primary key is only enforced for WITHOUT ROWID
    // and STRICT tables. Paging on such a key silently truncates the copy, because
    // `k > NULL` matches nothing and the reader concludes the table has ended.
    const { source, target } = pair("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");

    source.run("INSERT INTO t VALUES (NULL, 'n1')");
    source.run("INSERT INTO t VALUES (NULL, 'n2')");
    source.run("INSERT INTO t VALUES ('a', 'A')");
    source.run("INSERT INTO t VALUES ('b', 'B')");

    copyTable(source, target, "t");

    expect(first(target, "SELECT count(*) AS n FROM t")).toEqual({ n: 4 });
    expect(rows(target, "SELECT v FROM t ORDER BY v").flat()).toEqual(["A", "B", "n1", "n2"]);
  });

  it("keeps every generated statement within D1's limits", () => {
    const { source, target } = pair("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)");

    for (let i = 1; i <= 2_000; i++) {
      source.run("INSERT INTO t VALUES (?, ?)", [i, `row ${i} ${"padding".repeat(20)}`]);
    }

    const statements = copyTable(source, target, "t");

    expect(statements.length).toBeGreaterThan(1);
    for (const sql of statements) {
      expect(Buffer.byteLength(sql, "utf8")).toBeLessThanOrEqual(100_000);
    }
    expect(first(target, "SELECT count(*) AS n FROM t")).toEqual({ n: 2_000 });
  });
});
