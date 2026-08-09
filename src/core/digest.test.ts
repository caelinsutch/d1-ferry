import { describe, expect, it } from "bun:test";

import type { D1Client, D1RawResult } from "./client.ts";
import { tableDigest } from "./digest.ts";
import { affinityOf } from "./sql.ts";
import type { ColumnInfo, SqlValue, TableInfo } from "./types.ts";

function column(name: string, declaredType = "TEXT"): ColumnInfo {
  return {
    name,
    declaredType,
    affinity: affinityOf(declaredType),
    notNull: false,
    defaultValue: null,
    pkPosition: 0,
  };
}

function table(name: string, columns: ColumnInfo[]): TableInfo {
  return {
    name,
    type: "table",
    withoutRowid: false,
    strict: false,
    columns,
    foreignKeys: [],
    ddl: null,
  };
}

/**
 * Serve one page of wire-format rows. Rows are given as the tagged values D1 would
 * return, with the untagged cursor column first, so the reader's decode path runs.
 */
function clientReturning(rows: SqlValue[][], columnNames: string[]): D1Client {
  let served = false;
  return {
    raw(): Promise<D1RawResult> {
      const page = served ? [] : rows;
      served = true;
      return Promise.resolve({
        columns: ["__cursor_0", ...columnNames],
        rows: page,
        meta: {},
      });
    },
  } as unknown as D1Client;
}

const T = table("t", [column("a"), column("b")]);

/** Digest a fixed set of wire rows. */
async function digestOf(rows: SqlValue[][]): Promise<string> {
  const result = await tableDigest(clientReturning(rows, ["a", "b"]), "db", T, { pageSize: 100 });
  return result.digest;
}

describe("tableDigest", () => {
  it("is stable for identical data", async () => {
    const rows: SqlValue[][] = [
      ["1", "t:a", "t:b"],
      ["2", "t:c", "t:d"],
    ];
    expect(await digestOf(rows)).toBe(await digestOf(rows));
  });

  it("counts the rows it hashed", async () => {
    const result = await tableDigest(
      clientReturning(
        [
          ["1", "t:a", "t:b"],
          ["2", "t:c", "t:d"],
        ],
        ["a", "b"],
      ),
      "db",
      T,
      { pageSize: 100 },
    );
    expect(result.rows).toBe(2);
  });

  it("is independent of row order", async () => {
    // Rows can come back in a different physical order on each side; the digest must
    // not care, or verify would report false mismatches.
    const forward = await digestOf([
      ["1", "t:a", "t:b"],
      ["2", "t:c", "t:d"],
    ]);
    const reverse = await digestOf([
      ["2", "t:c", "t:d"],
      ["1", "t:a", "t:b"],
    ]);
    expect(forward).toBe(reverse);
  });

  it("detects a single changed character", async () => {
    const a = await digestOf([["1", "t:hello", "t:world"]]);
    const b = await digestOf([["1", "t:hellp", "t:world"]]);
    expect(a).not.toBe(b);
  });

  it("detects transposed values across columns", async () => {
    // The old length-based checksum could not tell these apart.
    const a = await digestOf([["1", "t:a", "t:bc"]]);
    const b = await digestOf([["1", "t:ab", "t:c"]]);
    expect(a).not.toBe(b);
  });

  it("detects values swapped between columns", async () => {
    const a = await digestOf([["1", "t:x", "t:y"]]);
    const b = await digestOf([["1", "t:y", "t:x"]]);
    expect(a).not.toBe(b);
  });

  it("distinguishes an integer, a real, and a string that look alike", async () => {
    const asInt = await digestOf([["1", "i:1", "t:z"]]);
    const asReal = await digestOf([["1", 1, "t:z"]]);
    const asText = await digestOf([["1", "t:1", "t:z"]]);

    expect(new Set([asInt, asReal, asText]).size).toBe(3);
  });

  it("distinguishes NULL from an empty string", async () => {
    const asNull = await digestOf([["1", null, "t:z"]]);
    const asEmpty = await digestOf([["1", "t:", "t:z"]]);
    expect(asNull).not.toBe(asEmpty);
  });

  it("distinguishes a blob from the text of its hex", async () => {
    const asBlob = await digestOf([["1", "b:DEAD", "t:z"]]);
    const asText = await digestOf([["1", "t:DEAD", "t:z"]]);
    expect(asBlob).not.toBe(asText);
  });

  it("does not let a duplicated row cancel itself out", async () => {
    // XOR accumulation would make these identical; summation does not.
    const once = await digestOf([["1", "t:a", "t:b"]]);
    const twice = await digestOf([
      ["1", "t:a", "t:b"],
      ["2", "t:a", "t:b"],
    ]);
    expect(once).not.toBe(twice);
  });

  it("detects a missing row", async () => {
    const three = await digestOf([
      ["1", "t:a", "t:a"],
      ["2", "t:b", "t:b"],
      ["3", "t:c", "t:c"],
    ]);
    const two = await digestOf([
      ["1", "t:a", "t:a"],
      ["2", "t:b", "t:b"],
    ]);
    expect(three).not.toBe(two);
  });

  it("distinguishes float values that share a decimal prefix", async () => {
    const a = await digestOf([["1", 0.1, "t:z"]]);
    const b = await digestOf([["1", 0.1 + Number.EPSILON, "t:z"]]);
    expect(a).not.toBe(b);
  });

  it("returns a fixed-width hex digest", async () => {
    const digest = await digestOf([["1", "t:a", "t:b"]]);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("digests an empty table without error", async () => {
    const result = await tableDigest(clientReturning([], ["a", "b"]), "db", T);
    expect(result).toEqual({ digest: "0000000000000000", rows: 0 });
  });
});
