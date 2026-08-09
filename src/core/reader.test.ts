import { describe, expect, it } from "bun:test";

import type { D1Client, D1RawResult } from "./client.ts";
import { type ReadPage, TableReader } from "./reader.ts";
import { affinityOf } from "./sql.ts";
import type { ColumnInfo, SqlValue, TableInfo } from "./types.ts";

function column(name: string, declaredType = "TEXT", pkPosition = 0): ColumnInfo {
  return {
    name,
    declaredType,
    affinity: affinityOf(declaredType),
    notNull: false,
    defaultValue: null,
    pkPosition,
  };
}

function table(name: string, columns: ColumnInfo[], withoutRowid = false): TableInfo {
  return {
    name,
    type: "table",
    withoutRowid,
    strict: false,
    columns,
    foreignKeys: [],
    ddl: null,
  };
}

/**
 * A D1Client stand-in that records the SQL it is asked to run and replays canned
 * pages. Keeps these tests offline and makes the generated SQL directly assertable.
 *
 * Rows must be supplied in wire form: untagged cursor columns first, then the
 * typeof()-tagged data columns, exactly as `readProjection` asks D1 for them.
 */
function fakeClient(pages: Array<{ columns: string[]; rows: SqlValue[][] }>): {
  client: D1Client;
  queries: string[];
} {
  const queries: string[] = [];
  let call = 0;

  const client = {
    raw(_databaseId: string, sql: string): Promise<D1RawResult> {
      queries.push(sql);
      const page = pages[call++] ?? { columns: [], rows: [] };
      return Promise.resolve({ columns: page.columns, rows: page.rows, meta: {} });
    },
  } as unknown as D1Client;

  return { client, queries };
}

/** Consume every page a reader yields, returning them in order. */
async function drain(reader: TableReader): Promise<ReadPage[]> {
  const pages: ReadPage[] = [];
  for await (const page of reader.pages()) pages.push(page);
  return pages;
}

