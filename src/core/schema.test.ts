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
  it("casts INTEGER columns to TEXT to protect int64 precision", () => {
    const projection = readProjection([column("id", "INTEGER")]);
    expect(projection).toBe('CAST("id" AS TEXT) AS "id"');
  });

  it("hex-encodes BLOBs while preserving NULL", () => {
    const projection = readProjection([column("data", "BLOB")]);
    expect(projection).toBe('CASE WHEN "data" IS NULL THEN NULL ELSE hex("data") END AS "data"');
  });

  it("passes TEXT and REAL through untouched", () => {
    expect(readProjection([column("name", "TEXT")])).toBe('"name"');
    expect(readProjection([column("score", "REAL")])).toBe('"score"');
  });

  it("quotes identifiers that need escaping", () => {
    expect(readProjection([column('we"ird', "TEXT")])).toBe('"we""ird"');
  });

  it("joins multiple columns in declaration order", () => {
    const projection = readProjection([column("id", "INTEGER"), column("name", "TEXT")]);
    expect(projection).toBe('CAST("id" AS TEXT) AS "id", "name"');
  });
});

describe("paginationKey", () => {
  it("uses the primary key when one exists", () => {
    const t = table("users", { columns: [column("id", "INTEGER", 1), column("name")] });
    expect(paginationKey(t)).toEqual(["id"]);
  });

  it("orders a composite key by its declared position", () => {
    const t = table("memberships", {
      columns: [column("b", "TEXT", 2), column("a", "TEXT", 1), column("x")],
    });
    expect(paginationKey(t)).toEqual(["a", "b"]);
  });

  it("falls back to rowid when there is no primary key", () => {
    const t = table("logs", { columns: [column("message")] });
    expect(paginationKey(t)).toEqual(["rowid"]);
  });

  it("refuses a WITHOUT ROWID table that has no primary key", () => {
    const t = table("bad", { columns: [column("a")], withoutRowid: true });
    expect(() => paginationKey(t)).toThrow(/WITHOUT ROWID and has no primary key/);
  });
});
