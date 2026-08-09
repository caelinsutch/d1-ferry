import type { Command } from "commander";

import { buildContext } from "../util/context.ts";
import { formatBytes } from "../util/logger.ts";

export function registerList(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("list the D1 databases in the account")
    .action(async (_options: unknown, command: Command) => {
      const { client, logger } = buildContext(command);

      const databases = await client.listDatabases();
      if (databases.length === 0) {
        logger.warn("This account has no D1 databases.");
        return;
      }

      const sorted = databases.toSorted((a, b) => a.name.localeCompare(b.name));
      const width = Math.max(...sorted.map((d) => d.name.length));

      for (const database of sorted) {
        process.stdout.write(`${database.name.padEnd(width)}  ${database.uuid}\n`);
      }

      logger.info(`${sorted.length} database${sorted.length === 1 ? "" : "s"}.`);
    });
}

/** Shared table-printing helper for the report-style commands. */
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

export { formatBytes };
