import { ConfigError } from "../util/errors.ts";
import type { D1Client } from "./client.ts";
import type { DatabaseRef } from "./types.ts";

/** Global options every command inherits from the root program. */
export interface GlobalOptions {
  accountId?: string;
  apiToken?: string;
}

export interface ResolvedAuth {
  accountId: string;
  apiToken: string;
}

/**
 * Resolve credentials from flags, then environment. Wrangler's own variable names
 * are honoured so that anyone who can already run `wrangler d1` can run this tool
 * with no extra setup.
 */
export function resolveAuth(options: GlobalOptions): ResolvedAuth {
  const accountId =
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;

  if (!accountId) {
    throw new ConfigError(
      "No Cloudflare account ID.",
      "Pass --account-id or set CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  if (!apiToken) {
    throw new ConfigError(
      "No Cloudflare API token.",
      "Pass --api-token or set CLOUDFLARE_API_TOKEN. The token needs account-level D1:Edit.",
    );
  }

  return { accountId, apiToken };
}

/** A UUID, which is how D1 database IDs are formatted. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a user-supplied database reference, which may be either a UUID or a
 * database name, into a concrete {@link DatabaseRef}.
 *
 * Accepting names costs one extra API call but removes the most common source of
 * friction: nobody remembers which UUID is staging and which is production.
 */
export async function resolveDatabase(
  client: D1Client,
  accountId: string,
  reference: string,
): Promise<DatabaseRef> {
  if (UUID.test(reference)) {
    return { accountId, databaseId: reference };
  }

  const databases = await client.listDatabases();
  const matches = databases.filter((db) => db.name === reference);

  if (matches.length === 1) {
    const match = matches[0] as { uuid: string; name: string };
    return { accountId, databaseId: match.uuid, name: match.name };
  }
  if (matches.length > 1) {
    throw new ConfigError(
      `Database name "${reference}" is ambiguous (${matches.length} matches).`,
      `Use one of these IDs: ${matches.map((m) => m.uuid).join(", ")}`,
    );
  }

  const available = databases.map((d) => d.name).toSorted((a, b) => a.localeCompare(b));
  const suggestion = closestMatch(reference, available);

  throw new ConfigError(
    `No D1 database named "${reference}" in account ${accountId}.`,
    hintFor(suggestion, available),
  );
}

/** Build the most useful hint we can for an unresolved database name. */
function hintFor(suggestion: string | undefined, available: string[]): string {
  if (suggestion) return `Did you mean "${suggestion}"?`;
  if (available.length === 0) return "This account has no D1 databases.";
  const shown = available.slice(0, 10).join(", ");
  return `Available: ${shown}${available.length > 10 ? ", …" : ""}`;
}

/** Find the closest candidate by edit distance, for typo suggestions. */
function closestMatch(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Only suggest when the guess is plausibly a typo rather than a different word.
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }

  return previous[b.length] as number;
}
