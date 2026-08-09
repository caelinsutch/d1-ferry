import { describe, expect, it } from "bun:test";

import { parseIntOption, parseSizeOption } from "./context.ts";

describe("parseSizeOption", () => {
  const parse = parseSizeOption("statement-size");

  it("accepts a plain byte count", () => {
    expect(parse("92000")).toBe(92_000);
  });

  it.each([
    ["1B", 1],
    ["1KB", 1024],
    ["1k", 1024],
    ["64KB", 65_536],
    ["1MB", 1_048_576],
    ["24MB", 25_165_824],
    ["1GB", 1_073_741_824],
  ])("parses %s", (input, expected) => {
    expect(parse(input)).toBe(expected);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(parse(" 24 mb ")).toBe(25_165_824);
    expect(parse("24Mb")).toBe(25_165_824);
  });

  it("accepts fractional sizes, flooring the result", () => {
    expect(parse("1.5KB")).toBe(1536);
  });

  it("rejects an unknown unit with an actionable message", () => {
    expect(() => parse("10TB")).toThrow(/unknown unit "tb"/i);
  });

  it("rejects nonsense", () => {
    expect(() => parse("abc")).toThrow(/must be a size like/);
    expect(() => parse("")).toThrow(/must be a size like/);
    expect(() => parse("-5MB")).toThrow(/must be a size like/);
  });

  it("names the offending flag so the error is self-explanatory", () => {
    expect(() => parseSizeOption("file-size")("nope")).toThrow(/--file-size/);
  });
});

describe("parseIntOption", () => {
  const parse = parseIntOption("page-size");

  it("accepts a positive integer", () => {
    expect(parse("1000")).toBe(1000);
  });

  it("rejects zero and negatives, which would stall or invert paging", () => {
    expect(() => parse("0")).toThrow(/positive integer/);
    expect(() => parse("-1")).toThrow(/positive integer/);
  });

  it("rejects fractions and non-numbers", () => {
    expect(() => parse("1.5")).toThrow(/positive integer/);
    expect(() => parse("lots")).toThrow(/positive integer/);
  });

  it("names the offending flag", () => {
    expect(() => parse("0")).toThrow(/--page-size/);
  });
});
