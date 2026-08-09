import type { Command } from "commander";

import { D1Client } from "../core/client.ts";
import { resolveAuth, resolveDatabase } from "../core/config.ts";
import type { DatabaseRef } from "../core/types.ts";
import { createLogger, type Logger } from "./logger.ts";

/** Shared per-invocation state: credentials, client, and logger. */
export interface Context {
  client: D1Client;
  accountId: string;
  logger: Logger;
}

/**
 * Build the request context from the root program's global options.
 *
 * Commander stores the logger on the root command in a `preSubcommand` hook; we
 * fall back to constructing one so that commands stay testable in isolation.
 */
export function buildContext(command: Command): Context {
  const root = command.parent ?? command;
  const globals = root.opts();

  const logger =
    (root.getOptionValue("logger") as Logger | undefined) ??
    createLogger({
      level: globals.verbose ? "debug" : globals.quiet ? "warn" : "info",
      json: Boolean(globals.json),
      color: globals.color !== false,
    });

  const { accountId, apiToken } = resolveAuth({
    accountId: globals.accountId,
    apiToken: globals.apiToken,
  });

  const client = new D1Client({
    accountId,
    apiToken,
    onRetry: ({ attempt, delayMs, reason }) =>
      logger.debug(`retry ${attempt} in ${delayMs}ms: ${reason}`),
  });

  return { client, accountId, logger };
}

/** Resolve a database reference (name or UUID) within a context. */
export function resolve(context: Context, reference: string): Promise<DatabaseRef> {
  return resolveDatabase(context.client, context.accountId, reference);
}

/** Human label for a database. */
export function label(ref: DatabaseRef): string {
  return ref.name ? `${ref.name} (${ref.databaseId.slice(0, 8)})` : ref.databaseId;
}

/** Parse an integer option, rejecting nonsense early with a clear message. */
export function parseIntOption(name: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer, got "${value}".`);
    }
    return parsed;
  };
}

/**
 * Parse a size option that accepts a plain byte count or a `KB`/`MB`/`GB` suffix,
 * because nobody wants to type 25165824.
 */
export function parseSizeOption(name: string): (value: string) => number {
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    k: 1024,
    mb: 1024 ** 2,
    m: 1024 ** 2,
    gb: 1024 ** 3,
    g: 1024 ** 3,
  };

  return (value: string): number => {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
    if (!match) throw new Error(`--${name} must be a size like "92000", "64KB", or "24MB".`);

    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const multiplier = unit === "" ? 1 : units[unit];

    if (multiplier === undefined) {
      throw new Error(`--${name} has an unknown unit "${unit}". Use B, KB, MB, or GB.`);
    }
    return Math.floor(amount * multiplier);
  };
}
