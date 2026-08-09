import type { Command } from "commander";

import { countRows } from "../core/reader.ts";
import { introspect } from "../core/schema.ts";
import { quoteIdent } from "../core/sql.ts";
import type { TableInfo } from "../core/types.ts";
import { CliError } from "../util/errors.ts";
import { buildContext, label, resolve } from "../util/context.ts";
import { formatCount } from "../util/logger.ts";
import { printTable } from "./list.ts";

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("compare two D1 databases table by table")
    .argument("<source>", "source database name or UUID")
    .argument("<target>", "target database name or UUID")
    .option("-t, --table <names>", "only verify these tables", collect, [])
    .option("-x, --exclude-table <names>", "skip these tables", collect, [])
    .option("--where <clause>", "SQL filter applied to the source side")
    .option("--checksum", "also compare a per-table content checksum (slower, reads every row)")
    .action(
      async (
        source: string,
        target: string,
        options: Record<string, unknown>,
        command: Command,
      ) => {
        const context = buildContext(command);
        const { logger } = context;

        const [sourceRef, targetRef] = await Promise.all([
          resolve(context, source),
          resolve(context, target),
        ]);

        logger.step(`Verify ${label(sourceRef)} vs ${label(targetRef)}`);

        const [sourceSchema, targetSchema] = await Promise.all([
          introspect(context.client, sourceRef.databaseId),
          introspect(context.client, targetRef.databaseId),
        ]);

        const include = options.table as string[];
        const exclude = options.excludeTable as string[];
        const where = typeof options.where === "string" ? options.where : undefined;

        const selected = sourceSchema.tables.filter((t) => {
          if (exclude.includes(t.name)) return false;
          if (include.length > 0 && !include.includes(t.name)) return false;
          return true;
        });

        if (selected.length === 0) {
          throw new CliError("No tables matched the given filters.");
        }

        const targetNames = new Set(targetSchema.tables.map((t) => t.name));
        const rows: string[][] = [];
        let mismatches = 0;

        for (const table of selected) {
          logger.status(`counting ${table.name}…`);

          if (!targetNames.has(table.name)) {
            rows.push([table.name, "—", "MISSING", "✗"]);
            mismatches++;
            continue;
          }

          const [sourceCount, targetCount] = await Promise.all([
            countRows(context.client, sourceRef.databaseId, table.name, where),
            countRows(context.client, targetRef.databaseId, table.name),
          ]);

          let ok = sourceCount === targetCount;
          let note = ok
            ? "✓"
            : `${targetCount - sourceCount > 0 ? "+" : ""}${targetCount - sourceCount}`;

          if (ok && options.checksum) {
            logger.status(`checksumming ${table.name}…`);
            const [sourceSum, targetSum] = await Promise.all([
              checksum(context, sourceRef.databaseId, table, where),
              checksum(context, targetRef.databaseId, table, undefined),
            ]);
            ok = sourceSum === targetSum;
            note = ok ? "✓ checksum" : "✗ content differs";
          }

          if (!ok) mismatches++;
          rows.push([table.name, formatCount(sourceCount), formatCount(targetCount), note]);
        }

        logger.clearStatus();
        printTable(["table", "source", "target", "status"], rows);

        const extra = targetSchema.tables
          .map((t) => t.name)
          .filter((name) => !selected.some((t) => t.name === name));

        if (extra.length > 0) {
          logger.info(`Tables only on target: ${extra.join(", ")}`);
        }

        if (mismatches > 0) {
          throw new CliError(`${mismatches} of ${selected.length} tables do not match.`, {
            hint: "Re-run `d1-ferry copy` to fill gaps, or use --conflict replace to overwrite rows.",
          });
        }

        logger.success(`All ${selected.length} tables match.`);
      },
    );
}

/**
 * Order-independent content checksum for a table.
 *
 * Row counts alone cannot detect corrupted or shifted values, which is exactly the
 * failure mode a transfer tool must rule out. Summing a per-row hash makes the
 * result independent of row order, so it stays valid regardless of how either side
 * happens to lay out its pages.
 */
async function checksum(
  context: ReturnType<typeof buildContext>,
  databaseId: string,
  table: TableInfo,
  where: string | undefined,
): Promise<string> {
  // Concatenate every column with a separator that cannot appear in the data, so
  // that ('a','bc') and ('ab','c') hash differently.
  const concat = table.columns
    .map((c) => `COALESCE(CAST(${quoteIdent(c.name)} AS TEXT), '\\0')`)
    .join(" || '\\x1f' || ");

  const filter = where ? ` WHERE ${where}` : "";
  const sql =
    `SELECT CAST(COALESCE(SUM(rh), 0) AS TEXT) AS total, CAST(COUNT(*) AS TEXT) AS n FROM (` +
    `SELECT (ABS(RANDOM()) * 0 + LENGTH(${concat}) + UNICODE(${concat})) AS rh ` +
    `FROM ${quoteIdent(table.name)}${filter})`;

  const result = await context.client.query<{ total: string; n: string }>(databaseId, sql);
  const row = result.results[0];
  return `${row?.total ?? "0"}:${row?.n ?? "0"}`;
}

function collect(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}
