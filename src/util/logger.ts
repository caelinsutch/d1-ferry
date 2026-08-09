import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A prominent section heading. */
  step(message: string): void;
  /** A single-line status update, overwritten in place on a TTY. */
  status(message: string): void;
  /** Clear an in-place status line. */
  clearStatus(): void;
  success(message: string): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Emit newline-delimited JSON instead of human-readable text. */
  json: boolean;
  color: boolean;
}

/** Choose a log level from the global verbosity flags. */
export function resolveLogLevel(options: { verbose?: unknown; quiet?: unknown }): LogLevel {
  if (options.verbose) return "debug";
  if (options.quiet) return "warn";
  return "info";
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, json, color } = options;
  const threshold = ORDER[level];
  const isTty = process.stderr.isTTY === true;
  let statusActive = false;

  const paint = {
    dim: (s: string) => (color ? pc.dim(s) : s),
    bold: (s: string) => (color ? pc.bold(s) : s),
    red: (s: string) => (color ? pc.red(s) : s),
    yellow: (s: string) => (color ? pc.yellow(s) : s),
    green: (s: string) => (color ? pc.green(s) : s),
    cyan: (s: string) => (color ? pc.cyan(s) : s),
  };

  function clearStatus(): void {
    if (statusActive && isTty) {
      process.stderr.write("\r\u001b[2K");
      statusActive = false;
    }
  }

  function emit(
    lvl: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
    prefix: string,
  ): void {
    if (ORDER[lvl] < threshold) return;
    clearStatus();

    if (json) {
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: lvl, message, ...fields })}\n`,
      );
      return;
    }

    const suffix =
      fields && Object.keys(fields).length > 0 ? ` ${paint.dim(formatFields(fields))}` : "";
    process.stderr.write(`${prefix}${message}${suffix}\n`);
  }

  return {
    debug: (m, f) => emit("debug", m, f, paint.dim("· ")),
    info: (m, f) => emit("info", m, f, "  "),
    warn: (m, f) => emit("warn", m, f, paint.yellow("! ")),
    error: (m, f) => emit("error", m, f, paint.red("✗ ")),

    step(message) {
      if (ORDER.info < threshold) return;
      clearStatus();
      if (json) {
        process.stderr.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "step", message })}\n`,
        );
        return;
      }
      process.stderr.write(`\n${paint.bold(paint.cyan("▸"))} ${paint.bold(message)}\n`);
    },

    status(message) {
      if (json || !isTty || ORDER.info < threshold) return;
      process.stderr.write(`\r\u001b[2K  ${paint.dim(message)}`);
      statusActive = true;
    },

    clearStatus,

    success(message) {
      if (ORDER.info < threshold) return;
      clearStatus();
      if (json) {
        process.stderr.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "success", message })}\n`,
        );
        return;
      }
      process.stderr.write(`${paint.green("✓")} ${message}\n`);
    },
  };
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
}

/** Format a byte count for human display. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

/** Format a count with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format a millisecond duration compactly. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m${rest}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
