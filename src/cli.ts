#!/usr/bin/env node
import { Command } from "commander";

import { registerCopy } from "./commands/copy.ts";
import { registerExport } from "./commands/export.ts";
import { registerImport } from "./commands/import.ts";
import { registerList } from "./commands/list.ts";
import { registerSchema } from "./commands/schema.ts";
import { registerVerify } from "./commands/verify.ts";
import { CliError } from "./util/errors.ts";
import { createLogger, type LogLevel } from "./util/logger.ts";

const VERSION = "0.1.0";

function buildProgram(): Command {
  const program = new Command();

  program
    .name("d1-ferry")
    .description(
      "Transfer large amounts of data between Cloudflare D1 databases without tripping over statement-size, batch, and duration limits.",
    )
    .version(VERSION)
    .option("--account-id <id>", "Cloudflare account ID (env: CLOUDFLARE_ACCOUNT_ID)")
    .option("--api-token <token>", "Cloudflare API token (env: CLOUDFLARE_API_TOKEN)")
    .option("-v, --verbose", "verbose output")
    .option("-q, --quiet", "only report warnings and errors")
    .option("--json", "emit machine-readable JSON logs")
    .option("--no-color", "disable colored output");

  program.hook("preSubcommand", (thisCommand) => {
    const opts = thisCommand.opts();
    const level: LogLevel = opts.verbose ? "debug" : opts.quiet ? "warn" : "info";
    thisCommand.setOptionValue(
      "logger",
      createLogger({
        level,
        json: Boolean(opts.json),
        color: opts.color !== false,
      }),
    );
  });

  registerCopy(program);
  registerExport(program);
  registerImport(program);
  registerVerify(program);
  registerSchema(program);
  registerList(program);

  program.showHelpAfterError("(add --help for usage)");

  return program;
}

/**
 * Parse and execute a command line.
 *
 * Exported rather than self-executing so the published `bin` shim owns the decision
 * to run, which keeps importing this module side-effect free.
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    // Commander throws for --help and --version; those are not failures.
    if (isCommanderExit(error)) {
      process.exitCode = (error as { exitCode?: number }).exitCode ?? 0;
      return;
    }

    if (error instanceof CliError) {
      process.stderr.write(`${error.format()}\n`);
      process.exitCode = error.exitCode;
      return;
    }

    process.stderr.write(
      `Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

/** Commander signals help/version output by throwing a CommanderError. */
function isCommanderExit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  );
}
