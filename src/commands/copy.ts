import type { Command } from "commander";

import { CheckpointStore, deriveJobId } from "../core/checkpoint.ts";
import { introspect, schemaObjectsFor, topologicalOrder } from "../core/schema.ts";
import { TransferEngine, transferOptionsFrom } from "../core/transfer.ts";
import type { TableInfo } from "../core/types.ts";
import { CliError } from "../util/errors.ts";
import { buildContext, label, parseIntOption, parseSizeOption, resolve } from "../util/context.ts";
import { formatBytes, formatCount, formatDuration } from "../util/logger.ts";

export function registerCopy(program: Command): void {
  program
    .command("copy")
    .description("copy table data from one D1 database to another, resumably")
    .argument("<source>", "source database name or UUID")
    .argument("<target>", "target database name or UUID")
    .option(
      "-t, --table <names>",
      "only copy these tables (repeatable or comma-separated)",
      collect,
      [],
    )
    .option(
      "-x, --exclude-table <names>",
      "skip these tables (repeatable or comma-separated)",
      collect,
      [],
    )
    .option("--where <clause>", "SQL filter applied to every copied table")
    .option(
      "--conflict <mode>",
      "on primary-key conflict: error | ignore | replace",
      parseConflict,
      "error",
    )
    .option(
      "--statement-size <bytes>",
      "max bytes per generated INSERT (D1 hard limit is 100KB)",
      parseSizeOption("statement-size"),
    )
    .option("--page-size <rows>", "rows read per request", parseIntOption("page-size"))
    .option(
      "--file-size <bytes>",
      "target size of each import payload",
      parseSizeOption("file-size"),
    )
    .option("--create-schema", "create the source schema on the target before copying")
    .option("--truncate", "delete all rows from each target table before copying into it")
    .option("--no-defer-foreign-keys", "do not emit PRAGMA defer_foreign_keys")
    .option("--no-resume", "ignore any existing checkpoint and start over")
    .option("--dry-run", "report what would be copied without writing")
    .action(
      async (
        source: string,
        target: string,
        options: Record<string, unknown>,
        command: Command,
      ) => {
        const context = buildContext(command);
        const started = Date.now();

        const [sourceRef, targetRef] = await Promise.all([
          resolve(context, source),
          resolve(context, target),
        ]);

        if (sourceRef.databaseId === targetRef.databaseId) {
          throw new CliError("Source and target are the same database.", {
            hint: "Copying a database onto itself would duplicate or overwrite its own rows.",
          });
        }

        const transferOptions = transferOptionsFrom(options);
        const { logger } = context;

        logger.step(`Copy ${label(sourceRef)} → ${label(targetRef)}`);
        if (transferOptions.dryRun) logger.warn("Dry run: no data will be written.");

        const schema = await introspect(context.client, sourceRef.databaseId);
        if (schema.virtualTables.length > 0) {
          logger.warn(
            `Skipping ${schema.virtualTables.length} virtual (FTS5) table(s): ` +
              `${schema.virtualTables.map((v) => v.name).join(", ")}. Rebuild them on the target.`,
          );
        }

        const engine = new TransferEngine(
          { client: context.client, ref: sourceRef },
          { client: context.client, ref: targetRef },
          transferOptions,
          logger,
        );

        const selected = engine.selectTables(schema.tables);
        if (selected.length === 0) {
          throw new CliError("No tables matched the given filters.", {
            hint: `Source tables: ${schema.tables.map((t) => t.name).join(", ") || "(none)"}`,
          });
        }

        // Copy parents before children so foreign keys resolve as we go.
        const { order, cyclic } = topologicalOrder(selected);
        const byName = new Map(selected.map((t) => [t.name, t]));
        const ordered = order
          .map((name) => byName.get(name))
          .filter((t): t is TableInfo => t !== undefined);

        if (cyclic.length > 0 && !transferOptions.deferForeignKeys) {
          logger.warn(
            `Foreign-key cycle among ${cyclic.join(", ")} but --no-defer-foreign-keys was given; ` +
              "inserts may fail.",
          );
        }

        if (options.createSchema && !transferOptions.dryRun) {
          await createSchema(
            context,
            targetRef.databaseId,
            schema,
            ordered,
            transferOptions.include.length > 0 || transferOptions.exclude.length > 0,
          );
          logger.success("Schema created on target.");
        }

        if (options.truncate && !transferOptions.dryRun) {
          const deletes = ordered
            .toReversed() // Children before parents, so FKs stay satisfied.
            .map((t) => `DELETE FROM "${t.name.replace(/"/g, '""')}";`)
            .join("\n");
          await context.client.import(
            targetRef.databaseId,
            `PRAGMA defer_foreign_keys = true;\n${deletes}`,
          );
          logger.success(`Truncated ${ordered.length} target tables.`);
        }

        const checkpoints = await openCheckpoints(
          context,
          sourceRef,
          targetRef,
          ordered,
          transferOptions,
          options.resume !== false && !transferOptions.dryRun,
        );

        logger.info(
          `${formatCount(ordered.length)} tables to copy: ${ordered.map((t) => t.name).join(", ")}`,
        );

        let totalRows = 0;
        let totalBytes = 0;

        for (const table of ordered) {
          if (checkpoints?.checkpointFor(table.name)?.status === "done") {
            logger.info(`${table.name}: already complete, skipping.`);
            continue;
          }

          try {
            const result = await engine.copyTable(table, checkpoints ?? undefined);
            totalRows += result.rowsCopied;
            totalBytes += result.bytesSent;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.clearStatus();

            // Recording the failure must never mask the failure itself.
            let saved = Boolean(checkpoints);
            try {
              await checkpoints?.fail(table.name, message);
            } catch (checkpointError) {
              saved = false;
              logger.warn(
                "Could not write the checkpoint: " +
                  (checkpointError instanceof Error
                    ? checkpointError.message
                    : String(checkpointError)),
              );
            }

            throw new CliError(`Copy failed on table "${table.name}": ${message}`, {
              hint: saved
                ? "Progress was saved. Re-run the same command to resume from where it stopped."
                : "Progress was not saved, so a re-run starts this table over.",
              cause: error,
            });
          }
        }

        logger.step("Summary");
        logger.success(
          `${formatCount(totalRows)} rows across ${ordered.length} tables in ` +
            `${formatDuration(Date.now() - started)} (${formatBytes(totalBytes)} uploaded).`,
        );

        if (!transferOptions.dryRun) {
          logger.info(`Verify with:  d1-ferry verify ${source} ${target}`);
        }
      },
    );
}

