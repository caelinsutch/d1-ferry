import type { RawSql, SqlValue, StorageClass } from "./types.ts";

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

/** Wrap a pre-formatted SQL fragment so {@link encodeLiteral} emits it verbatim. */
export function rawSql(sql: string): RawSql {
  return { sql };
}

/** Whether a value is a {@link RawSql} marker. */
export function isRawSql(value: unknown): value is RawSql {
  return typeof value === "object" && value !== null && typeof (value as RawSql).sql === "string";
}

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

  if (isRawSql(value)) return value.sql;

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "boolean") return value ? "1" : "0";

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NULL"; // SQLite cannot store NaN; it stores NULL.
    if (!Number.isFinite(value)) {
      return value > 0 ? "9e999" : "-9e999"; // Round-trips to Infinity in SQLite.
    }
    if (Number.isInteger(value) && !Object.is(value, -0)) {
      if (Number.isSafeInteger(value)) return value.toString();

      // An integral float64 beyond 2^53. Every float64 of this magnitude is
      // mathematically an integer, so `Number.isInteger` is true for values like
      // 1.8e308 that are plainly REALs -- treating them as integers would reject
      // legitimate data.
      //
      // The column's affinity disambiguates. INTEGER columns are transported as
      // exact text and arrive here as BigInt, so an unsafe *number* against an
      // INTEGER column means precision was already lost upstream; refuse it rather
      // than write a wrong value. Anything else is a REAL that happens to be
      // integral, and is emitted as one.
      if (affinity === "INTEGER") {
        throw new Error(
          `Integer ${value} exceeds JavaScript's safe range and has already lost ` +
            "precision. Transport INTEGER columns as text (see readProjection) so the " +
            "exact value survives JSON.",
        );
      }
      return formatReal(value);
    }
    return formatReal(value);
  }

  if (value instanceof Uint8Array) return encodeBlob(value);

  // A string. If it came from an INTEGER/REAL column read as TEXT for precision
  // safety, emit it unquoted so it lands back in a numeric column as a number.
  if (affinity === "INTEGER" && INTEGER_TEXT.test(value)) return value;
  if (affinity === "REAL" && REAL_TEXT.test(value)) return value;

  // A NUL byte truncates the value at SQLite's parser, silently dropping everything
  // after it, so route such text through a hex blob cast instead of a literal.
  if (value.includes("\u0000")) {
    return `CAST(${encodeBlob(Buffer.from(value, "utf8"))} AS TEXT)`;
  }

  return quoteString(value);
}

/** Tag prefixes emitted by `readProjection` and consumed by {@link decodeTransported}. */
const TRANSPORT_TAGS = {
  text: "t:",
  hexText: "x:",
  blob: "b:",
  integer: "i:",
  real: "r:",
} as const;

/**
 * Decode a tagged value read from a source database back into a typed JS value.
 *
 * SQLite storage classes are per-value, not per-column: a BLOB-affinity column may
 * legally hold text or integers. `readProjection` therefore transports a `typeof()`
 * tag with the data so the original class is restored exactly, instead of being
 * guessed from the column's declared affinity -- guessing is what silently turned
 * every BLOB into its hex text.
 */
export function decodeTransported(value: SqlValue): SqlValue {
  if (typeof value !== "string" || value.length < 2) return value;

  const body = value.slice(2);

  switch (value.slice(0, 2)) {
    case TRANSPORT_TAGS.text:
      return body;
    case TRANSPORT_TAGS.blob:
      return decodeHex(body);
    case TRANSPORT_TAGS.hexText:
      // Text that cannot travel as a literal (embedded NUL); restore it as text.
      return rawSql(`CAST(X'${body.toLowerCase()}' AS TEXT)`);
    case TRANSPORT_TAGS.integer:
      // Exact int64 via BigInt, so nothing is lost to float precision.
      return INTEGER_TEXT.test(body) ? BigInt(body) : body;
    case TRANSPORT_TAGS.real:
      return REAL_TEXT.test(body) ? Number(body) : body;
    default:
      return value;
  }
}

/** Decode a hex string into bytes. */
export function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/iu.test(hex)) {
    throw new Error(`Malformed hex payload: ${hex.slice(0, 32)} (length ${hex.length}).`);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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
