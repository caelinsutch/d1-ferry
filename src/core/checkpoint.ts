import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { KeysetCursor } from "./reader.ts";

const MANIFEST_VERSION = 1;

/** Per-table progress within a transfer job. */
export interface TableCheckpoint {
  table: string;
  /** Rows successfully committed to the target. */
  rowsCopied: number;
  /** Cursor of the last committed row, for resumption. */
  cursor: KeysetCursor | null;
  status: "pending" | "in-progress" | "done" | "failed";
  error?: string;
}

/** Durable record of a transfer job, written after every committed batch. */
export interface Manifest {
  version: number;
  jobId: string;
  startedAt: string;
  updatedAt: string;
  source: { accountId: string; databaseId: string; name?: string };
  target: { accountId: string; databaseId: string; name?: string };
  options: {
    conflict: string;
    statementBytes: number;
    pageSize: number;
    fileBytes: number;
  };
  tables: TableCheckpoint[];
}

/**
 * Tracks and persists transfer progress so an interrupted job can resume.
 *
 * A checkpoint is only advanced *after* the target confirms a batch, so resuming
 * can duplicate at most nothing and re-send at most one in-flight batch. Combined
 * with `INSERT OR REPLACE`/`OR IGNORE`, that makes resumption idempotent; with
 * plain `INSERT` a resumed job can legitimately hit a primary-key conflict on the
 * replayed batch, which is why `--conflict` defaults to `replace` for resumes.
 */
export class CheckpointStore {
  private constructor(
    private readonly path: string,
    private manifest: Manifest,
  ) {}

  /** Directory where manifests live, relative to the working directory. */
  static defaultDir(): string {
    return join(process.cwd(), ".d1x");
  }

  static pathFor(jobId: string, dir = CheckpointStore.defaultDir()): string {
    return join(dir, `${jobId}.json`);
  }

  /** Start a new job, overwriting any manifest with the same id. */
  static async create(
    path: string,
    manifest: Omit<Manifest, "version" | "updatedAt">,
  ): Promise<CheckpointStore> {
    const store = new CheckpointStore(path, {
      ...manifest,
      version: MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
    });
    await store.save();
    return store;
  }

  /** Load an existing job, or return null when there is nothing to resume. */
  static async load(path: string): Promise<CheckpointStore | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    let manifest: Manifest;
    try {
      manifest = JSON.parse(raw) as Manifest;
    } catch (error) {
      throw new Error(
        `Checkpoint at ${path} is corrupt and could not be parsed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Delete the file to start the transfer from scratch.",
        { cause: error },
      );
    }

    if (manifest?.version !== MANIFEST_VERSION) {
      throw new Error(
        `Checkpoint at ${path} was written by an incompatible version ` +
          `(found ${manifest?.version ?? "none"}, expected ${MANIFEST_VERSION}). ` +
          "Delete it to start fresh.",
      );
    }

    return new CheckpointStore(path, manifest);
  }

  get data(): Readonly<Manifest> {
    return this.manifest;
  }

  get jobId(): string {
    return this.manifest.jobId;
  }

  /** Tables that still need work, in manifest order. */
  pendingTables(): TableCheckpoint[] {
    return this.manifest.tables.filter((t) => t.status !== "done");
  }

  checkpointFor(table: string): TableCheckpoint | undefined {
    return this.manifest.tables.find((t) => t.table === table);
  }

  /** Record committed progress for a table and persist it. */
  async advance(table: string, rowsCopied: number, cursor: KeysetCursor | null): Promise<void> {
    const entry = this.require(table);
    entry.rowsCopied = rowsCopied;
    entry.cursor = cursor;
    entry.status = "in-progress";
    await this.save();
  }

  async complete(table: string, rowsCopied: number): Promise<void> {
    const entry = this.require(table);
    entry.rowsCopied = rowsCopied;
    entry.status = "done";
    entry.cursor = null;
    delete entry.error;
    await this.save();
  }

  async fail(table: string, error: string): Promise<void> {
    const entry = this.require(table);
    entry.status = "failed";
    entry.error = error;
    await this.save();
  }

  /** Total rows committed across all tables. */
  totalRows(): number {
    return this.manifest.tables.reduce((sum, t) => sum + t.rowsCopied, 0);
  }

  private require(table: string): TableCheckpoint {
    const entry = this.manifest.tables.find((t) => t.table === table);
    if (!entry) throw new Error(`No checkpoint entry for table "${table}".`);
    return entry;
  }

  /**
   * Persist atomically: write a temp file then rename, so a crash mid-write cannot
   * leave a truncated manifest that would make the job unresumable.
   */
  private async save(): Promise<void> {
    this.manifest.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });

    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}

/** Deterministic job id for a source/target pair, so reruns resume by default. */
export function deriveJobId(sourceDatabaseId: string, targetDatabaseId: string): string {
  return `${sourceDatabaseId.slice(0, 8)}-to-${targetDatabaseId.slice(0, 8)}`;
}
