import type { Command } from "commander";

import { introspect, topologicalOrder } from "../core/schema.ts";
import { buildContext, label, resolve } from "../util/context.ts";
import { formatCount } from "../util/logger.ts";
import { printTable } from "./list.ts";

export function registerSchema(program: Command): void {
  const schema = program.command("schema").description("inspect or copy database schema");

  schema
    .command("show")
    .description("print the schema of a D1 database")
    .argument("<database>", "database name or UUID")
    .option("--ddl", "print full CREATE statements instead of a summary")
    .action(async (database: string, options: { ddl?: boolean }, command: Command) => {
      const context = buildContext(command.parent?.parent ?? command);
      const ref = await resolve(context, database);

      context.logger.step(`Schema of ${label(ref)}`);
      const result = await introspect(context.client, ref.databaseId);

      if (options.ddl) {
        for (const table of result.tables) {
          if (table.ddl) process.stdout.write(`${table.ddl};\n`);
        }
        for (const object of [...result.indexes, ...result.views, ...result.triggers]) {
          process.stdout.write(`${object.ddl};\n`);
        }
        return;
      }

      const { order, cyclic } = topologicalOrder(result.tables);
      const byName = new Map(result.tables.map((t) => [t.name, t]));

      printTable(
        ["table", "cols", "pk", "fks", "flags"],
        order.map((name) => {
          const table = byName.get(name);
          if (!table) return [name, "?", "?", "?", ""];
          const pk = table.columns.filter((c) => c.pkPosition > 0).map((c) => c.name);
          const flags = [
            table.withoutRowid ? "WITHOUT ROWID" : "",
            table.strict ? "STRICT" : "",
            cyclic.includes(name) ? "FK CYCLE" : "",
          ].filter(Boolean);

          return [
            name,
            String(table.columns.length),
            pk.length > 0 ? pk.join(",") : "(rowid)",
            String(table.foreignKeys.length),
            flags.join(" "),
          ];
        }),
      );

      context.logger.info(
        `${formatCount(result.tables.length)} tables, ${formatCount(result.indexes.length)} indexes, ` +
          `${formatCount(result.views.length)} views, ${formatCount(result.triggers.length)} triggers.`,
      );

      if (result.virtualTables.length > 0) {
        context.logger.warn(
          `${result.virtualTables.length} virtual (FTS5) table(s): ` +
            `${result.virtualTables.map((v) => v.name).join(", ")}. ` +
            "These cannot be copied directly and must be rebuilt on the target.",
        );
      }
      if (cyclic.length > 0) {
        context.logger.warn(
          `Foreign-key cycle involving: ${cyclic.join(", ")}. ` +
            "Copy will use PRAGMA defer_foreign_keys.",
        );
      }
    });

  schema
    .command("copy")
    .description("recreate the source schema (tables, indexes, views, triggers) on the target")
    .argument("<source>", "source database name or UUID")
    .argument("<target>", "target database name or UUID")
    .option("--dry-run", "print the DDL without executing it")
    .option("--if-not-exists", "tolerate objects that already exist on the target")
    .action(
      async (
        source: string,
        target: string,
        options: { dryRun?: boolean; ifNotExists?: boolean },
        command: Command,
      ) => {
        const context = buildContext(command.parent?.parent ?? command);
        const [sourceRef, targetRef] = await Promise.all([
          resolve(context, source),
          resolve(context, target),
        ]);

        context.logger.step(`Copying schema ${label(sourceRef)} → ${label(targetRef)}`);
        const result = await introspect(context.client, sourceRef.databaseId);
        const { order } = topologicalOrder(result.tables);
        const byName = new Map(result.tables.map((t) => [t.name, t]));

        const statements: string[] = [];
        for (const name of order) {
          const ddl = byName.get(name)?.ddl;
          if (ddl) statements.push(applyIfNotExists(ddl, options.ifNotExists ?? false));
        }
        for (const object of [...result.indexes, ...result.views, ...result.triggers]) {
          statements.push(applyIfNotExists(object.ddl, options.ifNotExists ?? false));
        }

        if (statements.length === 0) {
          context.logger.warn("Source has no schema objects to copy.");
          return;
        }

        if (options.dryRun) {
          for (const statement of statements) process.stdout.write(`${statement};\n`);
          context.logger.info(`${statements.length} statements (dry run, nothing executed).`);
          return;
        }

        // Schema DDL is small, so a single import payload is always sufficient.
        await context.client.import(
          targetRef.databaseId,
          statements.map((s) => `${s};`).join("\n"),
          {
            onPoll: (status) => context.logger.status(`schema import ${status}`),
          },
        );

        context.logger.clearStatus();
        context.logger.success(
          `Created ${statements.length} schema objects on ${label(targetRef)}.`,
        );
      },
    );
}

/**
 * Insert `IF NOT EXISTS` into a `CREATE` statement.
 *
 * SQLite stores the original DDL text verbatim in `sqlite_master`, so the clause
 * has to be spliced in rather than toggled via an option.
 */
function applyIfNotExists(ddl: string, enabled: boolean): string {
  if (!enabled) return ddl;
  return ddl.replace(
    /^\s*CREATE\s+((?:UNIQUE\s+)?(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER))\s+(?!IF\s+NOT\s+EXISTS)/i,
    (_match, kind: string) => `CREATE ${kind} IF NOT EXISTS `,
  );
}
