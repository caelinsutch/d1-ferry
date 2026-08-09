import type { Command } from "commander";

import { StatementPacker } from "../core/packer.ts";
import { TableReader } from "../core/reader.ts";
import { introspect, schemaObjectsFor, topologicalOrder } from "../core/schema.ts";
import { byteLength } from "../core/sql.ts";
import type { TableInfo } from "../core/types.ts";
import { CliError } from "../util/errors.ts";
import { buildContext, label, parseIntOption, parseSizeOption, resolve } from "../util/context.ts";
import { formatBytes, formatCount, formatDuration } from "../util/logger.ts";

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("export a D1 database to a local .sql file that D1 can re-import")
    .argument("<database>", "database name or UUID")
    .option("-o, --output <path>", "output file (default: <database>.sql)")
    .option("-t, --table <names>", "only export these tables", collect, [])
    .option("-x, --exclude-table <names>", "skip these tables", collect, [])
    .option("--where <clause>", "SQL filter applied to every exported table")
    .option("--no-schema", "omit CREATE statements")
    .option("--no-data", "omit INSERT statements")
    .option(
      "--statement-size <bytes>",
      "max bytes per generated INSERT (D1 hard limit is 100KB)",
      parseSizeOption("statement-size"),
    )
    .option("--page-size <rows>", "rows read per request", parseIntOption("page-size"))
    .option(
      "--limit <rows>",
      "stop after about this many rows per table (for sampling a large table)",
      parseIntOption("limit"),
    )
    .action(async (database: string, options: Record<string, unknown>, command: Command) => {
      const context = buildContext(command);
      const { logger } = context;
      const started = Date.now();

      const ref = await resolve(context, database);
      const outputPath = (options.output as string | undefined) ?? `${ref.name ?? database}.sql`;

      logger.step(`Export ${label(ref)} → ${outputPath}`);

      const schema = await introspect(context.client, ref.databaseId);
      const include = options.table as string[];
      const exclude = options.excludeTable as string[];

      const selected = schema.tables.filter((t) => {
        if (exclude.includes(t.name)) return false;
        if (include.length > 0 && !include.includes(t.name)) return false;
        return true;
      });

      if (selected.length === 0) {
        throw new CliError("No tables matched the given filters.", {
          hint: `Available tables: ${schema.tables.map((t) => t.name).join(", ") || "(none)"}`,
        });
      }

      const { order } = topologicalOrder(selected);
      const byName = new Map(selected.map((t) => [t.name, t]));
      const ordered = order
        .map((name) => byName.get(name))
        .filter((t): t is TableInfo => t !== undefined);

      // Stream to disk: a full export can far exceed available memory.
      const sink = Bun.file(outputPath).writer();
      let bytesWritten = 0;
      let rowsWritten = 0;

      const write = (chunk: string): void => {
        sink.write(chunk);
        bytesWritten += byteLength(chunk);
      };

      try {
        write(
          `-- d1-ferry export of ${ref.name ?? ref.databaseId}\n` +
            `-- generated ${new Date().toISOString()}\n` +
            "-- Safe to re-import with: d1-ferry import <database> <file>\n" +
            "PRAGMA defer_foreign_keys = true;\n\n",
        );

        if (options.schema !== false) {
          for (const table of ordered) {
            if (table.ddl) write(`${table.ddl};\n`);
          }
          // Only objects belonging to the exported tables: emitting an index for a
          // table that was filtered out makes the file fail to import.
          const objects = schemaObjectsFor(
            schema,
            ordered.map((t) => t.name),
            { filtered: include.length > 0 || exclude.length > 0 },
          );
          for (const object of objects) {
            write(`${object.ddl};\n`);
          }
          write("\n");
        }

        if (options.data !== false) {
          for (const table of ordered) {
            logger.status(`${table.name}: reading…`);

            const reader = new TableReader(context.client, ref.databaseId, table, {
              ...(options.pageSize !== undefined ? { pageSize: Number(options.pageSize) } : {}),
              ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}),
              ...(typeof options.where === "string" ? { where: options.where } : {}),
            });

            const packer = new StatementPacker({
              table: table.name,
              columns: table.columns,
              ...(options.statementSize !== undefined
                ? { maxStatementBytes: Number(options.statementSize) }
                : {}),
            });

            let tableRows = 0;
            for await (const page of reader.pages()) {
              for (const row of page.rows) {
                for (const statement of packer.push(row)) {
                  write(`${statement.sql}\n`);
                  tableRows += statement.rowCount;
                }
              }
              logger.status(
                `${table.name}: ${formatCount(tableRows)} rows, ${formatBytes(bytesWritten)}`,
              );
            }

            const tail = packer.flush();
            if (tail) {
              write(`${tail.sql}\n`);
              tableRows += tail.rowCount;
            }

            rowsWritten += tableRows;
            logger.clearStatus();
            logger.success(`${table.name}: ${formatCount(tableRows)} rows`);
          }
        }
      } finally {
        await sink.end();
      }

      logger.step("Summary");
      logger.success(
        `${formatCount(rowsWritten)} rows from ${ordered.length} tables → ${outputPath} ` +
          `(${formatBytes(bytesWritten)}) in ${formatDuration(Date.now() - started)}.`,
      );

      if (schema.virtualTables.length > 0) {
        logger.warn(
          `Virtual (FTS5) tables were not exported: ${schema.virtualTables
            .map((v) => v.name)
            .join(", ")}. Recreate them on the target after import.`,
        );
      }
    });
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
