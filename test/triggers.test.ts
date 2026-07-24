import { describe, expect, it } from "vitest";
import { evaluateTrigger, matchKeyword, stripLeadingMention } from "../src/triggers.js";
import { QUOTE_DEFAULTS, RECEIVE_DEFAULTS } from "../src/config.js";
import type { NormalizedMessage, ResolvedReceiveConfig, ResolvedSnowLumaAccount } from "../src/types.js";

function cloneReceive(): ResolvedReceiveConfig {
  return JSON.parse(JSON.stringify(RECEIVE_DEFAULTS));
}

function makeAccount(overrides: {
  selfId?: number;
  mention?: Partial<ResolvedReceiveConfig["mention"]>;
  digest?: Partial<ResolvedReceiveConfig["digest"]>;
  realtime?: Partial<ResolvedReceiveConfig["realtime"]>;
} = {}): ResolvedSnowLumaAccount {
  const receive = cloneReceive();
  Object.assign(receive.mention, overrides.mention);
  Object.assign(receive.digest, overrides.digest);
  Object.assign(receive.realtime, overrides.realtime);

  return {
    accountId: "default",
    enabled: true,
    wsUrl: "ws://127.0.0.1:3001/",
    selfId: overrides.selfId,
    groupAutoReact: false,
    groupAutoReactEmojiId: 1,
    replyToTrigger: true,
    textChunkLimit: 4500,
    requestTimeoutMs: 30_000,
    reconnect: { enabled: true, retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30_000 },
    receive,
    quote: JSON.parse(JSON.stringify(QUOTE_DEFAULTS)),
    toolsEnabled: true,
    config: {},
  };
}

function makeGroupMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    peerId: "group:2001",
    peerKind: "group",
    groupId: 2001,
    senderId: 1001,
    senderName: "Alice",
    selfId: 9000,
    messageId: 1,
    time: 1_700_000_000,
    text: "hello there",
    rawText: "hello there",
    segments: [],
    mentions: [],
    atAll: false,
    imageUrls: [],
    recordUrls: [],
    forwardIds: [],
    ...overrides,
  };
}

function makeDirectMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    ...makeGroupMessage(overrides),
    peerId: "private:1001",
    peerKind: "direct",
    groupId: undefined,
    ...overrides,
  };
}

// ── matchKeyword ─────────────────────────────────────────────────────────

describe("matchKeyword", () => {
  it("contains: matches a substring anywhere in the text", () => {
    expect(matchKeyword("please check the weather today", ["weather"], "contains", false)).toBe("weather");
  });

  it("prefix: matches only at the (trimmed) start of the text", () => {
    expect(matchKeyword("  weather please", ["weather"], "prefix", false)).toBe("weather");
    expect(matchKeyword("please check weather", ["weather"], "prefix", false)).toBeUndefined();
  });

  it("exact: matches only the whole (trimmed) text", () => {
    expect(matchKeyword("  weather  ", ["weather"], "exact", false)).toBe("weather");
    expect(matchKeyword("weather today", ["weather"], "exact", false)).toBeUndefined();
  });

  it("regex: matches via a compiled RegExp", () => {
    expect(matchKeyword("order #12345 placed", ["order #\\d+"], "regex", false)).toBe("order #\\d+");
  });

  it("regex: an invalid pattern is skipped, never thrown, and later keywords still get a chance", () => {
    expect(() => matchKeyword("I have a cat", ["[unterminated(", "cat"], "regex", false)).not.toThrow();
    expect(matchKeyword("I have a cat", ["[unterminated(", "cat"], "regex", false)).toBe("cat");
    expect(matchKeyword("no match here", ["[unterminated("], "regex", false)).toBeUndefined();
  });

  it("respects caseSensitive", () => {
    expect(matchKeyword("Weather Today", ["weather"], "contains", false)).toBe("weather");
    expect(matchKeyword("Weather Today", ["weather"], "contains", true)).toBeUndefined();
    expect(matchKeyword("Weather Today", ["Weather"], "contains", true)).toBe("Weather");
  });

  it("returns undefined for empty keywords or empty text", () => {
    expect(matchKeyword("anything", [], "contains", false)).toBeUndefined();
    expect(matchKeyword("", ["anything"], "contains", false)).toBeUndefined();
  });
});

// ── stripLeadingMention ─────────────────────────────────────────────────

describe("stripLeadingMention", () => {
  it("strips a leading rendered @name token and surrounding whitespace", () => {
    expect(stripLeadingMention("@bot 帮我查天气")).toBe("帮我查天气");
    expect(stripLeadingMention("  @机器人   查询天气  ")).toBe("查询天气  ");
  });

  it("leaves text with no leading mention untouched", () => {
    expect(stripLeadingMention("帮我查天气")).toBe("帮我查天气");
  });

  it("strips a leading CQ at remnant that matches selfId", () => {
    expect(stripLeadingMention("[CQ:at,qq=9000] 帮我查天气", 9000)).toBe("帮我查天气");
    expect(stripLeadingMention("[CQ:at,qq=9000,name=Bot] 帮我查天气", 9000)).toBe("帮我查天气");
  });

  it("leaves a CQ at remnant for a different id untouched when selfId is given", () => {
    expect(stripLeadingMention("[CQ:at,qq=1] 帮我查天气", 9000)).toBe("[CQ:at,qq=1] 帮我查天气");
  });

  it("strips a @全体成员 CQ remnant regardless of selfId", () => {
    expect(stripLeadingMention("[CQ:at,qq=all] 大家好", 9000)).toBe("大家好");
  });
});

