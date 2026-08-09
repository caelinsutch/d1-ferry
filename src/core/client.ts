import { CF_API_BASE, DEFAULTS } from "./limits.ts";
import { D1ApiError } from "../util/errors.ts";
import type { SqlValue } from "./types.ts";

/** Shape of every Cloudflare REST API response. */
interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors: Array<{ code?: number; message: string }>;
  messages: Array<{ code?: number; message: string }>;
}

/** Result metadata D1 returns alongside every query. */
export interface D1Meta {
  duration?: number;
  rows_read?: number;
  rows_written?: number;
  changes?: number;
  last_row_id?: number;
  changed_db?: boolean;
  size_after?: number;
}

/** Column-oriented result from the `/raw` endpoint. */
export interface D1RawResult {
  columns: string[];
  rows: SqlValue[][];
  meta: D1Meta;
}

/** Row-oriented result from the `/query` endpoint. */
export interface D1QueryResult<T = Record<string, SqlValue>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1ClientOptions {
  accountId: string;
  apiToken: string;
  /** Max retry attempts for retryable failures. */
  maxRetries?: number;
  /** Called before each retry, for progress reporting. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  fetchImpl?: typeof fetch;
}

/** Progress callbacks for a long-running import. */
export interface ImportProgress {
  onPhase?: (phase: "init" | "upload" | "ingest" | "poll" | "done") => void;
  onPoll?: (status: string) => void;
}

/**
 * Response shape shared by the `init`, `ingest`, and `poll` import actions.
 *
 * The three actions return overlapping but not identical payloads, and `init` in
 * particular returns either an upload URL or an already-completed import, so a single
 * permissive shape is more honest than pretending each phase has a fixed schema.
 */
interface ImportPhaseResult {
  success?: boolean;
  filename?: string;
  upload_url?: string;
  at_bookmark?: string;
  status?: string;
  error?: string;
  messages?: string[];
  result?: { meta?: D1Meta; final_bookmark?: string; num_queries?: number };
  meta?: D1Meta;
}

/**
 * Client for the Cloudflare D1 REST API.
 *
 * Covers the three endpoints that matter for bulk transfer:
 * - `/raw`    - column-oriented reads (cheaper on the wire than `/query`)
 * - `/query`  - row-oriented reads and single statements
 * - `/import` - the four-phase R2-backed bulk ingest path, which is the only way
 *               to push large volumes without paying a round trip per statement
 */
export class D1Client {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly maxRetries: number;
  private readonly onRetry: D1ClientOptions["onRetry"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: D1ClientOptions) {
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.onRetry = options.onRetry;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  private dbUrl(databaseId: string, path: string): string {
    return `${CF_API_BASE}/accounts/${this.accountId}/d1/database/${databaseId}${path}`;
  }

  /** List the D1 databases in this account. */
  listDatabases(): Promise<Array<{ uuid: string; name: string; version?: string }>> {
    const url = `${CF_API_BASE}/accounts/${this.accountId}/d1/database?per_page=1000`;
    return this.request<Array<{ uuid: string; name: string; version?: string }>>(url, {
      method: "GET",
    });
  }

  /**
   * Execute a statement and get column-oriented results.
   *
   * Prefer this over {@link query} for reading table data: it omits the repeated
   * column names that `/query` includes on every row, which matters a great deal
   * when paging millions of rows.
   */
  async raw(databaseId: string, sql: string, params: SqlValue[] = []): Promise<D1RawResult> {
    const results = await this.request<
      Array<{
        results: { columns: string[]; rows: SqlValue[][] };
        meta: D1Meta;
      }>
    >(this.dbUrl(databaseId, "/raw"), {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    const first = results[0];
    if (!first) {
      throw new D1ApiError("D1 returned no result set for a /raw query.", {
        status: 200,
      });
    }

    return {
      columns: first.results.columns ?? [],
      rows: first.results.rows ?? [],
      meta: first.meta ?? {},
    };
  }

  /** Execute a statement and get row-oriented results. */
  async query<T = Record<string, SqlValue>>(
    databaseId: string,
    sql: string,
    params: SqlValue[] = [],
  ): Promise<D1QueryResult<T>> {
    const results = await this.request<Array<D1QueryResult<T>>>(this.dbUrl(databaseId, "/query"), {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    const first = results[0];
    if (!first) {
      throw new D1ApiError("D1 returned no result set for a /query request.", {
        status: 200,
      });
    }
    return first;
  }

  /**
   * Bulk-import a block of SQL text.
   *
   * This is the four-phase flow documented in Cloudflare's REST bulk-import guide:
   * init (declare an md5 etag) -> PUT the body to a presigned R2 URL -> ingest ->
   * poll to completion. The upload is chunked server-side, which is what makes it
   * viable for payloads far larger than a single statement could ever be.
   *
   * Each individual statement inside `sql` must still respect D1's 100 KB
   * statement limit; see {@link StatementPacker}.
   */
  async import(databaseId: string, sql: string, progress: ImportProgress = {}): Promise<D1Meta> {
    const url = this.dbUrl(databaseId, "/import");
    const etag = new Bun.CryptoHasher("md5").update(sql).digest("hex");

    progress.onPhase?.("init");
    const init = await this.request<ImportPhaseResult>(url, {
      method: "POST",
      body: JSON.stringify({ action: "init", etag }),
    });

    // D1 short-circuits when this exact payload has already been ingested: `init`
    // returns the finished import (status/at_bookmark) instead of an upload URL. That
    // makes re-running an identical import a no-op, which is what a resumable tool
    // replaying its last in-flight batch depends on.
    if (!init.upload_url) {
      if (init.error) {
        throw new D1ApiError(`Import init failed: ${init.error}`, { status: 200 });
      }
      if (init.at_bookmark || init.status === "complete") {
        progress.onPhase?.("done");
        return init.result?.meta ?? init.meta ?? {};
      }
      throw new D1ApiError("Import init returned neither an upload URL nor a completed import.", {
        status: 200,
        hint: "This is unexpected from the D1 API; retrying the copy is usually enough.",
      });
    }

    const uploadUrl = init.upload_url;

    progress.onPhase?.("upload");
    const uploaded = await this.withRetry("import upload", async () => {
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        body: sql,
      });
      if (!response.ok) {
        throw new D1ApiError(`Upload to R2 failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      }
      return response;
    });

    const returnedEtag = uploaded.headers.get("ETag")?.replace(/"/g, "");
    if (returnedEtag !== etag) {
      throw new D1ApiError(
        `Upload integrity check failed: expected ETag ${etag}, got ${returnedEtag ?? "none"}.`,
        {
          status: 200,
          hint: "The upload was corrupted in transit. Retrying is usually enough.",
        },
      );
    }

    progress.onPhase?.("ingest");
    const ingest = await this.request<ImportPhaseResult>(url, {
      method: "POST",
      body: JSON.stringify({ action: "ingest", etag, filename: init.filename }),
    });

    if (ingest.error) {
      throw new D1ApiError(`Import ingest failed: ${ingest.error}`, { status: 200 });
    }
    if (!ingest.at_bookmark) {
      return ingest.result?.meta ?? ingest.meta ?? {};
    }

    progress.onPhase?.("poll");
    const meta = await this.pollImport(url, ingest.at_bookmark, progress);
    progress.onPhase?.("done");
    return meta;
  }

  /** Poll an in-flight import until D1 reports it finished. */
  private async pollImport(
    url: string,
    bookmark: string,
    progress: ImportProgress,
  ): Promise<D1Meta> {
    const deadline = Date.now() + 30 * 60 * 1000;
    let delayMs = 500;

    while (Date.now() < deadline) {
      const status = await this.request<ImportPhaseResult>(url, {
        method: "POST",
        body: JSON.stringify({ action: "poll", current_bookmark: bookmark }),
      });

      if (status.status) progress.onPoll?.(status.status);

      if (status.error) {
        throw new D1ApiError(`Import failed during ingest: ${status.error}`, {
          status: 200,
        });
      }
      if (status.success === true && status.status !== "active") {
        return status.result?.meta ?? status.meta ?? {};
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 1.5, 5_000);
    }

    throw new D1ApiError("Import did not complete within 30 minutes.", {
      status: 408,
      hint: "Reduce --file-size so each import job is smaller.",
    });
  }

  /** Issue a request against the Cloudflare API and unwrap its envelope. */
  private request<T>(url: string, init: RequestInit): Promise<T> {
    return this.withRetry(`${init.method ?? "GET"} ${url}`, async () => {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: this.headers,
      });
      const text = await response.text();

      let envelope: CfEnvelope<T> | undefined;
      try {
        envelope = text ? (JSON.parse(text) as CfEnvelope<T>) : undefined;
      } catch {
        // Non-JSON body; fall through to the status-based error below.
      }

      if (!response.ok || !envelope?.success) {
        const errors = envelope?.errors ?? [];
        const detail =
          errors.map((e) => `${e.code ? `[${e.code}] ` : ""}${e.message}`).join("; ") ||
          text.slice(0, 400) ||
          response.statusText;

        const hint = hintForError(response.status, detail);
        throw new D1ApiError(`D1 API error (HTTP ${response.status}): ${detail}`, {
          status: response.status,
          errors,
          ...(hint !== undefined ? { hint } : {}),
        });
      }

      return envelope.result;
    });
  }

  /** Retry a fallible operation with exponential backoff and full jitter. */
  private async withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.maxRetries) break;

        const backoff = Math.min(
          DEFAULTS.baseRetryDelayMs * 2 ** attempt,
          DEFAULTS.maxRetryDelayMs,
        );
        // Full jitter: spreads a thundering herd of retries across the window.
        const delayMs = Math.round(Math.random() * backoff);

        this.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          reason: error instanceof Error ? error.message : String(error),
        });
        await sleep(delayMs);
      }
    }

    // Preserve the original failure, but guarantee an Error is what escapes.
    throw lastError instanceof Error
      ? lastError
      : new Error(`${label} failed: ${String(lastError)}`, { cause: lastError });
  }
}

/**
 * Whether an error is worth retrying. Covers HTTP 429/5xx, transient network
 * faults, and D1's `overloaded` error, which a single-threaded database returns
 * when its request queue fills up.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof D1ApiError) {
    return error.retryable || /overloaded|storage operation exceeded timeout/i.test(error.message);
  }
  if (error instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|terminated/i.test(
      error.message,
    );
  }
  return false;
}

/** Turn common D1 failures into actionable advice. */
function hintForError(status: number, detail: string): string | undefined {
  if (/statement too long/i.test(detail)) {
    return "Lower --statement-size so each generated INSERT stays under D1's 100 KB limit.";
  }
  if (/too many SQL variables|bound parameters/i.test(detail)) {
    return "D1 allows at most 100 bound parameters per query; this tool inlines literals instead.";
  }
  if (/overloaded/i.test(detail)) {
    return "A D1 database is single-threaded. Lower --concurrency.";
  }
  if (/cannot start a transaction within a transaction/i.test(detail)) {
    return "Remove BEGIN TRANSACTION/COMMIT from the SQL; D1 runs in auto-commit mode.";
  }
  if (/no such table/i.test(detail)) {
    return "Create the target schema first, or run with --create-schema.";
  }
  if (status === 401 || status === 403) {
    return "Check CLOUDFLARE_API_TOKEN has account-level D1:Edit permission.";
  }
  if (status === 404) {
    return "Check the account ID and database ID are correct.";
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
