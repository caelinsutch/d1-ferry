import { describe, expect, it } from "bun:test";

import { isUnsupportedStatement, splitStatements } from "./splitter.ts";

const split = (sql: string): string[] => [...splitStatements(sql)];

describe("splitStatements", () => {
  it("splits simple statements", () => {
    expect(split("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores a trailing statement without a semicolon", () => {
    expect(split("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("skips blank statements from repeated semicolons", () => {
    expect(split("SELECT 1;;;\n\n;SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split on a semicolon inside a string literal", () => {
    const sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;";
    expect(split(sql)).toEqual(["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
  });

  it("handles doubled single quotes inside a literal", () => {
    const sql = "INSERT INTO t VALUES ('O''Brien; Jr'); SELECT 1;";
    expect(split(sql)).toEqual(["INSERT INTO t VALUES ('O''Brien; Jr')", "SELECT 1"]);
  });

  it("does not split on a semicolon inside a quoted identifier", () => {
    const sql = 'CREATE TABLE "we;ird" (a); SELECT 1;';
    expect(split(sql)).toEqual(['CREATE TABLE "we;ird" (a)', "SELECT 1"]);
  });

  it("handles bracket and backtick identifiers", () => {
    expect(split("SELECT [a;b] FROM t; SELECT `c;d` FROM u;")).toEqual([
      "SELECT [a;b] FROM t",
      "SELECT `c;d` FROM u",
    ]);
  });

  it("does not split on a semicolon inside a line comment", () => {
    const sql = "SELECT 1; -- trailing; comment\nSELECT 2;";
    expect(split(sql)).toEqual(["SELECT 1", "-- trailing; comment\nSELECT 2"]);
  });

  it("does not split on a semicolon inside a block comment", () => {
    const sql = "SELECT 1; /* a; b */ SELECT 2;";
    expect(split(sql)).toEqual(["SELECT 1", "/* a; b */ SELECT 2"]);
  });

  it("keeps a CREATE TRIGGER body intact", () => {
    const sql = `CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; DELETE FROM c; END;
SELECT 1;`;
    const out = split(sql);

    expect(out).toHaveLength(2);
    expect(out[0]).toContain("UPDATE b SET n = 1;");
    expect(out[0]).toContain("DELETE FROM c;");
    expect(out[0]?.endsWith("END")).toBe(true);
    expect(out[1]).toBe("SELECT 1");
  });

  it("handles CASE expressions, which also use END", () => {
    const sql = "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t; SELECT 2;";
    expect(split(sql)).toEqual(["SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t", "SELECT 2"]);
  });

  it("does not treat BEGINNING as the BEGIN keyword", () => {
    const sql = "INSERT INTO t VALUES ('BEGINNING'); SELECT 1;";
    expect(split(sql)).toEqual(["INSERT INTO t VALUES ('BEGINNING')", "SELECT 1"]);
  });

  it("handles blob literals containing a semicolon byte", () => {
    // X'3b' is ';' — inside the literal it must not terminate the statement.
    const sql = "INSERT INTO t VALUES (X'3b'); SELECT 1;";
    expect(split(sql)).toEqual(["INSERT INTO t VALUES (X'3b')", "SELECT 1"]);
  });

  it("does not lose data when a literal is unterminated", () => {
    const out = split("INSERT INTO t VALUES ('oops");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("oops");
  });

  it("handles a realistic sqlite3 .dump preamble", () => {
    const dump = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO users VALUES(1,'a;b');
COMMIT;`;
    const out = split(dump);

    expect(out).toHaveLength(5);
    expect(out.filter((s) => isUnsupportedStatement(s))).toHaveLength(3);
  });
});

describe("isUnsupportedStatement", () => {
  it.each([
    "BEGIN TRANSACTION",
    "BEGIN",
    "BEGIN DEFERRED TRANSACTION",
    "COMMIT",
    "COMMIT TRANSACTION",
    "ROLLBACK",
    "PRAGMA foreign_keys=OFF",
    "PRAGMA foreign_keys = ON",
  ])("rejects %s", (statement) => {
    expect(isUnsupportedStatement(statement)).toBe(true);
  });

  it("rejects _cf_KV, D1's reserved internal table", () => {
    expect(isUnsupportedStatement("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)")).toBe(
      true,
    );
    expect(isUnsupportedStatement("INSERT INTO _cf_KV VALUES ('a', 'b')")).toBe(true);
  });

  it("tolerates a trailing semicolon", () => {
    expect(isUnsupportedStatement("COMMIT;")).toBe(true);
  });

  it("keeps ordinary statements", () => {
    expect(isUnsupportedStatement("INSERT INTO users VALUES (1)")).toBe(false);
    expect(isUnsupportedStatement("CREATE TABLE users (id INTEGER)")).toBe(false);
    expect(isUnsupportedStatement("PRAGMA defer_foreign_keys = true")).toBe(false);
  });

  it("does not reject a table merely because its name starts with BEGIN", () => {
    expect(isUnsupportedStatement("INSERT INTO beginnings VALUES (1)")).toBe(false);
  });
});
