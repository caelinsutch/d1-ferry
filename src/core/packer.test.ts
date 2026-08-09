import { describe, expect, it } from "bun:test";

import { D1_LIMITS } from "./limits.ts";
import { packRows, StatementPacker } from "./packer.ts";
import { affinityOf, encodeLiteral } from "./sql.ts";
import type { ColumnInfo, SqlValue } from "./types.ts";

function col(name: string, declaredType = "TEXT"): ColumnInfo {
  return {
    name,
    declaredType,
    affinity: affinityOf(declaredType),
    notNull: false,
    defaultValue: null,
    pkPosition: 0,
  };
}

describe("encodeLiteral", () => {
  it("escapes single quotes by doubling them", () => {
    expect(encodeLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("does not let a quote break out of the literal", () => {
    expect(encodeLiteral("'); DROP TABLE users;--")).toBe("'''); DROP TABLE users;--'");
  });

  it("encodes NULL for null and undefined", () => {
    expect(encodeLiteral(null)).toBe("NULL");
  });

  it("encodes blobs as hex literals", () => {
    expect(encodeLiteral(new Uint8Array([0, 15, 255]))).toBe("X'000fff'");
  });

  it("preserves int64 precision when the value arrives as TEXT", () => {
    // 9223372036854775807 is not representable as a JS number; as TEXT it must
    // survive untouched and be emitted as a bare numeric literal.
    expect(encodeLiteral("9223372036854775807", "INTEGER")).toBe("9223372036854775807");
    expect(encodeLiteral("-9223372036854775808", "INTEGER")).toBe("-9223372036854775808");
  });

  it("refuses to silently corrupt an unsafe integer supplied as a number", () => {
    expect(() => encodeLiteral(2 ** 53 + 1)).toThrow(/exceeds JavaScript's safe range/);
  });

  it("handles bigint exactly", () => {
    expect(encodeLiteral(9007199254740993n)).toBe("9007199254740993");
  });

  it("quotes a non-numeric string even when the column is INTEGER", () => {
    expect(encodeLiteral("12ab", "INTEGER")).toBe("'12ab'");
  });

  it("keeps reals distinguishable from integers", () => {
    expect(encodeLiteral(1.5)).toBe("1.5");
    expect(encodeLiteral(2.0)).toBe("2");
  });
});

describe("StatementPacker", () => {
  const columns = [col("id", "INTEGER"), col("name", "TEXT")];

  it("packs multiple rows into one statement", () => {
    const rows: SqlValue[][] = [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ];
    const out = [...packRows(rows, { table: "t", columns })];

    expect(out).toHaveLength(1);
    expect(out[0]?.rowCount).toBe(3);
    expect(out[0]?.sql).toBe(`INSERT INTO "t" ("id","name") VALUES (1,'a'),(2,'b'),(3,'c');`);
  });

  it("never emits a statement over the byte budget", () => {
    const budget = 1_000;
    const rows: SqlValue[][] = Array.from({ length: 500 }, (_, i) => [i, "x".repeat(40)]);

    const out = [...packRows(rows, { table: "t", columns, maxStatementBytes: budget })];

    expect(out.length).toBeGreaterThan(1);
    for (const stmt of out) {
      expect(stmt.bytes).toBeLessThanOrEqual(budget);
      expect(Buffer.byteLength(stmt.sql, "utf8")).toBe(stmt.bytes);
    }
  });

  it("accounts for multi-byte characters in bytes, not code units", () => {
    // Each emoji is 4 UTF-8 bytes; a naive .length check would overshoot the cap.
    const rows: SqlValue[][] = Array.from({ length: 200 }, (_, i) => [i, "🙂".repeat(20)]);
    const budget = 2_000;

    const out = [...packRows(rows, { table: "t", columns, maxStatementBytes: budget })];

    for (const stmt of out) {
      expect(Buffer.byteLength(stmt.sql, "utf8")).toBeLessThanOrEqual(budget);
    }
  });

  it("preserves every row exactly once across statement boundaries", () => {
    const rows: SqlValue[][] = Array.from({ length: 977 }, (_, i) => [i, `name-${i}`]);

    const out = [...packRows(rows, { table: "t", columns, maxStatementBytes: 1_500 })];
    const total = out.reduce((sum, s) => sum + s.rowCount, 0);

    expect(total).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(out.some((s) => s.sql.includes(`(${i},'name-${i}')`))).toBe(true);
    }
  });

  it("throws a clear error when one row cannot fit on its own", () => {
    const rows: SqlValue[][] = [[1, "x".repeat(5_000)]];
    expect(() => [...packRows(rows, { table: "t", columns, maxStatementBytes: 1_000 })]).toThrow(
      /exceeds the 1000-byte statement budget/,
    );
  });

  it("rejects a budget above D1's hard statement limit", () => {
    expect(
      () =>
        new StatementPacker({
          table: "t",
          columns,
          maxStatementBytes: 200_000,
        }),
    ).toThrow(/exceeds D1's hard limit/);
  });

  it("defaults to a budget under the platform ceiling", () => {
    const rows: SqlValue[][] = Array.from({ length: 20_000 }, (_, i) => [i, `row ${i}`]);
    for (const stmt of packRows(rows, { table: "t", columns })) {
      expect(stmt.bytes).toBeLessThan(D1_LIMITS.maxStatementBytes);
    }
  });

  it("applies the conflict strategy to the verb", () => {
    const rows: SqlValue[][] = [[1, "a"]];
    const [ignore] = [...packRows(rows, { table: "t", columns, conflict: "ignore" })];
    const [replace] = [...packRows(rows, { table: "t", columns, conflict: "replace" })];

    expect(ignore?.sql.startsWith("INSERT OR IGNORE INTO")).toBe(true);
    expect(replace?.sql.startsWith("INSERT OR REPLACE INTO")).toBe(true);
  });

  it("quotes identifiers that need it", () => {
    const weird = [col("order"), col('has"quote')];
    const [stmt] = [...packRows([["a", "b"]], { table: "my table", columns: weird })];

    expect(stmt?.sql).toContain(`INSERT INTO "my table" ("order","has""quote")`);
  });

  it("rejects a row whose arity does not match the column list", () => {
    expect(() => [...packRows([[1]], { table: "t", columns })]).toThrow(/1 values but table has 2/);
  });
});