// ── evaluateTrigger ──────────────────────────────────────────────────────

describe("evaluateTrigger", () => {
  it("direct chat auto-replies when alwaysReplyInDirect is on (default)", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeDirectMessage({ text: "hi" });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: true, reason: "direct" });
  });

  it("group message with no mention and requireMentionInGroup ⇒ not triggered", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeGroupMessage({ text: "just chatting", mentions: [] });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: false });
  });

  it("@bot mention ⇒ reason mention", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeGroupMessage({ text: "帮我查天气", mentions: ["9000"] });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: true, reason: "mention" });
  });

  it("mention detection cannot fire when selfId is undefined", () => {
    const account = makeAccount({ selfId: undefined });
    const msg = makeGroupMessage({ text: "帮我查天气", mentions: ["9000"] });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: false });
  });

  it("atAll alone does NOT trigger", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeGroupMessage({ text: "大家好", mentions: ["all"], atAll: true });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: false });
  });

  it.each([
    ["contains", "please check the weather", "weather"],
    ["prefix", "weather please", "weather"],
    ["exact", "weather", "weather"],
    ["regex", "order #12345", "order #\\d+"],
  ] as const)("keyword hit in %s mode ⇒ reason keyword", (mode, text, keyword) => {
    const account = makeAccount({ selfId: 9000, mention: { keywords: [keyword], keywordMatch: mode } });
    const msg = makeGroupMessage({ text });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: true, reason: "keyword", keyword });
  });

  it("an invalid regex keyword is skipped rather than thrown", () => {
    const account = makeAccount({
      selfId: 9000,
      mention: { keywords: ["[bad(", "cat"], keywordMatch: "regex" },
    });
    const msg = makeGroupMessage({ text: "I saw a cat" });
    expect(() => evaluateTrigger(msg, account)).not.toThrow();
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: true, reason: "keyword", keyword: "cat" });
  });

  it("reply-to-self triggers via isSelfMessageId", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeGroupMessage({ text: "ok thanks", replyToId: "555" });
    const decision = evaluateTrigger(msg, account, { isSelfMessageId: (id) => id === "555" });
    expect(decision).toEqual({ triggered: true, reason: "reply-to-self" });
  });

  it("does not trigger reply-to-self when isSelfMessageId says no, or triggerOnReplyToSelf is off", () => {
    const account = makeAccount({ selfId: 9000 });
    const msg = makeGroupMessage({ text: "ok thanks", replyToId: "555" });
    expect(evaluateTrigger(msg, account, { isSelfMessageId: (id) => id === "999" })).toEqual({ triggered: false });

    const accountNoReplyTrigger = makeAccount({ selfId: 9000, mention: { triggerOnReplyToSelf: false } });
    expect(
      evaluateTrigger(msg, accountNoReplyTrigger, { isSelfMessageId: () => true }),
    ).toEqual({ triggered: false });
  });

  it("mention.enabled:false ⇒ never triggered, regardless of mention/keyword/direct/reply-to-self", () => {
    const account = makeAccount({
      selfId: 9000,
      mention: { enabled: false, keywords: ["weather"] },
    });

    const mentioned = makeGroupMessage({ text: "weather please", mentions: ["9000"] });
    expect(evaluateTrigger(mentioned, account, { isSelfMessageId: () => true })).toEqual({ triggered: false });

    const direct = makeDirectMessage({ text: "hi" });
    expect(evaluateTrigger(direct, account)).toEqual({ triggered: false });
  });

  it("requireMentionInGroup:false with no keywords configured ⇒ triggered on any group message", () => {
    const account = makeAccount({ selfId: 9000, mention: { requireMentionInGroup: false, keywords: [] } });
    const msg = makeGroupMessage({ text: "anything at all" });
    expect(evaluateTrigger(msg, account)).toEqual({ triggered: true });
  });

  it("requireMentionInGroup:false with keywords configured ⇒ still keyword-gated", () => {
    const account = makeAccount({
      selfId: 9000,
      mention: { requireMentionInGroup: false, keywords: ["weather"] },
    });
    const noMatch = makeGroupMessage({ text: "totally unrelated" });
    expect(evaluateTrigger(noMatch, account)).toEqual({ triggered: false });

    const match = makeGroupMessage({ text: "what's the weather" });
    expect(evaluateTrigger(match, account)).toEqual({ triggered: true, reason: "keyword", keyword: "weather" });
  });

  it("direct chat without alwaysReplyInDirect falls through to keyword gating", () => {
    const account = makeAccount({
      selfId: 9000,
      mention: { alwaysReplyInDirect: false, keywords: ["weather"] },
    });
    const noKeyword = makeDirectMessage({ text: "hello" });
    expect(evaluateTrigger(noKeyword, account)).toEqual({ triggered: false });

    const withKeyword = makeDirectMessage({ text: "what's the weather" });
    expect(evaluateTrigger(withKeyword, account)).toEqual({
      triggered: true,
      reason: "keyword",
      keyword: "weather",
    });
  });
});
