/**
 * The on-demand `/summary` command: matching, history fetch, batch shape, and
 * the dispatch behaviour that distinguishes a summary turn from a digest one.
 *
 * No real client and no real host — `runSummaryCommand` takes `fetchHistory`,
 * `send` and `dispatch` as injected dependencies, so every path here is driven
 * with plain fakes.
 */
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { AggregatedBatch } from "../src/aggregator.js";
import { QUOTE_DEFAULTS, RECEIVE_DEFAULTS, resolveSnowLumaAccount } from "../src/config.js";
import { buildBatchBody, dispatchBatch } from "../src/dispatch.js";
import { matchSummaryCommand, runSummaryCommand } from "../src/summary.js";
import type { NormalizedMessage, ResolvedReceiveConfig, ResolvedSnowLumaAccount } from "../src/types.js";
import { createMockRuntime } from "./helpers/mock-runtime.js";

// ── fixtures ────────────────────────────────────────────────────────────

function cloneReceive(): ResolvedReceiveConfig {
  return JSON.parse(JSON.stringify(RECEIVE_DEFAULTS));
}

function makeAccount(
  overrides: Partial<Omit<ResolvedSnowLumaAccount, "receive">> & {
    summary?: Partial<ResolvedReceiveConfig["summary"]>;
  } = {},
): ResolvedSnowLumaAccount {
  const { summary, ...rest } = overrides;
  const receive = cloneReceive();
  if (summary) Object.assign(receive.summary, summary);

  return {
    accountId: "default",
    enabled: true,
    wsUrl: "ws://127.0.0.1:3001/",
    selfId: 999,
    groupAutoReact: false,
    groupAutoReactEmojiId: 1,
    replyToTrigger: true,
    textChunkLimit: 4500,
    requestTimeoutMs: 30_000,
    debug: false,
    reconnect: { enabled: true, retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30_000 },
    receive,
    quote: { ...QUOTE_DEFAULTS },
    toolsEnabled: true,
    config: {},
    ...rest,
  };
}

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const text = overrides.text ?? "/summary";
  return {
    peerId: "group:888",
    peerKind: "group",
    groupId: 888,
    senderId: 10001,
    senderName: "张三",
    selfId: 999,
    messageId: 500,
    time: 1_700_000_100,
    rawText: text,
    segments: [{ type: "text", data: { text } }],
    mentions: [],
    atAll: false,
    imageUrls: [],
    recordUrls: [],
    replyToId: undefined,
    forwardIds: [],
    ...overrides,
    text,
  };
}

/** One raw `get_group_msg_history` row, as it comes off the wire. */
function historyEntry(i: number, overrides: Record<string, unknown> = {}) {
  return {
    message_id: i,
    time: 1_700_000_000 + i,
    sender: { user_id: 10000 + i, nickname: `用户${i}` },
    message: [{ type: "text", data: { text: `消息 ${i}` } }],
    raw_message: `消息 ${i}`,
    ...overrides,
  };
}

function makeClient(): SnowLumaApiClient {
  return {} as unknown as SnowLumaApiClient;
}

function makeSend() {
  return { sendText: vi.fn(async (_p: unknown) => ({ messageIds: ["out-1"] })) };
}

const cfg = {} as OpenClawConfig;

// ── matchSummaryCommand ─────────────────────────────────────────────────

