import type { Command } from "commander";

import { D1_LIMITS } from "../core/limits.ts";
import { isUnsupportedStatement, splitStatements } from "../core/splitter.ts";
import { byteLength } from "../core/sql.ts";
import { CliError } from "../util/errors.ts";
import { buildContext, label, parseSizeOption, resolve } from "../util/context.ts";
import { formatBytes, formatCount, formatDuration } from "../util/logger.ts";

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("import a .sql file into a D1 database, chunked to respect statement limits")
    .argument("<database>", "database name or UUID")
    .argument("<file>", "path to a .sql file")
    .option(
      "--file-size <bytes>",
      "target size of each import payload",
      parseSizeOption("file-size"),
    )
    .option("--defer-foreign-keys", "prepend PRAGMA defer_foreign_keys to every payload", true)
    .option("--no-defer-foreign-keys", "do not emit PRAGMA defer_foreign_keys")
    .option(
      "--keep-transactions",
      "do not strip BEGIN/COMMIT (D1 rejects them; for debugging only)",
    )
    .option("--dry-run", "validate and report without writing")
    .action(
      async (
        database: string,
        file: string,
        options: Record<string, unknown>,
        command: Command,
      ) => {
        const context = buildContext(command);
        const { logger } = context;
        const started = Date.now();

        const handle = Bun.file(file);
        if (!(await handle.exists())) {
          throw new CliError(`File not found: ${file}`);
        }

        const ref = await resolve(context, database);
        logger.step(`Import ${file} → ${label(ref)}`);

        const totalBytes = handle.size;
        logger.info(`Source file is ${formatBytes(totalBytes)}.`);

        // Read as text: SQL dumps are text, and Bun handles multi-GB strings well
        // enough that streaming the tokenizer is not worth the complexity here.
        const sql = await handle.text();

        const payloadBudget = Number(options.fileSize ?? 24 * 1024 * 1024);
        const deferForeignKeys = options.deferForeignKeys !== false;
        const dryRun = Boolean(options.dryRun);

        let batch: string[] = [];
        let batchBytes = 0;
        let statementCount = 0;
        let skipped = 0;
        let payloads = 0;
        let sentBytes = 0;
        let oversized = 0;

        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;

          const parts = deferForeignKeys ? ["PRAGMA defer_foreign_keys = true;", ...batch] : batch;
          const payload = parts.join("\n");

          if (!dryRun) {
            await context.client.import(ref.databaseId, payload, {
              onPoll: (status) => logger.status(`payload ${payloads + 1}: ${status}`),
            });
          }

          payloads++;
          sentBytes += byteLength(payload);
          batch = [];
          batchBytes = 0;

          logger.status(
            `${formatCount(statementCount)} statements, ${formatCount(payloads)} payloads, ` +
              `${formatBytes(sentBytes)} sent`,
          );
        };

        for (const statement of splitStatements(sql)) {
          if (!options.keepTransactions && isUnsupportedStatement(statement)) {
            skipped++;
            continue;
          }

          const withTerminator = `${statement};`;
          const bytes = byteLength(withTerminator);

          // A single statement over D1's hard limit cannot be split safely here:
          // splitting an INSERT's VALUES list would require parsing it, and
          // splitting anything else would change its meaning.
          if (bytes > D1_LIMITS.maxStatementBytes) {
            oversized++;
            logger.error(
              `Statement ${statementCount + 1} is ${formatBytes(bytes)}, over D1's ` +
                `${formatBytes(D1_LIMITS.maxStatementBytes)} limit: ${statement.slice(0, 120)}…`,
            );
            throw new CliError(
              `Statement ${statementCount + 1} exceeds D1's 100KB statement limit.`,
              {
                hint:
                  "Regenerate the dump with smaller INSERT batches. `d1-ferry export` always produces " +
                  "compliant statements, as does `d1-ferry copy`.",
              },
            );
          }

          if (batchBytes + bytes > payloadBudget) await flush();

          batch.push(withTerminator);
          batchBytes += bytes + 1;
          statementCount++;
        }

        await flush();
        logger.clearStatus();

        logger.step("Summary");
        if (dryRun) {
          logger.success(
            `Validated ${formatCount(statementCount)} statements in ${formatCount(payloads)} payloads ` +
              `(${formatBytes(sentBytes)}). Nothing was written.`,
          );
        } else {
          logger.success(
            `Imported ${formatCount(statementCount)} statements in ${formatCount(payloads)} payloads ` +
              `(${formatBytes(sentBytes)}) in ${formatDuration(Date.now() - started)}.`,
          );
        }

        if (skipped > 0) {
          logger.info(
            `Skipped ${formatCount(skipped)} unsupported statement(s) ` +
              "(transaction control, _cf_KV, PRAGMA foreign_keys).",
          );
        }
        if (oversized > 0) logger.warn(`${oversized} statement(s) were too long.`);
      },
    );
}
