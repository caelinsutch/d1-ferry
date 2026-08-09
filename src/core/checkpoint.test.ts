import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointStore, deriveJobId, type Manifest } from "./checkpoint.ts";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "d1-ferry-checkpoint-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseManifest(tables: string[]): Omit<Manifest, "version" | "updatedAt"> {
  return {
    jobId: "job",
    startedAt: new Date().toISOString(),
    source: { accountId: "acct", databaseId: "source-db" },
    target: { accountId: "acct", databaseId: "target-db" },
    options: { conflict: "error", statementBytes: 92_000, pageSize: 1000, fileBytes: 1024 },
    tables: tables.map((table) => ({
      table,
      rowsCopied: 0,
      cursor: null,
      status: "pending" as const,
    })),
  };
}

describe("deriveJobId", () => {
  it("is stable for the same pair, so a re-run resumes", () => {
    const a = deriveJobId(
      "aaaaaaaa-1111-2222-3333-444444444444",
      "bbbbbbbb-1111-2222-3333-444444444444",
    );
    const b = deriveJobId(
      "aaaaaaaa-1111-2222-3333-444444444444",
      "bbbbbbbb-1111-2222-3333-444444444444",
    );

    expect(a).toBe(b);
    expect(a).toBe("aaaaaaaa-to-bbbbbbbb");
  });

  it("differs when the direction is reversed", () => {
    expect(deriveJobId("aaaaaaaa", "bbbbbbbb")).not.toBe(deriveJobId("bbbbbbbb", "aaaaaaaa"));
  });
});

describe("CheckpointStore", () => {
  it("returns null when there is nothing to resume", async () => {
    const dir = await tempDir();
    expect(await CheckpointStore.load(join(dir, "missing.json"))).toBeNull();
  });

  it("persists progress and reloads it", async () => {
    const dir = await tempDir();
    const path = join(dir, "job.json");

    const store = await CheckpointStore.create(path, baseManifest(["users", "orders"]));
    await store.advance("users", 500, { columns: ["id"], values: ["500"] });

    const reloaded = await CheckpointStore.load(path);
    const users = reloaded?.checkpointFor("users");

    expect(users?.rowsCopied).toBe(500);
    expect(users?.status).toBe("in-progress");
    expect(users?.cursor).toEqual({ columns: ["id"], values: ["500"] });
  });

  it("clears the cursor when a table completes", async () => {
    const dir = await tempDir();
    const store = await CheckpointStore.create(join(dir, "job.json"), baseManifest(["users"]));

    await store.advance("users", 10, { columns: ["id"], values: ["10"] });
    await store.complete("users", 42);

    const entry = store.checkpointFor("users");
    expect(entry?.status).toBe("done");
    expect(entry?.rowsCopied).toBe(42);
    expect(entry?.cursor).toBeNull();
  });

  it("records and then clears a failure", async () => {
    const dir = await tempDir();
    const store = await CheckpointStore.create(join(dir, "job.json"), baseManifest(["users"]));

    await store.fail("users", "boom");
    expect(store.checkpointFor("users")?.status).toBe("failed");
    expect(store.checkpointFor("users")?.error).toBe("boom");

    await store.complete("users", 1);
    expect(store.checkpointFor("users")?.error).toBeUndefined();
  });

  it("reports only unfinished tables as pending", async () => {
    const dir = await tempDir();
    const store = await CheckpointStore.create(
      join(dir, "job.json"),
      baseManifest(["a", "b", "c"]),
    );

    await store.complete("a", 5);

    expect(store.pendingTables().map((t) => t.table)).toEqual(["b", "c"]);
  });

  it("totals rows across tables", async () => {
    const dir = await tempDir();
    const store = await CheckpointStore.create(join(dir, "job.json"), baseManifest(["a", "b"]));

    await store.complete("a", 100);
    await store.advance("b", 50, null);

    expect(store.totalRows()).toBe(150);
  });

  it("rejects an unknown table rather than silently ignoring it", async () => {
    const dir = await tempDir();
    const store = await CheckpointStore.create(join(dir, "job.json"), baseManifest(["a"]));

    await expect(store.complete("nope", 1)).rejects.toThrow(/No checkpoint entry/);
  });

  it("fails loudly on a corrupt manifest instead of throwing a raw parse error", async () => {
    const dir = await tempDir();
    const path = join(dir, "job.json");
    await writeFile(path, "{not json", "utf8");

    await expect(CheckpointStore.load(path)).rejects.toThrow(/corrupt and could not be parsed/);
  });

  it("refuses a manifest written by an incompatible version", async () => {
    const dir = await tempDir();
    const path = join(dir, "job.json");
    await writeFile(path, JSON.stringify({ version: 999, tables: [] }), "utf8");

    await expect(CheckpointStore.load(path)).rejects.toThrow(/incompatible version/);
  });

  it("writes valid JSON and leaves no temp file behind", async () => {
    const dir = await tempDir();
    const path = join(dir, "job.json");

    const store = await CheckpointStore.create(path, baseManifest(["users"]));
    await store.advance("users", 1, null);

    const raw = await readFile(path, "utf8");
    let parsed: Manifest;
    try {
      parsed = JSON.parse(raw) as Manifest;
    } catch (error) {
      throw new Error(`Manifest at ${path} is not valid JSON: ${raw}`, { cause: error });
    }

    expect(parsed.version).toBe(1);
    expect(parsed.tables[0]?.table).toBe("users");

    // The atomic write must not leave `<path>.tmp` around.
    expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
  });

  it("creates the parent directory when it does not exist", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "deeper", "job.json");

    await CheckpointStore.create(path, baseManifest(["users"]));

    expect(await Bun.file(path).exists()).toBe(true);
  });
});
