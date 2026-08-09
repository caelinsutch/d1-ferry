import { createHash } from "node:crypto";

import type { D1Client } from "./client.ts";
import { DEFAULTS } from "./limits.ts";
import { TableReader } from "./reader.ts";
import { isRawSql } from "./sql.ts";
import type { SqlValue, TableInfo } from "./types.ts";

/** Result of digesting a table. */
export interface TableDigest {
  /** Order-independent digest of every value in the table. */
  digest: string;
  rows: number;
}

/** 2^64, the modulus for accumulating per-row hashes. */
const MODULUS = 1n << 64n;

/**
 * Canonically serialize one value for hashing.
 *
 * Each storage class gets a distinct prefix so that values which happen to share a
 * textual form still hash differently: the integer 1, the real 1.0, and the string
 * "1" are three different values in SQLite and must not collide. Lengths are included
 * for variable-width data so that ("a","bc") cannot hash the same as ("ab","c").
 */
function canonical(value: SqlValue): string {
  if (value === null || value === undefined) return "N";
  if (isRawSql(value)) return `X${value.sql.length}:${value.sql}`;
  if (typeof value === "bigint") return `I${value.toString()}`;
  if (typeof value === "boolean") return `I${value ? 1 : 0}`;
  if (typeof value === "number") {
    // Exact float64 bits, so no decimal rendering can lose or add precision.
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(value);
    return `R${buffer.toString("hex")}`;
  }
  if (value instanceof Uint8Array) {
    return `B${value.length}:${Buffer.from(value).toString("hex")}`;
  }
  return `S${value.length}:${value}`;
}

/** Hash one row to a 64-bit value. */
function hashRow(row: readonly SqlValue[]): bigint {
  const hash = createHash("sha256");
  for (const value of row) {
    hash.update(canonical(value));
    hash.update("\u001f");
  }
  return hash.digest().readBigUInt64BE(0);
}

/**
 * Compute an order-independent content digest for a table.
 *
 * Row counts alone cannot detect corrupted or transposed values, which is the exact
 * failure a transfer tool must rule out. Each row is hashed with SHA-256 and the
 * 64-bit truncations are summed modulo 2^64, which makes the result independent of the
 * order rows come back in while still being sensitive to duplicates -- unlike XOR,
 * where a duplicated row cancels itself out.
 *
 * This deliberately reads every row on both sides. A digest computed inside SQL would
 * be cheaper, but D1 exposes no real hash function, and an arithmetic stand-in built
 * from `LENGTH`/`UNICODE` collides so easily that it would report success on data it
 * had never actually compared.
 */
export async function tableDigest(
  client: D1Client,
  databaseId: string,
  table: TableInfo,
  options: { where?: string; pageSize?: number; onProgress?: (rows: number) => void } = {},
): Promise<TableDigest> {
  const reader = new TableReader(client, databaseId, table, {
    pageSize: options.pageSize ?? DEFAULTS.readPageSize,
    ...(options.where !== undefined ? { where: options.where } : {}),
  });

  let total = 0n;
  let rows = 0;

  for await (const page of reader.pages()) {
    for (const row of page.rows) {
      total = (total + hashRow(row)) % MODULUS;
      rows++;
    }
    options.onProgress?.(rows);
  }

  return { digest: total.toString(16).padStart(16, "0"), rows };
}
