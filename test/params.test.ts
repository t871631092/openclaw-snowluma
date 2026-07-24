/**
 * Behaviour parity for the local, openclaw-free param readers in `src/params.ts`.
 *
 * These replaced `readNumberParam` / `readStringParam` from
 * `openclaw/plugin-sdk/core` to keep `setup-entry.js`'s runtime graph free of any
 * `openclaw/*` import (see load-graph.test.ts and
 * docs/guide/troubleshooting.md#err-require-esm-race-condition). The behaviour
 * they encode is depended on by `tools.ts`, so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import { ToolInputError, readNumberParam, readStringParam } from "../src/params.js";

describe("readStringParam", () => {
  it("returns a trimmed string", () => {
    expect(readStringParam({ target: "  group:1  " }, "target")).toBe("group:1");
  });

  it("returns undefined for a missing / non-string / blank value (not required)", () => {
    expect(readStringParam({}, "target")).toBeUndefined();
    expect(readStringParam({ target: 42 }, "target")).toBeUndefined();
    expect(readStringParam({ target: "   " }, "target")).toBeUndefined();
  });

  it("throws ToolInputError('<label> required') when required and absent", () => {
    expect(() => readStringParam({}, "target", { required: true })).toThrow(ToolInputError);
    expect(() => readStringParam({}, "target", { required: true })).toThrow("target required");
    expect(() => readStringParam({ target: "  " }, "target", { required: true })).toThrow("target required");
  });

  it("honours a custom label in the required error", () => {
    expect(() => readStringParam({}, "target", { required: true, label: "会话目标" })).toThrow("会话目标 required");
  });

  it("keeps a blank string when allowEmpty is set", () => {
    expect(readStringParam({ x: "" }, "x", { allowEmpty: true })).toBe("");
  });

  it("does not trim when trim:false", () => {
    expect(readStringParam({ x: "  a " }, "x", { trim: false })).toBe("  a ");
  });

  it("falls back to the snake_case key spelling", () => {
    expect(readStringParam({ account_id: "alt" }, "accountId")).toBe("alt");
    // exact key always wins over the snake_case fallback
    expect(readStringParam({ accountId: "camel", account_id: "snake" }, "accountId")).toBe("camel");
  });
});

describe("readNumberParam", () => {
  it("returns a finite number as-is", () => {
    expect(readNumberParam({ count: 30 }, "count")).toBe(30);
  });

  it("coerces a numeric string (parseFloat by default)", () => {
    expect(readNumberParam({ count: "30" }, "count")).toBe(30);
    expect(readNumberParam({ count: "12.5abc" }, "count")).toBe(12.5); // parseFloat, non-strict
  });

  it("returns undefined for missing / non-numeric (not required)", () => {
    expect(readNumberParam({}, "count")).toBeUndefined();
    expect(readNumberParam({ count: "nope" }, "count")).toBeUndefined();
    expect(readNumberParam({ count: Number.NaN }, "count")).toBeUndefined();
  });

  it("throws ToolInputError when required and absent", () => {
    expect(() => readNumberParam({}, "count", { required: true })).toThrow(ToolInputError);
    expect(() => readNumberParam({}, "count", { required: true })).toThrow("count required");
  });

  it("truncates toward zero with integer:true", () => {
    expect(readNumberParam({ n: 12.9 }, "n", { integer: true })).toBe(12);
    expect(readNumberParam({ n: -12.9 }, "n", { integer: true })).toBe(-12);
  });

  it("uses Number() (not parseFloat) when strict", () => {
    expect(readNumberParam({ n: "12abc" }, "n", { strict: true })).toBeUndefined();
    expect(readNumberParam({ n: "12" }, "n", { strict: true })).toBe(12);
  });

  it("falls back to the snake_case key spelling", () => {
    expect(readNumberParam({ message_seq: 100 }, "messageSeq")).toBe(100);
  });
});
