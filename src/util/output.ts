/**
 * Result output.
 *
 * Logs go to stderr (see logger.ts); *results* go to stdout, either as an aligned
 * table for humans or as a single JSON document when `--json` is set. Keeping the two
 * streams separate is what makes `d1-ferry --json verify a b | jq` work while progress
 * is still visible on the terminal.
 */

/** Write one JSON document to stdout, newline-terminated. */
export function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, jsonReplacer, 2)}\n`);
}

/**
 * Serialize the value types that reach a result payload.
 *
 * BigInt has no JSON representation and would otherwise throw; it is emitted as a
 * string so exact int64 values survive rather than being silently rounded.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

/** Print an aligned, borderless table to stdout. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();

  process.stdout.write(`${line(headers)}\n`);
  process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}
