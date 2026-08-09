import type { Command } from "commander";

import { tableDigest } from "../core/digest.ts";
import { countRows } from "../core/reader.ts";
import { introspect } from "../core/schema.ts";
import { CliError } from "../util/errors.ts";
import { buildContext, label, resolve } from "../util/context.ts";
import { formatCount } from "../util/logger.ts";
import { printTable, writeJson } from "../util/output.ts";

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("compare two D1 databases table by table")
    .argument("<source>", "source database name or UUID")
    .argument("<target>", "target database name or UUID")
    .option("-t, --table <names>", "only verify these tables", collect, [])
    .option("-x, --exclude-table <names>", "skip these tables", collect, [])
    .option("--where <clause>", "SQL filter applied to the source side")
    .option(
      "--checksum",
      "also compare an order-independent content digest (reads every row on both sides)",
    )
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
        const results: TableComparison[] = [];
        let mismatches = 0;

        for (const table of selected) {
          logger.status(`counting ${table.name}…`);

          if (!targetNames.has(table.name)) {
            results.push({ table: table.name, match: false, reason: "missing-on-target" });
            mismatches++;
            continue;
          }

          const [sourceCount, targetCount] = await Promise.all([
            countRows(context.client, sourceRef.databaseId, table.name, where),
            countRows(context.client, targetRef.databaseId, table.name),
          ]);

          const comparison: TableComparison = {
            table: table.name,
            sourceRows: sourceCount,
            targetRows: targetCount,
            match: sourceCount === targetCount,
          };
          if (!comparison.match) comparison.reason = "row-count";

          if (comparison.match && options.checksum) {
            logger.status(`digesting ${table.name} (reads every row on both sides)…`);
            const [sourceDigest, targetDigest] = await Promise.all([
              tableDigest(
                context.client,
                sourceRef.databaseId,
                table,
                where !== undefined ? { where } : {},
              ),
              tableDigest(context.client, targetRef.databaseId, table),
            ]);

            comparison.sourceDigest = sourceDigest.digest;
            comparison.targetDigest = targetDigest.digest;
            comparison.match = sourceDigest.digest === targetDigest.digest;
            if (!comparison.match) comparison.reason = "content";
          }

          if (!comparison.match) mismatches++;
          results.push(comparison);
        }

        logger.clearStatus();

        const extra = targetSchema.tables
          .map((t) => t.name)
          .filter((name) => !selected.some((t) => t.name === name));

        if (context.json) {
          writeJson({
            source: {
              id: sourceRef.databaseId,
              ...(sourceRef.name ? { name: sourceRef.name } : {}),
            },
            target: {
              id: targetRef.databaseId,
              ...(targetRef.name ? { name: targetRef.name } : {}),
            },
            match: mismatches === 0,
            checked: results.length,
            mismatches,
            digestCompared: Boolean(options.checksum),
            tables: results,
            onlyOnTarget: extra,
          });
        } else {
          printTable(
            ["table", "source", "target", "status"],
            results.map((r) => [
              r.table,
              r.sourceRows === undefined ? "—" : formatCount(r.sourceRows),
              r.targetRows === undefined ? "MISSING" : formatCount(r.targetRows),
              describe(r),
            ]),
          );

          if (extra.length > 0) {
            logger.info(`Tables only on target: ${extra.join(", ")}`);
          }
        }

        if (mismatches > 0) {
          throw new CliError(`${mismatches} of ${selected.length} tables do not match.`, {
            hint: "Re-run `d1-ferry copy` to fill gaps, or use --conflict replace to overwrite rows.",
          });
        }

        if (!context.json) logger.success(`All ${selected.length} tables match.`);
      },
    );
}

/** Outcome of comparing one table across two databases. */
interface TableComparison {
  table: string;
  match: boolean;
  sourceRows?: number;
  targetRows?: number;
  sourceDigest?: string;
  targetDigest?: string;
  reason?: "missing-on-target" | "row-count" | "content";
}

/** Human-readable status cell for one comparison. */
function describe(r: TableComparison): string {
  if (r.reason === "missing-on-target") return "✗ missing";
  if (r.reason === "content") return "✗ content differs";
  if (r.reason === "row-count") {
    const delta = (r.targetRows ?? 0) - (r.sourceRows ?? 0);
    return `${delta > 0 ? "+" : ""}${delta}`;
  }
  return r.sourceDigest ? `✓ ${r.sourceDigest}` : "✓";
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