/** Create the source schema on the target, tolerating pre-existing objects. */
async function createSchema(
  context: ReturnType<typeof buildContext>,
  targetDatabaseId: string,
  schema: Awaited<ReturnType<typeof introspect>>,
  ordered: TableInfo[],
  filtered: boolean,
): Promise<void> {
  const statements: string[] = [];

  for (const table of ordered) {
    if (table.ddl) statements.push(addIfNotExists(table.ddl));
  }
  // Only objects belonging to the copied tables: creating an index for a table that
  // was filtered out fails with "no such table".
  const objects = schemaObjectsFor(
    schema,
    ordered.map((t) => t.name),
    { filtered },
  );
  for (const object of objects) {
    statements.push(addIfNotExists(object.ddl));
  }

  if (statements.length === 0) return;

  await context.client.import(targetDatabaseId, statements.map((s) => `${s};`).join("\n"), {
    onPoll: (status) => context.logger.status(`schema import ${status}`),
  });
  context.logger.clearStatus();
}

function addIfNotExists(ddl: string): string {
  return ddl.replace(
    /^\s*CREATE\s+((?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER))\s+(?!IF\s+NOT\s+EXISTS)/i,
    (_m, kind: string) => `CREATE ${kind} IF NOT EXISTS `,
  );
}

/** Load or create the checkpoint manifest for this source/target pair. */
async function openCheckpoints(
  context: ReturnType<typeof buildContext>,
  sourceRef: { accountId: string; databaseId: string; name?: string },
  targetRef: { accountId: string; databaseId: string; name?: string },
  tables: TableInfo[],
  options: ReturnType<typeof transferOptionsFrom>,
  enabled: boolean,
): Promise<CheckpointStore | null> {
  if (!enabled) return null;

  const jobId = deriveJobId(sourceRef.databaseId, targetRef.databaseId);
  const path = CheckpointStore.pathFor(jobId);

  const existing = await CheckpointStore.load(path);
  if (existing) {
    const pending = existing.pendingTables();
    context.logger.info(
      `Resuming job ${jobId}: ${formatCount(existing.totalRows())} rows already copied, ` +
        `${pending.length} table(s) remaining.`,
    );
    return existing;
  }

  return CheckpointStore.create(path, {
    jobId,
    startedAt: new Date().toISOString(),
    source: sourceRef,
    target: targetRef,
    options: {
      conflict: options.conflict,
      statementBytes: options.statementBytes,
      pageSize: options.pageSize,
      fileBytes: options.fileBytes,
    },
    tables: tables.map((t) => ({
      table: t.name,
      rowsCopied: 0,
      cursor: null,
      status: "pending" as const,
    })),
  });
}

/** Commander collector for repeatable, comma-separated options. */
function collect(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

function parseConflict(value: string): string {
  if (value !== "error" && value !== "ignore" && value !== "replace") {
    throw new CliError(`--conflict must be error, ignore, or replace (got "${value}").`);
  }
  return value;
}