describe("matchSummaryCommand", () => {
  it("matches the default command words and uses the configured count", () => {
    const account = makeAccount();
    expect(matchSummaryCommand(makeMsg({ text: "/summary" }), account)).toEqual({
      command: "/summary",
      count: 100,
    });
    expect(matchSummaryCommand(makeMsg({ text: "/总结" }), account)).toEqual({
      command: "/总结",
      count: 100,
    });
  });

  it("reads an explicit count, with and without a separating space", () => {
    const account = makeAccount();
    expect(matchSummaryCommand(makeMsg({ text: "/summary 30" }), account)?.count).toBe(30);
    expect(matchSummaryCommand(makeMsg({ text: "/总结50" }), account)?.count).toBe(50);
  });

  it("clamps an explicit count to maxCount", () => {
    const account = makeAccount({ summary: { maxCount: 40 } });
    expect(matchSummaryCommand(makeMsg({ text: "/summary 9999" }), account)?.count).toBe(40);
  });

  it("falls back to the default count when the argument is not a number", () => {
    const account = makeAccount();
    expect(matchSummaryCommand(makeMsg({ text: "/summary 最近聊了什么" }), account)?.count).toBe(100);
  });

  it("strips a leading @bot mention before matching", () => {
    const account = makeAccount();
    expect(matchSummaryCommand(makeMsg({ text: "@小雪 /summary" }), account)?.command).toBe("/summary");
  });

  it("is case-insensitive on the command word", () => {
    expect(matchSummaryCommand(makeMsg({ text: "/SUMMARY" }), makeAccount())?.command).toBe("/summary");
  });

  it("does not match a longer word that merely starts with the command", () => {
    expect(matchSummaryCommand(makeMsg({ text: "/summarylater" }), makeAccount())).toBeNull();
  });

  it("does not match the command mid-sentence", () => {
    expect(matchSummaryCommand(makeMsg({ text: "帮我 /summary 一下" }), makeAccount())).toBeNull();
  });

  it("returns null when disabled", () => {
    expect(matchSummaryCommand(makeMsg(), makeAccount({ summary: { enabled: false } }))).toBeNull();
  });

  it("honours scope", () => {
    const groupOnly = makeAccount({ summary: { scope: "group" } });
    expect(matchSummaryCommand(makeMsg(), groupOnly)).not.toBeNull();
    expect(
      matchSummaryCommand(makeMsg({ peerId: "private:1", peerKind: "direct", groupId: undefined }), groupOnly),
    ).toBeNull();

    const directOnly = makeAccount({ summary: { scope: "direct" } });
    expect(matchSummaryCommand(makeMsg(), directOnly)).toBeNull();
  });

  it("honours the peers allowlist", () => {
    const account = makeAccount({ summary: { peers: ["group:777"] } });
    expect(matchSummaryCommand(makeMsg(), account)).toBeNull();
    expect(matchSummaryCommand(makeMsg({ peerId: "group:777", groupId: 777 }), account)).not.toBeNull();
  });

  it("matches a custom command word", () => {
    const account = makeAccount({ summary: { commands: ["!recap"] } });
    expect(matchSummaryCommand(makeMsg({ text: "!recap 12" }), account)).toEqual({
      command: "!recap",
      count: 12,
    });
    expect(matchSummaryCommand(makeMsg({ text: "/summary" }), account)).toBeNull();
  });
});

// ── runSummaryCommand ───────────────────────────────────────────────────

