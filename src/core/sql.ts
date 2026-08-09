import type { SqlValue, StorageClass } from "./types.ts";

/**
 * Quote an identifier (table or column name) for safe interpolation.
 *
 * D1's 100-bound-parameter ceiling forces us to build bulk INSERTs by inlining
 * literals rather than binding them, so every identifier and value in this module
 * is escaped by hand. Correctness here is load-bearing.
 */
export function quoteIdent(name: string): string {
  if (name.includes("\u0000")) {
    throw new Error(`Identifier contains a NUL byte: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string as a SQLite text literal. */
export function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQLite type affinity rules, applied to a declared column type.
 * https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 */
export function affinityOf(declaredType: string): StorageClass {
  const t = declaredType.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Matches a string that is exactly a decimal integer, with no precision loss risk. */
const INTEGER_TEXT = /^-?\d+$/;

/** Matches a string that is exactly a decimal/exponent float. */
const REAL_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Encode one value as a SQL literal.
 *
 * `affinity` matters for integer fidelity: D1 returns JSON, and JSON numbers go
 * through JavaScript's 52-bit float precision, so an int64 read as a number is
 * silently corrupted. We therefore read INTEGER columns as TEXT and re-emit them
 * here as bare numeric literals, preserving all 64 bits.
 */
export function encodeLiteral(value: SqlValue, affinity?: StorageClass): string {
  if (value === null || value === undefined) return "NULL";

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "boolean") return value ? "1" : "0";

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NULL"; // SQLite cannot store NaN; it stores NULL.
    if (!Number.isFinite(value)) {
      return value > 0 ? "9e999" : "-9e999"; // Round-trips to Infinity in SQLite.
    }
    if (Number.isInteger(value) && !Object.is(value, -0)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `Integer ${value} exceeds JavaScript's safe range and would be corrupted. ` +
            "Read this column as TEXT (see readers.ts) so its exact value survives JSON.",
        );
      }
      return value.toString();
    }
    return formatReal(value);
  }

  if (value instanceof Uint8Array) return encodeBlob(value);

  // A string. If it came from an INTEGER/REAL column read as TEXT for precision
  // safety, emit it unquoted so it lands back in a numeric column as a number.
  if (affinity === "INTEGER" && INTEGER_TEXT.test(value)) return value;
  if (affinity === "REAL" && REAL_TEXT.test(value)) return value;

  return quoteString(value);
}

/** Format a float so it reparses to the identical double. */
function formatReal(value: number): string {
  const s = String(value);
  // Ensure it is unambiguously a REAL and not an INTEGER literal.
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Encode binary data as a SQLite blob literal, `X'deadbeef'`. */
export function encodeBlob(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `X'${hex}'`;
}

/** UTF-8 byte length of a string. Statement limits are measured in bytes, not characters. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
