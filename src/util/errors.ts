/**
 * Typed CLI errors. Anything thrown as a CliError is rendered as a clean,
 * actionable message instead of a stack trace.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    if (options.hint !== undefined) this.hint = options.hint;
  }

  format(): string {
    const lines = [`error: ${this.message}`];
    if (this.hint) lines.push(`hint:  ${this.hint}`);
    return lines.join("\n");
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, hint !== undefined ? { exitCode: 2, hint } : { exitCode: 2 });
    this.name = "ConfigError";
  }
}

/** An error returned by the D1 HTTP API. */
export class D1ApiError extends CliError {
  readonly status: number;
  readonly errors: Array<{ code?: number; message: string }>;

  constructor(
    message: string,
    options: {
      status: number;
      errors?: Array<{ code?: number; message: string }>;
      hint?: string;
      cause?: unknown;
    },
  ) {
    super(message, {
      exitCode: 1,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "D1ApiError";
    this.status = options.status;
    this.errors = options.errors ?? [];
  }

  /** Whether retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}