describe("runSummaryCommand", () => {
  it("fetches group history and dispatches a summary batch", async () => {
    const batches: AggregatedBatch[] = [];
    const fetchHistory = vi.fn(async () => [3, 1, 2].map((i) => historyEntry(i)));
    const msg = makeMsg();

    await runSummaryCommand(msg, { command: "/summary", count: 100 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory,
      send: makeSend(),
      dispatch: async (b) => {
        batches.push(b);
      },
    });

    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.kind).toBe("summary");
    expect(batch.peerId).toBe("group:888");
    expect(batch.reason).toBe("command");
    expect(batch.trigger).toEqual({ triggered: true, reason: "summary" });
    // The command message is carried as `commandMessage`, never as transcript.
    expect(batch.commandMessage).toBe(msg);
    expect(batch.messages.map((m) => m.messageId)).toEqual([1, 2, 3]);
    expect(batch.messages[0]!.senderName).toBe("用户1");
    expect(batch.messages[0]!.peerId).toBe("group:888");
  });

  it("asks for one extra message so the command itself can be filtered out", async () => {
    const fetchHistory = vi.fn(async () => [historyEntry(1), historyEntry(500)]);
    const batches: AggregatedBatch[] = [];

    await runSummaryCommand(makeMsg({ messageId: 500 }), { command: "/summary", count: 20 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory,
      send: makeSend(),
      dispatch: async (b) => {
        batches.push(b);
      },
    });

    expect(fetchHistory).toHaveBeenCalledWith({ count: 21 });
    expect(batches[0]!.messages.map((m) => m.messageId)).toEqual([1]);
  });

  it("keeps only the newest `count` messages", async () => {
    const fetchHistory = vi.fn(async () => [1, 2, 3, 4, 5].map((i) => historyEntry(i)));
    const batches: AggregatedBatch[] = [];

    await runSummaryCommand(makeMsg(), { command: "/summary", count: 3 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory,
      send: makeSend(),
      dispatch: async (b) => {
        batches.push(b);
      },
    });

    expect(batches[0]!.messages.map((m) => m.messageId)).toEqual([3, 4, 5]);
  });

  it("skips malformed history rows instead of rendering them", async () => {
    const fetchHistory = vi.fn(async () => [historyEntry(1), { nonsense: true }, null, historyEntry(2)]);
    const batches: AggregatedBatch[] = [];

    await runSummaryCommand(makeMsg(), { command: "/summary", count: 100 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory,
      send: makeSend(),
      dispatch: async (b) => {
        batches.push(b);
      },
    });

    expect(batches[0]!.messages.map((m) => m.messageId)).toEqual([1, 2]);
  });

  it("uses the private history endpoint for a direct chat", async () => {
    const getFriendMessageHistory = vi.fn(async () => ({ messages: [historyEntry(1)] }));
    const getGroupMessageHistory = vi.fn(async () => ({ messages: [] }));
    const client = { getFriendMessageHistory, getGroupMessageHistory } as unknown as SnowLumaApiClient;
    const batches: AggregatedBatch[] = [];

    await runSummaryCommand(
      makeMsg({ peerId: "private:10001", peerKind: "direct", groupId: undefined }),
      { command: "/summary", count: 10 },
      { account: makeAccount(), client, send: makeSend(), dispatch: async (b) => void batches.push(b) },
    );

    expect(getGroupMessageHistory).not.toHaveBeenCalled();
    expect(getFriendMessageHistory).toHaveBeenCalledWith({ user_id: 10001, count: 11 });
    expect(batches[0]!.peerKind).toBe("direct");
  });

  it("uses the group history endpoint for a group chat", async () => {
    const getGroupMessageHistory = vi.fn(async () => ({ messages: [historyEntry(1)] }));
    const client = { getGroupMessageHistory } as unknown as SnowLumaApiClient;

    await runSummaryCommand(makeMsg(), { command: "/summary", count: 10 }, {
      account: makeAccount(),
      client,
      send: makeSend(),
      dispatch: async () => {},
    });

    expect(getGroupMessageHistory).toHaveBeenCalledWith({ group_id: 888, count: 11 });
  });

  it("tells the chat when there is nothing to summarise, and dispatches nothing", async () => {
    const send = makeSend();
    const dispatch = vi.fn(async () => {});

    await runSummaryCommand(makeMsg(), { command: "/summary", count: 100 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory: async () => [],
      send,
      dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(send.sendText).toHaveBeenCalledTimes(1);
    const params = send.sendText.mock.calls[0]![0] as { text: string; replyToId?: number };
    expect(params.text).toContain("没有可以总结");
    expect(params.replyToId).toBe(500);
  });

  it("reports a history fetch failure back to the chat", async () => {
    const send = makeSend();
    const dispatch = vi.fn(async () => {});
    const errors: string[] = [];

    await runSummaryCommand(makeMsg(), { command: "/summary", count: 100 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory: async () => {
        throw new Error("boom");
      },
      send,
      dispatch,
      log: { error: (m) => errors.push(m) },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect((send.sendText.mock.calls[0]![0] as { text: string }).text).toContain("boom");
    expect(errors.join("\n")).toContain("history fetch failed");
  });

  it("never rejects when the notice send itself fails", async () => {
    const errors: string[] = [];
    await expect(
      runSummaryCommand(makeMsg(), { command: "/summary", count: 100 }, {
        account: makeAccount(),
        client: makeClient(),
        fetchHistory: async () => [],
        send: {
          sendText: async () => {
            throw new Error("socket gone");
          },
        },
        dispatch: async () => {},
        log: { error: (m) => errors.push(m) },
      }),
    ).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("socket gone");
  });

  it("omits replyToId on notices when replyToTrigger is off", async () => {
    const send = makeSend();
    await runSummaryCommand(makeMsg(), { command: "/summary", count: 100 }, {
      account: makeAccount({ replyToTrigger: false }),
      client: makeClient(),
      fetchHistory: async () => [],
      send,
      dispatch: async () => {},
    });
    expect((send.sendText.mock.calls[0]![0] as { replyToId?: number }).replyToId).toBeUndefined();
  });

  it("does nothing when a group message carries no group id", async () => {
    const dispatch = vi.fn(async () => {});
    const send = makeSend();
    const errors: string[] = [];

    await runSummaryCommand(makeMsg({ groupId: undefined }), { command: "/summary", count: 100 }, {
      account: makeAccount(),
      client: makeClient(),
      fetchHistory: async () => [historyEntry(1)],
      send,
      dispatch,
      log: { error: (m) => errors.push(m) },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(send.sendText).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("cannot resolve a history target");
  });
});

// ── config resolution ───────────────────────────────────────────────────

describe("summary config resolution", () => {
  it("defaults to enabled with 100 messages and both built-in command words", () => {
    const account = resolveSnowLumaAccount({ channels: { snowluma: { wsUrl: "ws://x/" } } });
    expect(account.receive.summary).toMatchObject({
      enabled: true,
      count: 100,
      maxCount: 200,
      scope: "all",
      peers: [],
      commands: ["/summary", "/总结"],
    });
  });

  it("honours an explicit disable switch", () => {
    const account = resolveSnowLumaAccount({
      channels: { snowluma: { wsUrl: "ws://x/", receive: { summary: { enabled: false } } } },
    });
    expect(account.receive.summary.enabled).toBe(false);
  });

  it("falls back to the built-in command words when `commands` is empty", () => {
    const account = resolveSnowLumaAccount({
      channels: { snowluma: { wsUrl: "ws://x/", receive: { summary: { commands: [] } } } },
    });
    expect(account.receive.summary.commands).toEqual(["/summary", "/总结"]);
  });

  it("caps the default count at maxCount", () => {
    const account = resolveSnowLumaAccount({
      channels: { snowluma: { wsUrl: "ws://x/", receive: { summary: { count: 500, maxCount: 150 } } } },
    });
    expect(account.receive.summary.count).toBe(150);
  });
});

// ── dispatch of a summary batch ─────────────────────────────────────────

function summaryBatch(overrides: Partial<AggregatedBatch> = {}): AggregatedBatch {
  return {
    kind: "summary",
    peerId: "group:888",
    peerKind: "group",
    groupId: 888,
    messages: [
      makeMsg({ messageId: 1, senderId: 10001, senderName: "张三", text: "今天开会吗", time: 1_700_000_001 }),
      makeMsg({ messageId: 2, senderId: 10002, senderName: "李四", text: "下午三点", time: 1_700_000_002 }),
    ],
    commandMessage: makeMsg({ messageId: 500, senderId: 10003, senderName: "王五", text: "/summary" }),
    trigger: { triggered: true, reason: "summary" },
    reason: "command",
    ...overrides,
  };
}

describe("dispatchBatch — summary batches", () => {
  it("composes the summary prompt over the transcript", () => {
    const account = makeAccount();
    const composed = buildBatchBody(summaryBatch(), account, "");
    expect(composed.body.startsWith(account.receive.summary.prompt)).toBe(true);
    expect(composed.body).toContain("张三(10001): 今天开会吗");
    expect(composed.body).toContain("李四(10002): 下午三点");
    // Synthetic prompt ⇒ nothing for the command parser to look at.
    expect(composed.rawBody).toBe("");
    expect(composed.commandBody).toBe("");
  });

  it("uses the summary prompt, not the digest one", () => {
    const account = makeAccount({ summary: { prompt: "SUMMARY-PROMPT" } });
    account.receive.digest.prompt = "DIGEST-PROMPT";
    const body = buildBatchBody(summaryBatch(), account, "").body;
    expect(body).toContain("SUMMARY-PROMPT");
    expect(body).not.toContain("DIGEST-PROMPT");
  });

  it("trims the transcript to the summary's own maxTranscriptChars", () => {
    const account = makeAccount({ summary: { maxTranscriptChars: 60 } });
    const body = buildBatchBody(summaryBatch(), account, "").body;
    const transcript = body.slice(account.receive.summary.prompt.length + 2);
    expect(transcript.length).toBeLessThanOrEqual(60);
  });

  it("attributes the turn to the commanding user and quote-replies to the command", async () => {
    const { runtime, state } = createMockRuntime({ nextDeliverPayload: { text: "会议定在下午三点" } });
    const send = { sendText: vi.fn(async () => ({ messageIds: ["m"] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };

    await dispatchBatch(summaryBatch(), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
    });

    expect(state.lastFinalizeArgs.SenderId).toBe("10003");
    expect(state.lastFinalizeArgs.SenderName).toBe("王五");
    expect(state.lastFinalizeArgs.MessageSid).toBe("500");
    // No sender attribution in the envelope: the body is our prompt, not
    // something the last speaker said.
    expect(state.lastEnvelopeArgs.from).toBe("");
    expect(state.lastEnvelopeArgs.sender).toBeUndefined();
    expect(send.sendText.mock.calls[0]![0]).toMatchObject({ replyToId: 500, text: "会议定在下午三点" });
  });

  it("never authorizes commands from a summary turn", async () => {
    const { runtime, state } = createMockRuntime();
    await dispatchBatch(summaryBatch(), {
      account: makeAccount({ allowFrom: ["*"] }),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) } as never,
    });

    expect(state.lastFinalizeArgs.CommandAuthorized).toBe(false);
    expect(state.lastFinalizeArgs).not.toHaveProperty("CommandSource");
  });

  it("does NOT suppress a reply of SKIP (unlike a digest)", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "SKIP" } });
    const send = { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };

    await dispatchBatch(summaryBatch(), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
    });

    expect(send.sendText).toHaveBeenCalledTimes(1);
  });

  it("flattens the reply's Markdown before sending (QQ renders none of it)", async () => {
    const { runtime } = createMockRuntime({
      nextDeliverPayload: { text: "## 今日总结\n\n- **周四** 发版\n- 见 `release.md`" },
    });
    const send = { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };

    await dispatchBatch(summaryBatch(), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
    });

    const sent = (send.sendText.mock.calls[0]![0] as { text: string }).text;
    expect(sent).toBe("【今日总结】\n\n• 周四 发版\n• 见 release.md");
    expect(sent).not.toContain("##");
    expect(sent).not.toContain("**");
  });

  it("leaves a realtime reply's Markdown untouched", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "**普通对话回复**" } });
    const send = { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };

    await dispatchBatch(summaryBatch({ kind: "realtime", commandMessage: undefined }), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
    });

    expect((send.sendText.mock.calls[0]![0] as { text: string }).text).toBe("**普通对话回复**");
  });

  it("sends nothing when the reply flattens to an empty string", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "```\n```" } });
    const send = { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };
    const info: string[] = [];

    await dispatchBatch(summaryBatch(), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
      log: { info: (m) => info.push(m) },
    });

    expect(send.sendText).not.toHaveBeenCalled();
    expect(info.join("\n")).toContain("empty after markdown flattening");
  });

  it("omits the quote-reply when replyToTrigger is off", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "总结" } });
    const send = { sendText: vi.fn(async () => ({ messageIds: [] })), sendMedia: vi.fn(async () => ({ messageIds: [] })) };

    await dispatchBatch(summaryBatch(), {
      account: makeAccount({ replyToTrigger: false }),
      cfg,
      client: makeClient(),
      runtime: runtime as never,
      send: send as never,
    });

    expect((send.sendText.mock.calls[0]![0] as { replyToId?: number }).replyToId).toBeUndefined();
  });
});
