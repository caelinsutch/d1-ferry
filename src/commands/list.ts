import type { Command } from "commander";

import { buildContext } from "../util/context.ts";
import { printTable, writeJson } from "../util/output.ts";

export function registerList(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("list the D1 databases in the account")
    .action(async (_options: unknown, command: Command) => {
      const { client, logger, json } = buildContext(command);

      const databases = await client.listDatabases();
      const sorted = databases.toSorted((a, b) => a.name.localeCompare(b.name));

      if (json) {
        writeJson({
          databases: sorted.map((d) => ({
            name: d.name,
            uuid: d.uuid,
            ...(d.version !== undefined ? { version: d.version } : {}),
          })),
          count: sorted.length,
        });
        return;
      }

      if (sorted.length === 0) {
        logger.warn("This account has no D1 databases.");
        return;
      }

      printTable(
        ["name", "id"],
        sorted.map((d) => [d.name, d.uuid]),
      );
      logger.info(`${sorted.length} database${sorted.length === 1 ? "" : "s"}.`);
    });
}