describe("TableReader pagination", () => {
  it("pages by rowid and never uses OFFSET", async () => {
    const t = table("users", [column("id", "INTEGER", 1), column("name")]);
    const { client, queries } = fakeClient([
      { columns: ["__cursor_0", "id", "name"], rows: [["1", "i:1", "t:a"]] },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 10 }));

    expect(queries[0]).toContain("ORDER BY rowid");
    expect(queries[0]).toContain("LIMIT 10");
    expect(queries[0]).not.toContain("OFFSET");
  });

  it("strips the cursor column and decodes tagged values", async () => {
    const t = table("logs", [column("message")]);
    const { client, queries } = fakeClient([
      { columns: ["__cursor_0", "message"], rows: [["7", "t:hello"]] },
    ]);

    const reader = new TableReader(client, "db", t, { pageSize: 5 });
    const pages = await drain(reader);

    expect(queries[0]).toContain('CAST(rowid AS TEXT) AS "__cursor_0"');
    expect(pages[0]?.columns).toEqual(["message"]);
    // The synthetic cursor must not leak into the data, and the tag must be gone.
    expect(pages[0]?.rows).toEqual([["hello"]]);
    expect(reader.position).toEqual({ columns: ["rowid"], values: ["7"] });
  });

  it("decodes each storage class back to its original type", async () => {
    const t = table("mixed", [
      column("i", "INTEGER"),
      column("r", "REAL"),
      column("t", "TEXT"),
      column("b", "BLOB"),
      column("n", "TEXT"),
    ]);
    const { client } = fakeClient([
      {
        columns: ["__cursor_0", "i", "r", "t", "b", "n"],
        // int64 beyond 2^53, a real as a JSON number, text, a blob as hex, and NULL.
        rows: [["1", "i:9223372036854775807", 1.5, "t:hi", "b:DEADBEEF", null]],
      },
    ]);

    const pages = await drain(new TableReader(client, "db", t, { pageSize: 1 }));
    const row = pages[0]?.rows[0] as SqlValue[];

    expect(row[0]).toBe(9223372036854775807n); // exact int64, not a lossy float
    expect(row[1]).toBe(1.5);
    expect(row[2]).toBe("hi");
    expect(row[3]).toBeInstanceOf(Uint8Array);
    expect([...(row[3] as Uint8Array)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(row[4]).toBeNull();
  });

  it("restores NUL-containing text as a cast, since a literal would truncate", async () => {
    const t = table("t", [column("body", "TEXT")]);
    const { client } = fakeClient([
      // hex of "a\0b"
      { columns: ["__cursor_0", "body"], rows: [["1", "x:610062"]] },
    ]);

    const pages = await drain(new TableReader(client, "db", t, { pageSize: 1 }));

    expect(pages[0]?.rows[0]?.[0]).toEqual({ sql: "CAST(X'610062' AS TEXT)" });
  });

  it("seeks past the last row of the previous page", async () => {
    const t = table("users", [column("id", "INTEGER", 1), column("name")]);
    const { client, queries } = fakeClient([
      {
        columns: ["__cursor_0", "id", "name"],
        rows: [
          ["1", "i:1", "t:a"],
          ["2", "i:2", "t:b"],
        ],
      },
      { columns: ["__cursor_0", "id", "name"], rows: [["3", "i:3", "t:c"]] },
    ]);

    const pages = await drain(new TableReader(client, "db", t, { pageSize: 2 }));

    expect(pages).toHaveLength(2);
    // Resumes strictly after rowid 2, unquoted so it compares as an integer.
    expect(queries[1]).toContain("(rowid > 2)");
  });

  it("builds a lexicographic predicate for a WITHOUT ROWID composite key", async () => {
    const t = table(
      "memberships",
      [column("org", "TEXT", 1), column("user", "TEXT", 2), column("role")],
      true,
    );
    const { client, queries } = fakeClient([
      {
        columns: ["__cursor_0", "__cursor_1", "org", "user", "role"],
        rows: [
          ["acme", "ada", "t:acme", "t:ada", "t:admin"],
          ["acme", "bob", "t:acme", "t:bob", "t:member"],
        ],
      },
      { columns: ["__cursor_0", "__cursor_1", "org", "user", "role"], rows: [] },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 2 }));

    // Must be (org > 'acme') OR (org = 'acme' AND user > 'bob'). A naive
    // `org >= ? AND user > ?` would skip every row in a later org.
    expect(queries[1]).toContain(`("org" > 'acme')`);
    expect(queries[1]).toContain(`("org" = 'acme' AND "user" > 'bob')`);
    expect(queries[1]).toContain(" OR ");
  });

  it("combines a user filter with the seek predicate", async () => {
    const t = table("events", [column("id", "INTEGER", 1), column("kind")]);
    const { client, queries } = fakeClient([
      { columns: ["__cursor_0", "id", "kind"], rows: [["1", "i:1", "t:click"]] },
    ]);

    await drain(
      new TableReader(client, "db", t, {
        pageSize: 1,
        where: "kind = 'click'",
        cursor: { columns: ["rowid"], values: ["10"] },
      }),
    );

    expect(queries[0]).toContain("(kind = 'click')");
    expect(queries[0]).toContain("(rowid > 10)");
    expect(queries[0]).toContain(" AND ");
  });

  it("stops at the row limit", async () => {
    const t = table("users", [column("id", "INTEGER", 1)]);
    const { client, queries } = fakeClient([
      {
        columns: ["__cursor_0", "id"],
        rows: [
          ["1", "i:1"],
          ["2", "i:2"],
          ["3", "i:3"],
        ],
      },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 10, limit: 3 }));

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("LIMIT 3");
  });

  it("treats an empty first page as an exhausted table", async () => {
    const t = table("empty", [column("id", "INTEGER", 1)]);
    const { client } = fakeClient([{ columns: ["__cursor_0", "id"], rows: [] }]);

    const reader = new TableReader(client, "db", t);

    expect(await drain(reader)).toEqual([]);
    expect(reader.position).toBeNull();
  });

  it("escapes a quoted identifier in the seek predicate", async () => {
    const t = table("t", [column('we"ird', "TEXT", 1)], true);
    const { client, queries } = fakeClient([
      {
        columns: ["__cursor_0", 'we"ird'],
        rows: [
          ["x", "t:x"],
          ["y", "t:y"],
        ],
      },
      { columns: ["__cursor_0", 'we"ird'], rows: [] },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 2 }));

    expect(queries[1]).toContain('"we""ird" > \'y\'');
  });
});
