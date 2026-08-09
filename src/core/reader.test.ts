import { describe, expect, it } from "bun:test";

import type { D1Client, D1RawResult } from "./client.ts";
import { TableReader, type ReadPage } from "./reader.ts";
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

/** Consume every page an async generator yields, returning them in order. */
async function drain(reader: TableReader): Promise<ReadPage[]> {
  const pages: ReadPage[] = [];
  for await (const page of reader.pages()) pages.push(page);
  return pages;
}

describe("TableReader pagination", () => {
  it("orders by the primary key and does not use OFFSET", async () => {
    const t = table("users", [column("id", "INTEGER", 1), column("name")]);
    const { client, queries } = fakeClient([{ columns: ["id", "name"], rows: [["1", "a"]] }]);

    await drain(new TableReader(client, "db", t, { pageSize: 10 }));

    expect(queries[0]).toContain('ORDER BY "id"');
    expect(queries[0]).toContain("LIMIT 10");
    expect(queries[0]).not.toContain("OFFSET");
  });

  it("selects rowid as a cursor when the table has no primary key", async () => {
    const t = table("logs", [column("message")]);
    const { client, queries } = fakeClient([
      { columns: ["__cursor_rowid", "message"], rows: [["7", "hello"]] },
    ]);

    const reader = new TableReader(client, "db", t, { pageSize: 5 });
    const collected: SqlValue[][] = [];
    for await (const page of reader.pages()) {
      collected.push(...page.rows);
      expect(page.columns).toEqual(["message"]);
    }

    expect(queries[0]).toContain('CAST(rowid AS TEXT) AS "__cursor_rowid"');
    expect(queries[0]).toContain("ORDER BY rowid");
    // The synthetic cursor column must not leak into the copied data.
    expect(collected).toEqual([["hello"]]);
    expect(reader.position).toEqual({ columns: ["rowid"], values: ["7"] });
  });

  it("seeks past the last row of the previous page", async () => {
    const t = table("users", [column("id", "INTEGER", 1), column("name")]);
    const { client, queries } = fakeClient([
      {
        columns: ["id", "name"],
        rows: [
          ["1", "a"],
          ["2", "b"],
        ],
      },
      { columns: ["id", "name"], rows: [["3", "c"]] },
    ]);

    const reader = new TableReader(client, "db", t, { pageSize: 2 });
    const pages = await drain(reader);

    expect(pages).toHaveLength(2);
    // Page two must resume strictly after id=2, with the integer unquoted.
    expect(queries[1]).toContain('("id" > 2)');
    expect(queries[1]).not.toContain("'2'");
  });

  it("builds a lexicographic predicate for a composite key", async () => {
    const t = table("memberships", [
      column("org", "TEXT", 1),
      column("user", "TEXT", 2),
      column("role"),
    ]);
    const { client, queries } = fakeClient([
      {
        columns: ["org", "user", "role"],
        rows: [
          ["acme", "ada", "admin"],
          ["acme", "bob", "member"],
        ],
      },
      { columns: ["org", "user", "role"], rows: [] },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 2 }));

    // Must be (org > 'acme') OR (org = 'acme' AND user > 'bob'):
    // a naive `org >= ? AND user > ?` would skip rows in later orgs.
    expect(queries[1]).toContain(`("org" > 'acme')`);
    expect(queries[1]).toContain(`("org" = 'acme' AND "user" > 'bob')`);
    expect(queries[1]).toContain(" OR ");
  });

  it("combines a user filter with the seek predicate", async () => {
    const t = table("events", [column("id", "INTEGER", 1), column("kind")]);
    const { client, queries } = fakeClient([{ columns: ["id", "kind"], rows: [["1", "click"]] }]);

    await drain(
      new TableReader(client, "db", t, {
        pageSize: 1,
        where: "kind = 'click'",
        cursor: { columns: ["id"], values: ["10"] },
      }),
    );

    expect(queries[0]).toContain("(kind = 'click')");
    expect(queries[0]).toContain('("id" > 10)');
    expect(queries[0]).toContain(" AND ");
  });

  it("stops at the row limit", async () => {
    const t = table("users", [column("id", "INTEGER", 1)]);
    const { client, queries } = fakeClient([{ columns: ["id"], rows: [["1"], ["2"], ["3"]] }]);

    await drain(new TableReader(client, "db", t, { pageSize: 10, limit: 3 }));

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("LIMIT 3");
  });

  it("treats an empty first page as an exhausted table", async () => {
    const t = table("empty", [column("id", "INTEGER", 1)]);
    const { client } = fakeClient([{ columns: ["id"], rows: [] }]);

    const reader = new TableReader(client, "db", t);
    const pages = await drain(reader);

    expect(pages).toEqual([]);
    expect(reader.position).toBeNull();
  });

  it("escapes a quoted identifier in the seek predicate", async () => {
    const t = table("t", [column('we"ird', "TEXT", 1)]);
    const { client, queries } = fakeClient([
      { columns: ['we"ird'], rows: [["x"], ["y"]] },
      { columns: ['we"ird'], rows: [] },
    ]);

    await drain(new TableReader(client, "db", t, { pageSize: 2 }));

    expect(queries[1]).toContain('"we""ird" > \'y\'');
  });
});
