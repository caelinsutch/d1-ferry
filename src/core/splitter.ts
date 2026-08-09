/**
 * Splits a SQL script into individual statements.
 *
 * Naively splitting on `;` corrupts any dump containing semicolons inside string
 * literals, comments, or `CREATE TRIGGER ... BEGIN ... END` blocks. Since this tool
 * exists to chunk large scripts to fit D1's 100 KB per-statement limit, getting the
 * boundaries wrong would silently truncate data, so the scan is explicit about every
 * lexical state SQLite recognises.
 */
export function* splitStatements(sql: string): Generator<string> {
  let start = 0;
  let index = 0;
  /** Nesting depth of BEGIN...END blocks, which contain their own semicolons. */
  let blockDepth = 0;

  const length = sql.length;

  while (index < length) {
    const char = sql[index] as string;

    // --- line comment
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? length : newline + 1;
      continue;
    }

    // /* block comment */
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }

    // 'text literal', with '' as the escape
    if (char === "'") {
      index = skipQuoted(sql, index, "'");
      continue;
    }

    // "quoted identifier" and `backtick` / [bracket] identifiers
    if (char === '"') {
      index = skipQuoted(sql, index, '"');
      continue;
    }
    if (char === "`") {
      index = skipQuoted(sql, index, "`");
      continue;
    }
    if (char === "[") {
      const end = sql.indexOf("]", index + 1);
      index = end === -1 ? length : end + 1;
      continue;
    }

    // X'...' blob literal
    if ((char === "x" || char === "X") && sql[index + 1] === "'") {
      index = skipQuoted(sql, index + 1, "'");
      continue;
    }

    if (isWordBoundary(sql, index)) {
      if (matchesKeyword(sql, index, "BEGIN")) {
        // Only a trigger body's BEGIN opens a block. `BEGIN TRANSACTION`, which is
        // the first line of every `sqlite3 .dump`, is plain transaction control --
        // treating it as a block would swallow the entire dump into one statement.
        if (isTriggerBodyBegin(sql, start, index)) blockDepth++;
        index += 5;
        continue;
      }
      if (matchesKeyword(sql, index, "CASE")) {
        blockDepth++;
        index += 4;
        continue;
      }
      if (matchesKeyword(sql, index, "END")) {
        if (blockDepth > 0) blockDepth--;
        index += 3;
        continue;
      }
    }

    if (char === ";" && blockDepth === 0) {
      const statement = sql.slice(start, index).trim();
      if (statement.length > 0) yield statement;
      start = index + 1;
    }

    index++;
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) yield tail;
}

/**
 * Whether the `BEGIN` at `beginIndex` opens a trigger body rather than a transaction.
 *
 * Decided by looking back at the statement so far: only `CREATE TRIGGER` introduces a
 * compound `BEGIN ... END` body containing its own semicolons.
 */
function isTriggerBodyBegin(sql: string, statementStart: number, beginIndex: number): boolean {
  const preceding = sql.slice(statementStart, beginIndex);
  return /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/iu.test(preceding);
}

/** Advance past a quoted run, honouring doubled-quote escapes. */
function skipQuoted(sql: string, openIndex: number, quote: string): number {
  let index = openIndex + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2; // Escaped quote.
        continue;
      }
      return index + 1;
    }
    index++;
  }
  return sql.length; // Unterminated; consume the remainder.
}

/** True when the position starts a new word (not mid-identifier). */
function isWordBoundary(sql: string, index: number): boolean {
  const previous = index === 0 ? "" : (sql[index - 1] as string);
  return previous === "" || !/[A-Za-z0-9_]/.test(previous);
}

/** Case-insensitive keyword match that must end on a word boundary. */
function matchesKeyword(sql: string, index: number, keyword: string): boolean {
  if (sql.length - index < keyword.length) return false;
  const slice = sql.slice(index, index + keyword.length);
  if (slice.toUpperCase() !== keyword) return false;
  const next = sql[index + keyword.length];
  return next === undefined || !/[A-Za-z0-9_]/.test(next);
}

/** Statements that must be stripped from a dump before sending it to D1. */
const UNSUPPORTED = [
  /^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?\s*$/i,
  /^COMMIT(\s+TRANSACTION)?\s*$/i,
  /^END(\s+TRANSACTION)?\s*$/i,
  /^ROLLBACK/i,
  /^PRAGMA\s+foreign_keys/i,
  /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["`[]?_cf_KV/i,
  /^INSERT\s+INTO\s+["`[]?_cf_KV/i,
];

/**
 * Whether a statement must be dropped before import.
 *
 * D1 runs in auto-commit and rejects explicit transaction control with
 * "cannot start a transaction within a transaction"; `_cf_KV` is D1's reserved
 * internal table. Both appear in `sqlite3 .dump` output, which is exactly the
 * input people bring to this tool.
 */
export function isUnsupportedStatement(statement: string): boolean {
  const normalized = statement.trim().replace(/;$/, "");
  return UNSUPPORTED.some((pattern) => pattern.test(normalized));
}
