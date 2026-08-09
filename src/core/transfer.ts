import type { D1Client } from "./client.ts";
import type { CheckpointStore } from "./checkpoint.ts";
import { DEFAULTS } from "./limits.ts";
import { StatementPacker } from "./packer.ts";
import { countRows, TableReader, type KeysetCursor } from "./reader.ts";
import { byteLength } from "./sql.ts";
import type { ConflictStrategy, DatabaseRef, TableInfo } from "./types.ts";
import type { Logger } from "../util/logger.ts";
import { formatBytes, formatCount, formatDuration } from "../util/logger.ts";

export interface TransferOptions {
  conflict: ConflictStrategy;
  statementBytes: number;
  pageSize: number;
  /** Target size of each SQL payload sent to the import endpoint. */
  fileBytes: number;
  /** Only copy these tables, when non-empty. */
  include: string[];
  /** Never copy these tables. */
  exclude: string[];
  /** Optional `WHERE` filter applied to every table. */
  where?: string;
  /** Report what would happen without writing anything. */
  dryRun: boolean;
  /** Emit `PRAGMA defer_foreign_keys` so FK order does not matter. */
  deferForeignKeys: boolean;
}

export interface TableResult {
  table: string;
  rowsCopied: number;
  bytesSent: number;
  statements: number;
  durationMs: number;
}

/**
 * Copies table data from one D1 database to another.
 *
 * The write path deliberately uses the `/import` endpoint rather than `/query`:
 * import uploads one large SQL payload to R2 and lets D1 chunk it server-side, so a
 * million rows costs a handful of round trips instead of thousands. The read path
 * uses keyset pagination so it stays O(page) regardless of table size.
 */
export class TransferEngine {
  constructor(
    private readonly source: { client: D1Client; ref: DatabaseRef },
    private readonly target: { client: D1Client; ref: DatabaseRef },
    private readonly options: TransferOptions,
    private readonly logger: Logger,
  ) {}

  /** Copy a single table, resuming from its checkpoint when one exists. */
  async copyTable(table: TableInfo, checkpoints?: CheckpointStore): Promise<TableResult> {
    const started = Date.now();
    const checkpoint = checkpoints?.checkpointFor(table.name);
    const resumeCursor = checkpoint?.cursor ?? null;

    if (resumeCursor) {
      this.logger.info(
        `Resuming ${table.name} after ${formatCount(checkpoint?.rowsCopied ?? 0)} rows.`,
      );
    }

    const reader = new TableReader(this.source.client, this.source.ref.databaseId, table, {
      pageSize: this.options.pageSize,
      cursor: resumeCursor,
      ...(this.options.where !== undefined ? { where: this.options.where } : {}),
    });

    const packer = new StatementPacker({
      table: table.name,
      columns: table.columns,
      maxStatementBytes: this.options.statementBytes,
      conflict: this.options.conflict,
    });

    const result: TableResult = {
      table: table.name,
      rowsCopied: checkpoint?.rowsCopied ?? 0,
      bytesSent: 0,
      statements: 0,
      durationMs: 0,
    };

    // A batch is the unit we hand to the import endpoint, and also the unit of
    // checkpointing: we only advance the cursor once D1 confirms the write.
    let batch: string[] = [];
    let batchBytes = 0;
    let batchRows = 0;

    const flushBatch = async (cursor: KeysetCursor | null): Promise<void> => {
      if (batch.length === 0) return;

      const payload = this.buildPayload(batch);

      if (!this.options.dryRun) {
        await this.target.client.import(this.target.ref.databaseId, payload, {
          onPoll: (status) => this.logger.status(`${table.name}: import ${status}`),
        });
      }

      result.rowsCopied += batchRows;
      result.bytesSent += byteLength(payload);
      result.statements += batch.length;

      await checkpoints?.advance(table.name, result.rowsCopied, cursor);

      this.logger.status(
        `${table.name}: ${formatCount(result.rowsCopied)} rows, ${formatBytes(result.bytesSent)} sent`,
      );

      batch = [];
      batchBytes = 0;
      batchRows = 0;
    };

    for await (const page of reader.pages()) {
      for (const row of page.rows) {
        for (const statement of packer.push(row)) {
          batch.push(statement.sql);
          batchBytes += statement.bytes + 1;
          batchRows += statement.rowCount;
        }
      }

      // Flush on a page boundary so the persisted cursor always corresponds
      // exactly to the rows we have committed.
      if (batchBytes >= this.options.fileBytes) {
        const tail = packer.flush();
        if (tail) {
          batch.push(tail.sql);
          batchBytes += tail.bytes + 1;
          batchRows += tail.rowCount;
        }
        await flushBatch(reader.position);
      }
    }

    const tail = packer.flush();
    if (tail) {
      batch.push(tail.sql);
      batchRows += tail.rowCount;
    }
    await flushBatch(reader.position);

    await checkpoints?.complete(table.name, result.rowsCopied);
    result.durationMs = Date.now() - started;

    this.logger.clearStatus();
    this.logger.success(
      `${table.name}: ${formatCount(result.rowsCopied)} rows in ${formatDuration(result.durationMs)} ` +
        `(${formatBytes(result.bytesSent)}, ${formatCount(result.statements)} statements)`,
    );

    return result;
  }

  /**
   * Assemble one import payload.
   *
   * `PRAGMA defer_foreign_keys` must be repeated in every payload: Cloudflare
   * documents that D1 PRAGMA statements apply only to the current transaction, so
   * setting it once at the start of a job would silently stop applying.
   */
  private buildPayload(statements: string[]): string {
    const parts = this.options.deferForeignKeys
      ? ["PRAGMA defer_foreign_keys = true;", ...statements]
      : statements;
    return parts.join("\n");
  }

  /** Decide which tables to copy, honouring include/exclude filters. */
  selectTables(tables: TableInfo[]): TableInfo[] {
    const { include, exclude } = this.options;
    return tables.filter((t) => {
      if (exclude.includes(t.name)) return false;
      if (include.length > 0 && !include.includes(t.name)) return false;
      return true;
    });
  }

  /** Count rows on both sides so a copy can be verified. */
  async compareCounts(
    tables: string[],
  ): Promise<Array<{ table: string; source: number; target: number; match: boolean }>> {
    const rows: Array<{
      table: string;
      source: number;
      target: number;
      match: boolean;
    }> = [];

    for (const table of tables) {
      const [sourceCount, targetCount] = await Promise.all([
        countRows(this.source.client, this.source.ref.databaseId, table, this.options.where),
        countRows(this.target.client, this.target.ref.databaseId, table).catch(() => -1),
      ]);

      rows.push({
        table,
        source: sourceCount,
        target: targetCount,
        match: sourceCount === targetCount,
      });
    }

    return rows;
  }
}

/** Build a transfer options object from parsed CLI flags. */
export function transferOptionsFrom(flags: Record<string, unknown>): TransferOptions {
  return {
    conflict: (flags.conflict as ConflictStrategy) ?? "error",
    statementBytes: Number(flags.statementSize ?? DEFAULTS.statementBytes),
    pageSize: Number(flags.pageSize ?? DEFAULTS.readPageSize),
    fileBytes: Number(flags.fileSize ?? DEFAULTS.importFileBytes),
    include: toList(flags.table),
    exclude: toList(flags.excludeTable),
    ...(typeof flags.where === "string" ? { where: flags.where } : {}),
    dryRun: Boolean(flags.dryRun),
    deferForeignKeys: flags.deferForeignKeys !== false,
  };
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
