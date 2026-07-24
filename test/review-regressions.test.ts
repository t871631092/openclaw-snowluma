/**
 * Regression tests for defects found in code review that the original suite
 * did not cover. Each `it` names the specific bug it locks down.
 *
 * `../src/client.js` is partially mocked so the one channel case that needs
 * `acquireActionClient` to fail can drive it deterministically; every other
 * export stays real.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return { ...actual, acquireActionClient: vi.fn(actual.acquireActionClient) };
});

import { acquireActionClient } from "../src/client.js";
import { extractReplyToId, renderSegments } from "../src/segments.js";
import { stripLeadingMention } from "../src/triggers.js";
import { parseTarget } from "../src/outbound.js";
import { snowLumaPlugin } from "../src/channel.js";
import type { SnowLumaHostConfig } from "../src/types.js";

const mockedAcquire = vi.mocked(acquireActionClient);

// ── segments.ts ────────────────────────────────────────────────────────────

describe("renderSegments — prototype-key segment types (M3)", () => {
  for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    it(`renders {type:"${type}"} as a [${type}] placeholder, not a prototype member`, () => {
      const rendered = renderSegments([{ type, data: {} }]);
      expect(rendered).toBe(`[${type}]`);
      expect(rendered).not.toContain("native code");
      expect(rendered).not.toContain("[object Object]");
    });
  }

  it("still renders a known type via its real placeholder", () => {
    expect(renderSegments([{ type: "image", data: {} }])).toBe("[图片]");
  });
});

describe("extractReplyToId — empty-string id (L2)", () => {
  it("treats an empty-string reply id as no reply", () => {
    expect(extractReplyToId([{ type: "reply", data: { id: "" } }])).toBeUndefined();
  });

  it("still returns a real reply id", () => {
    expect(extractReplyToId([{ type: "reply", data: { id: "42" } }])).toBe("42");
  });
});

// ── triggers.ts ──────────────────────────────────────────────────────────────

describe("stripLeadingMention — CJK / no-space over-strip (H2)", () => {
  it("does NOT wipe the message when a rendered @name is followed by CJK with no space", () => {
    // "@bot帮我查一下今天天气" — greedy \S+ would eat the whole thing.
    expect(stripLeadingMention("@bot帮我查一下今天天气")).toBe("@bot帮我查一下今天天气");
  });

  it("still strips a rendered @name when a space delimits it", () => {
    expect(stripLeadingMention("@bot 帮我查天气")).toBe("帮我查天气");
  });
});

describe("stripLeadingMention — CQ at with unknown selfId (M4)", () => {
  it("preserves a leading CQ mention of another user when selfId is unknown", () => {
    expect(stripLeadingMention("[CQ:at,qq=12345] 麻烦转告一下", undefined)).toBe(
      "[CQ:at,qq=12345] 麻烦转告一下",
    );
  });

  it("strips the CQ mention only when it is the bot itself", () => {
    expect(stripLeadingMention("[CQ:at,qq=12345] 麻烦转告一下", 12345)).toBe("麻烦转告一下");
  });

  it("preserves a CQ mention of someone else even when selfId is known", () => {
    expect(stripLeadingMention("[CQ:at,qq=12345] 麻烦转告一下", 999)).toBe(
      "[CQ:at,qq=12345] 麻烦转告一下",
    );
  });

  it("always strips @全体成员", () => {
    expect(stripLeadingMention("[CQ:at,qq=all] 大家好", undefined)).toBe("大家好");
  });
});

// ── outbound.ts ──────────────────────────────────────────────────────────────

describe("parseTarget — case-insensitive channel prefix (L5)", () => {
  it("accepts a mixed-case channel prefix, matching normalizeTarget", () => {
    expect(parseTarget("SnowLuma:group:1")).toEqual({ kind: "group", id: 1 });
    expect(parseTarget("SNOWLUMA:private:2")).toEqual({ kind: "private", id: 2 });
  });
});

// ── channel.ts ───────────────────────────────────────────────────────────────

const namedAccountCfg: SnowLumaHostConfig = {
  channels: { snowluma: { accounts: { alt: { enabled: true, wsUrl: "ws://127.0.0.1:9/" } } } },
};

describe("describeMessageTool — per-account scoping (M6)", () => {
  it("reports the react action for a configured named account", () => {
    const result = snowLumaPlugin.actions!.describeMessageTool!({
      cfg: namedAccountCfg as never,
      accountId: "alt",
    });
    expect(result).toEqual({ actions: ["react"] });
  });

  it("returns null for the unconfigured default account of the same config", () => {
    const result = snowLumaPlugin.actions!.describeMessageTool!({ cfg: namedAccountCfg as never });
    expect(result).toBeNull();
  });
});

describe("setup.validateInput — --use-env is default-account-only (L4)", () => {
  it("rejects --use-env for a named account", () => {
    const msg = snowLumaPlugin.setup!.validateInput!({
      cfg: {} as never,
      accountId: "alt",
      input: { useEnv: true } as never,
    });
    expect(msg).toMatch(/only configures the default account/);
  });

  it("accepts --use-env for the default account", () => {
    const msg = snowLumaPlugin.setup!.validateInput!({
      cfg: {} as never,
      accountId: "default",
      input: { useEnv: true } as never,
    });
    expect(msg).toBeNull();
  });

  it("accepts --token for a named account", () => {
    const msg = snowLumaPlugin.setup!.validateInput!({
      cfg: {} as never,
      accountId: "alt",
      input: { token: "ws://127.0.0.1:9/" } as never,
    });
    expect(msg).toBeNull();
  });
});

describe("actions.handleAction — react validation & error contract (L6, M5)", () => {
  it("rejects a blank message_id instead of reacting to message 0", async () => {
    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "react",
      cfg: {} as never,
      params: { message_id: "", emoji_id: "1" },
      accountId: "default",
    } as never);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(result.content[0]!.text).toMatch(/requires/);
    // Blank id is caught before any client is acquired.
    expect(mockedAcquire).not.toHaveBeenCalled();
  });

  it("returns a structured failure (never throws) when acquiring a client fails", async () => {
    mockedAcquire.mockRejectedValueOnce(new Error("connect refused"));
    const cfg: SnowLumaHostConfig = {
      channels: { snowluma: { wsUrl: "ws://127.0.0.1:9/", enabled: true } },
    };
    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "react",
      cfg: cfg as never,
      params: { message_id: "500", emoji_id: "1" },
      accountId: "default",
    } as never);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(result.content[0]!.text).toMatch(/could not reach|connect refused/);
  });
});
