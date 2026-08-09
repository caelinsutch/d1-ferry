#!/usr/bin/env bun
/**
 * Executable entry point.
 *
 * The package ships TypeScript and runs it directly under Bun rather than shipping a
 * compiled `dist/`, so a global install works straight from the published tarball with
 * no build step. `bun run build` still produces a standalone binary for releases.
 */
import { run } from "../src/cli.ts";

await run(process.argv);
