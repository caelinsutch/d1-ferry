import { describe, expect, it } from "bun:test";

import { paginationKey, readProjection, topologicalOrder } from "./schema.ts";
import { affinityOf } from "./sql.ts";
import type { ColumnInfo, ForeignKeyInfo, StorageClass, TableInfo } from "./types.ts";

function column(name: string, declaredType = "TEXT", pkPosition = 0): ColumnInfo {
  return {
    name,
    declaredType,
    affinity: affinityOf(declaredType),
    notNull: false,
    defaultValue: null,
    pkPosition,
  };
}

function table(
  name: string,
  options: {
    columns?: ColumnInfo[];
    fks?: ForeignKeyInfo[];
    withoutRowid?: boolean;
  } = {},
): TableInfo {
  return {
    name,
    type: "table",
    withoutRowid: options.withoutRowid ?? false,
    strict: false,
    columns: options.columns ?? [column("id", "INTEGER", 1)],
    foreignKeys: options.fks ?? [],
    ddl: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`,
  };
}

function fk(referencedTable: string): ForeignKeyInfo {
  return { referencedTable, columns: ["ref"], referencedColumns: ["id"] };
}

describe("affinityOf", () => {
  const cases: Array<[string, StorageClass]> = [
    ["INTEGER", "INTEGER"],
    ["BIGINT", "INTEGER"],
    ["INT8", "INTEGER"],
    ["VARCHAR(50)", "TEXT"],
    ["TEXT", "TEXT"],
    ["CLOB", "TEXT"],
    ["BLOB", "BLOB"],
    ["", "BLOB"],
    ["REAL", "REAL"],
    ["DOUBLE", "REAL"],
    ["FLOAT", "REAL"],
    ["DECIMAL(10,2)", "NUMERIC"],
    ["BOOLEAN", "NUMERIC"],
    ["DATE", "NUMERIC"],
  ];

  it.each(cases)("maps %s to %s", (declared, expected) => {
    expect(affinityOf(declared)).toBe(expected);
  });

  it("prefers INT over CHAR, per SQLite's rule order", () => {
    // "INTCHAR" contains both; INT wins because it is checked first.
    expect(affinityOf("INTCHAR")).toBe("INTEGER");
  });
});

describe("topologicalOrder", () => {
  it("places referenced tables before the tables that reference them", () => {
    const tables = [table("orders", { fks: [fk("users")] }), table("users")];

    const { order, cyclic } = topologicalOrder(tables);

    expect(order.indexOf("users")).toBeLessThan(order.indexOf("orders"));
    expect(cyclic).toEqual([]);
  });

  it("resolves a multi-level dependency chain", () => {
    const tables = [table("c", { fks: [fk("b")] }), table("a"), table("b", { fks: [fk("a")] })];

    const { order } = topologicalOrder(tables);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("ignores self-references, which are always satisfiable", () => {
    const tables = [table("nodes", { fks: [fk("nodes")] })];
    const { order, cyclic } = topologicalOrder(tables);

    expect(order).toEqual(["nodes"]);
    expect(cyclic).toEqual([]);
  });

  it("ignores references to tables outside the copy set", () => {
    const tables = [table("orders", { fks: [fk("archived_users")] })];
    const { order, cyclic } = topologicalOrder(tables);

    expect(order).toEqual(["orders"]);
    expect(cyclic).toEqual([]);
  });

  it("reports a mutual cycle instead of dropping tables", () => {
    const tables = [table("a", { fks: [fk("b")] }), table("b", { fks: [fk("a")] })];
    const { order, cyclic } = topologicalOrder(tables);

    expect(order.toSorted()).toEqual(["a", "b"]);
    expect(cyclic.toSorted()).toEqual(["a", "b"]);
  });

  it("never loses a table, even in a mixed cyclic/acyclic graph", () => {
    const tables = [
      table("a", { fks: [fk("b")] }),
      table("b", { fks: [fk("a")] }),
      table("c"),
      table("d", { fks: [fk("c")] }),
    ];

    const { order } = topologicalOrder(tables);

    expect(order.toSorted()).toEqual(["a", "b", "c", "d"]);
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("is stable for independent tables, following declaration order", () => {
    const tables = [table("z"), table("m"), table("a")];
    expect(topologicalOrder(tables).order).toEqual(["z", "m", "a"]);
  });
});

describe("readProjection", () => {
  it("tags every value with its storage class, not the declared affinity", () => {
    // SQLite types are per-value: a BLOB column can hold text. Tagging on typeof()
    // is what keeps a blob from being restored as its hex text.
    const projection = readProjection([column("data", "BLOB")]);

    expect(projection).toContain('CASE typeof("data")');
    expect(projection).toContain("WHEN 'blob' THEN 'b:' || hex(\"data\")");
    expect(projection).toContain("WHEN 'null' THEN NULL");
    expect(projection).toContain('AS "data"');
  });

  it("transports integers as exact text to survive JSON", () => {
    expect(readProjection([column("id", "INTEGER")])).toContain(
      "WHEN 'integer' THEN 'i:' || CAST(\"id\" AS TEXT)",
    );
  });

  it("leaves REAL as a JSON number, which round-trips a float64 exactly", () => {
    expect(readProjection([column("score", "REAL")])).toContain("WHEN 'real' THEN \"score\"");
  });

  it("hex-encodes text containing a NUL byte, which SQLite would truncate at", () => {
    const projection = readProjection([column("body", "TEXT")]);

    expect(projection).toContain('instr("body", char(0)) > 0');
    expect(projection).toContain("'x:' || hex(\"body\")");
    expect(projection).toContain("'t:' || \"body\"");
  });

  it("quotes identifiers that need escaping", () => {
    expect(readProjection([column('we"ird', "TEXT")])).toContain('typeof("we""ird")');
  });

  it("joins multiple columns in declaration order", () => {
    const projection = readProjection([column("id", "INTEGER"), column("name", "TEXT")]);
    expect(projection.indexOf('AS "id"')).toBeLessThan(projection.indexOf('AS "name"'));
  });
});

describe("paginationKey", () => {
  it("prefers rowid, which is unique and never NULL", () => {
    // A declared TEXT PRIMARY KEY may contain NULL on an ordinary table, and
    // `col > NULL` matches nothing, which silently ends pagination early.
    const t = table("users", { columns: [column("id", "TEXT", 1), column("name")] });
    expect(paginationKey(t)).toEqual(["rowid"]);
  });

  it("uses rowid even when there is no primary key", () => {
    const t = table("logs", { columns: [column("message")] });
    expect(paginationKey(t)).toEqual(["rowid"]);
  });

  it("uses the primary key for WITHOUT ROWID tables, where it is NOT NULL", () => {
    const t = table("memberships", {
      columns: [column("b", "TEXT", 2), column("a", "TEXT", 1), column("x")],
      withoutRowid: true,
    });
    expect(paginationKey(t)).toEqual(["a", "b"]);
  });

  it("refuses a WITHOUT ROWID table that has no primary key", () => {
    const t = table("bad", { columns: [column("a")], withoutRowid: true });
    expect(() => paginationKey(t)).toThrow(/WITHOUT ROWID and has no primary key/);
  });
});
