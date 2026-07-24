import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import type { AggregatedBatch } from "../src/aggregator.js";
import { QUOTE_DEFAULTS, RECEIVE_DEFAULTS } from "../src/config.js";
import { buildBatchBody, dispatchBatch, resolveInboundCommandAuthorization } from "../src/dispatch.js";
import type {
  NormalizedMessage,
  ResolvedQuote,
  ResolvedReceiveConfig,
  ResolvedSnowLumaAccount,
} from "../src/types.js";
import { createMockRuntime } from "./helpers/mock-runtime.js";

// ── fixtures ────────────────────────────────────────────────────────────

function cloneReceive(): ResolvedReceiveConfig {
  return JSON.parse(JSON.stringify(RECEIVE_DEFAULTS));
}

function makeAccount(
  overrides: Partial<Omit<ResolvedSnowLumaAccount, "receive">> & {
    digest?: Partial<ResolvedReceiveConfig["digest"]>;
  } = {},
): ResolvedSnowLumaAccount {
  const { digest, ...rest } = overrides;
  const receive = cloneReceive();
  if (digest) Object.assign(receive.digest, digest);

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
    reconnect: { enabled: true, retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30_000 },
    receive,
    quote: { ...QUOTE_DEFAULTS },
    toolsEnabled: true,
    config: {},
    ...rest,
  };
}

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    peerId: "group:888",
    peerKind: "group",
    groupId: 888,
    senderId: 10001,
    senderName: "张三",
    selfId: 999,
    messageId: 500,
    time: 1_700_000_000,
    text: "hello",
    rawText: "hello",
    segments: [{ type: "text", data: { text: "hello" } }],
    mentions: [],
    atAll: false,
    imageUrls: [],
    recordUrls: [],
    replyToId: undefined,
    forwardIds: [],
    ...overrides,
  };
}

function makeBatch(overrides: Partial<AggregatedBatch> = {}): AggregatedBatch {
  return {
    kind: "realtime",
    peerId: "group:888",
    peerKind: "group",
    groupId: 888,
    messages: [makeMsg()],
    trigger: { triggered: true, reason: "mention" },
    reason: "quiet",
    ...overrides,
  };
}

function makeClient(): SnowLumaApiClient {
  // dispatch.ts never calls client methods directly — it only forwards the
  // client to `send.sendText`/`send.sendMedia`/`resolveQuote`, all of which
  // are faked in these tests. A structural stub is enough.
  return {} as unknown as SnowLumaApiClient;
}

function makeSend() {
  return {
    sendText: vi.fn(async (_params: unknown) => ({ messageIds: ["out-1"] })),
    sendMedia: vi.fn(async (_params: unknown) => ({ messageIds: ["out-media-1"] })),
  };
}

const cfg = {} as OpenClawConfig;

// ── resolveInboundCommandAuthorization ─────────────────────────────────

describe("resolveInboundCommandAuthorization", () => {
  it("delegates to the runtime's authorizer gate when present", () => {
    const runtime = {
      channel: {
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn(({ authorizers }: any) =>
            authorizers.some((e: any) => e.allowed),
          ),
        },
      },
    } as unknown as PluginRuntime;

    expect(
      resolveInboundCommandAuthorization({
        runtime,
        cfg: { commands: { useAccessGroups: true } } as OpenClawConfig,
        allowFrom: ["group:1"],
        peerId: "group:1",
      }),
    ).toBe(true);

    expect(
      resolveInboundCommandAuthorization({
        runtime,
        cfg: { commands: { useAccessGroups: true } } as OpenClawConfig,
        allowFrom: ["group:1"],
        peerId: "group:2",
      }),
    ).toBe(false);
  });

  it("falls back to a plain allowFrom check when the runtime has no authorizer gate", () => {
    const runtime = { channel: {} } as unknown as PluginRuntime;

    expect(
      resolveInboundCommandAuthorization({ runtime, cfg: {} as OpenClawConfig, allowFrom: ["*"], peerId: "group:1" }),
    ).toBe(true);

    expect(
      resolveInboundCommandAuthorization({
        runtime,
        cfg: {} as OpenClawConfig,
        allowFrom: undefined,
        peerId: "group:1",
      }),
    ).toBe(false);
  });
});

// ── buildBatchBody ──────────────────────────────────────────────────────

describe("buildBatchBody", () => {
  it("joins realtime messages by newline and strips a leading @bot mention", () => {
    const account = makeAccount({ selfId: 999 });
    const batch = makeBatch({
      messages: [
        makeMsg({
          segments: [
            { type: "at", data: { qq: "999", name: "机器人" } },
            { type: "text", data: { text: " 你好" } },
          ],
        }),
        makeMsg({ segments: [{ type: "text", data: { text: "在吗" } }] }),
      ],
    });

    const composed = buildBatchBody(batch, account, "");
    expect(composed.body).toBe("你好\n在吗");
    expect(composed.rawBody).toBe("你好\n在吗");
    expect(composed.commandBody).toBe("你好\n在吗");
  });

  it("prepends quote text only to body, not to rawBody/commandBody", () => {
    const account = makeAccount();
    const batch = makeBatch({ messages: [makeMsg({ segments: [{ type: "text", data: { text: "回复" } }] })] });
    const composed = buildBatchBody(batch, account, "[引用 某人：原文]");
    expect(composed.body).toBe("[引用 某人：原文]\n回复");
    expect(composed.rawBody).toBe("回复");
    expect(composed.commandBody).toBe("回复");
  });

  it("collects imageUrls across every realtime message", () => {
    const account = makeAccount();
    const batch = makeBatch({
      messages: [makeMsg({ imageUrls: ["a.png"] }), makeMsg({ imageUrls: ["b.png", "c.png"] })],
    });
    expect(buildBatchBody(batch, account, "").imageUrls).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("builds a digest body from the prompt plus an oldest-first transcript, with empty rawBody/commandBody/imageUrls", () => {
    const account = makeAccount();
    const batch = makeBatch({
      kind: "digest",
      trigger: undefined,
      messages: [
        makeMsg({ senderId: 1, senderName: "甲", time: 1_700_000_000, segments: [{ type: "text", data: { text: "早上好" } }] }),
        makeMsg({ senderId: 2, senderName: "乙", time: 1_700_000_060, segments: [{ type: "text", data: { text: "今天天气不错" } }] }),
      ],
    });

    const composed = buildBatchBody(batch, account, "ignored-for-digest");
    expect(composed.body.startsWith(account.receive.digest.prompt)).toBe(true);
    expect(composed.body).toContain("甲(1)");
    expect(composed.body).toContain("乙(2)");
    expect(composed.body.indexOf("甲(1)")).toBeLessThan(composed.body.indexOf("乙(2)"));
    expect(composed.rawBody).toBe("");
    expect(composed.commandBody).toBe("");
    expect(composed.imageUrls).toEqual([]);
  });

  it("trims the oldest transcript lines to respect maxTranscriptChars", () => {
    const account = makeAccount({ digest: { maxTranscriptChars: 40 } });
    const batch = makeBatch({
      kind: "digest",
      trigger: undefined,
      messages: [
        makeMsg({ senderId: 1, senderName: "甲", time: 1_700_000_000, segments: [{ type: "text", data: { text: "A".repeat(20) } }] }),
        makeMsg({ senderId: 2, senderName: "乙", time: 1_700_000_060, segments: [{ type: "text", data: { text: "B".repeat(20) } }] }),
      ],
    });

    const composed = buildBatchBody(batch, account, "");
    expect(composed.body).not.toContain("A".repeat(20));
    expect(composed.body).toContain("B".repeat(20));
  });
});

// ── dispatchBatch — realtime ────────────────────────────────────────────

describe("dispatchBatch — realtime", () => {
  it("records inbound/outbound activity and wires route/envelope/finalize with the expected arguments", async () => {
    const { runtime, state } = createMockRuntime();
    const send = makeSend();
    const account = makeAccount();
    const batch = makeBatch({ messages: [makeMsg({ messageId: 42, segments: [{ type: "text", data: { text: "帮我查天气" } }] })] });

    await dispatchBatch(batch, { account, cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect(state.recordedActivity[0]).toEqual({ channel: "snowluma", accountId: "default", direction: "inbound" });
    expect(state.recordedActivity[1]).toEqual({ channel: "snowluma", accountId: "default", direction: "outbound" });

    expect(state.lastRouteArgs).toMatchObject({
      channel: "snowluma",
      accountId: "default",
      peer: { kind: "group", id: "group:888" },
    });

    expect(state.lastEnvelopeArgs).toMatchObject({
      channel: "SnowLuma",
      from: "张三",
      chatType: "group",
      body: "帮我查天气",
      sender: { id: "10001", name: "张三" },
    });

    expect(state.lastFinalizeArgs).toMatchObject({
      RawBody: "帮我查天气",
      CommandBody: "帮我查天气",
      From: "snowluma:group:888",
      To: "snowluma:group:888",
      SessionKey: "session:test",
      AccountId: "default",
      ChatType: "group",
      SenderId: "10001",
      SenderName: "张三",
      Provider: "snowluma",
      Surface: "snowluma",
      MessageSid: "42",
      CommandSource: "text",
      OriginatingChannel: "snowluma",
      OriginatingTo: "snowluma:group:888",
    });

    expect(send.sendText).toHaveBeenCalledTimes(1);
    expect(send.sendText.mock.calls[0]![0]).toMatchObject({ to: "snowluma:group:888", text: "mock-reply" });
  });

  it("uses the last message's id for MessageSid when several messages are batched", async () => {
    const { runtime, state } = createMockRuntime();
    const batch = makeBatch({
      messages: [
        makeMsg({ messageId: 1, segments: [{ type: "text", data: { text: "first" } }] }),
        makeMsg({ messageId: 2, segments: [{ type: "text", data: { text: "second" } }] }),
      ],
    });

    await dispatchBatch(batch, { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send: makeSend() });

    expect(state.lastFinalizeArgs.MessageSid).toBe("2");
    expect(state.lastEnvelopeArgs.body).toBe("first\nsecond");
  });

  it("resolves quote context for the last message with a replyToId/forwardIds and prepends it to body only", async () => {
    const { runtime, state } = createMockRuntime();
    const resolvedQuote: ResolvedQuote = {
      messageId: "1",
      senderId: 7,
      senderName: "李四",
      time: 1_700_000_000,
      text: "原始消息",
      forwardNodes: [],
      truncated: false,
    };
    const resolveQuote = vi.fn(async () => resolvedQuote);
    const quotedMsg = makeMsg({ messageId: 10, replyToId: "1", segments: [{ type: "text", data: { text: "回复内容" } }] });
    const batch = makeBatch({
      messages: [makeMsg({ messageId: 9, segments: [{ type: "text", data: { text: "第一条" } }] }), quotedMsg],
    });

    await dispatchBatch(batch, {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as unknown as PluginRuntime,
      send: makeSend(),
      resolveQuote,
    });

    expect(resolveQuote).toHaveBeenCalledTimes(1);
    expect(resolveQuote.mock.calls[0]![0]).toBe(quotedMsg);

    const body = state.lastEnvelopeArgs.body as string;
    expect(body.startsWith("[引用")).toBe(true);
    expect(body).toContain("原始消息");
    expect(body).toContain("第一条\n回复内容");
    expect(state.lastFinalizeArgs.RawBody).toBe("第一条\n回复内容");
  });

  it("forwards image URLs onto the finalized context as MediaUrl/MediaUrls", async () => {
    const { runtime, state } = createMockRuntime();
    const batch = makeBatch({ messages: [makeMsg({ imageUrls: ["https://x/a.png", "https://x/b.png"] })] });

    await dispatchBatch(batch, { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send: makeSend() });

    expect(state.lastFinalizeArgs.MediaUrl).toBe("https://x/a.png");
    expect(state.lastFinalizeArgs.MediaUrls).toEqual(["https://x/a.png", "https://x/b.png"]);
  });
});

// ── dispatchBatch — CommandAuthorized ───────────────────────────────────

describe("dispatchBatch — CommandAuthorized", () => {
  it("is true for a realtime batch whose peer is allow-listed", async () => {
    const { runtime, state } = createMockRuntime();
    const account = makeAccount({ allowFrom: ["group:888"] });

    await dispatchBatch(makeBatch(), {
      account,
      cfg: { commands: { useAccessGroups: false } } as OpenClawConfig,
      client: makeClient(),
      runtime: runtime as unknown as PluginRuntime,
      send: makeSend(),
    });

    expect(state.lastFinalizeArgs.CommandAuthorized).toBe(true);
  });

  it("is false for a realtime batch whose peer is not allow-listed", async () => {
    const { runtime, state } = createMockRuntime();
    const account = makeAccount({ allowFrom: ["group:999"] });

    await dispatchBatch(makeBatch(), {
      account,
      cfg: { commands: { useAccessGroups: false } } as OpenClawConfig,
      client: makeClient(),
      runtime: runtime as unknown as PluginRuntime,
      send: makeSend(),
    });

    expect(state.lastFinalizeArgs.CommandAuthorized).toBe(false);
  });

  it("is always false for a digest batch — and CommandSource is omitted — even when the authorizer gate would allow it", async () => {
    const { runtime, state } = createMockRuntime({ commandAuthorizedOverride: true });
    const account = makeAccount({ allowFrom: ["group:888"] });
    const batch = makeBatch({ kind: "digest", trigger: undefined });

    await dispatchBatch(batch, { account, cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send: makeSend() });

    // A digest turn summarises a chat window rather than acting on one
    // sender's instruction; it must never be able to run a privileged text
    // command, so this stays false no matter what the authorizer gate says.
    expect(state.lastFinalizeArgs.CommandAuthorized).toBe(false);
    expect("CommandSource" in state.lastFinalizeArgs).toBe(false);
  });
});

// ── dispatchBatch — digest ───────────────────────────────────────────────

describe("dispatchBatch — digest", () => {
  it("sends nothing (neither text nor media) when the reply trims to SKIP, case-insensitively", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "  skip  ", mediaUrls: ["should-not-send.png"] } });
    const send = makeSend();
    const batch = makeBatch({ kind: "digest", trigger: undefined });

    await dispatchBatch(batch, { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect(send.sendText).not.toHaveBeenCalled();
    expect(send.sendMedia).not.toHaveBeenCalled();
  });

  it("sends a non-SKIP digest reply normally", async () => {
    const { runtime } = createMockRuntime({ nextDeliverPayload: { text: "本群讨论了周会安排。" } });
    const send = makeSend();
    const batch = makeBatch({ kind: "digest", trigger: undefined });

    await dispatchBatch(batch, { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect(send.sendText).toHaveBeenCalledTimes(1);
    expect(send.sendText.mock.calls[0]![0]).toMatchObject({ text: "本群讨论了周会安排。" });
  });

  it("does not resolve quote context for a digest batch", async () => {
    const { runtime } = createMockRuntime();
    const resolveQuote = vi.fn(async () => null);
    const batch = makeBatch({
      kind: "digest",
      trigger: undefined,
      messages: [makeMsg({ replyToId: "1" })],
    });

    await dispatchBatch(batch, {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as unknown as PluginRuntime,
      send: makeSend(),
      resolveQuote,
    });

    expect(resolveQuote).not.toHaveBeenCalled();
  });
});

// ── dispatchBatch — reply-to-trigger quoting ────────────────────────────

describe("dispatchBatch — reply-to-trigger quoting", () => {
  it("quote-replies to the triggering (first) message when replyToTrigger is enabled", async () => {
    const { runtime } = createMockRuntime();
    const send = makeSend();
    const account = makeAccount({ replyToTrigger: true });
    const batch = makeBatch({ messages: [makeMsg({ messageId: 111 }), makeMsg({ messageId: 112 })] });

    await dispatchBatch(batch, { account, cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect(send.sendText.mock.calls[0]![0]).toMatchObject({ replyToId: 111 });
  });

  it("does not quote-reply when replyToTrigger is disabled", async () => {
    const { runtime } = createMockRuntime();
    const send = makeSend();
    const account = makeAccount({ replyToTrigger: false });

    await dispatchBatch(makeBatch(), { account, cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect((send.sendText.mock.calls[0]![0] as any).replyToId).toBeUndefined();
  });

  it("never quote-replies on a digest batch, even when replyToTrigger is enabled", async () => {
    const { runtime } = createMockRuntime();
    const send = makeSend();
    const account = makeAccount({ replyToTrigger: true });
    const batch = makeBatch({ kind: "digest", trigger: undefined });

    await dispatchBatch(batch, { account, cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect((send.sendText.mock.calls[0]![0] as any).replyToId).toBeUndefined();
  });
});

// ── dispatchBatch — delivery ordering & error handling ──────────────────

describe("dispatchBatch — delivery", () => {
  it("sends media before text, in order, for a single payload carrying both", async () => {
    const order: string[] = [];
    const { runtime } = createMockRuntime({
      nextDeliverPayload: { text: "看这个", mediaUrls: ["a.png", "b.png"] },
    });
    const send = {
      sendText: vi.fn(async (_p: any) => {
        order.push("text");
        return { messageIds: ["t1"] };
      }),
      sendMedia: vi.fn(async (p: any) => {
        order.push(`media:${p.mediaPath}`);
        return { messageIds: ["m1"] };
      }),
    };

    await dispatchBatch(makeBatch(), { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    expect(order).toEqual(["media:a.png", "media:b.png", "text"]);
  });

  it("onError logs and best-effort sends a truncated error notice", async () => {
    const { runtime } = createMockRuntime({ nextError: new Error("boom") });
    const send = makeSend();
    const errors: string[] = [];

    await dispatchBatch(makeBatch(), {
      account: makeAccount(),
      cfg,
      client: makeClient(),
      runtime: runtime as unknown as PluginRuntime,
      send,
      log: { error: (m) => errors.push(m) },
    });

    expect(send.sendText).toHaveBeenCalledTimes(1);
    const sentText = send.sendText.mock.calls[0]![0].text as string;
    expect(sentText.startsWith("[OpenClaw] Error: ")).toBe(true);
    expect(sentText).toContain("boom");
    expect(errors.some((m) => m.includes("dispatch error"))).toBe(true);
  });

  it("truncates the error notice body to 500 characters", async () => {
    const longMessage = "x".repeat(1000);
    const { runtime } = createMockRuntime({ nextError: new Error(longMessage) });
    const send = makeSend();

    await dispatchBatch(makeBatch(), { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send });

    const prefix = "[OpenClaw] Error: ";
    const sentText = send.sendText.mock.calls[0]![0].text as string;
    expect(sentText.startsWith(prefix)).toBe(true);
    expect(sentText.length - prefix.length).toBeLessThanOrEqual(500);
  });

  it("does not throw (and still records nothing further) when sendText rejects", async () => {
    const { runtime } = createMockRuntime();
    const send = {
      sendText: vi.fn(async () => {
        throw new Error("network down");
      }),
      sendMedia: vi.fn(async (_p: unknown) => ({ messageIds: [] })),
    };

    await expect(
      dispatchBatch(makeBatch(), { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send }),
    ).resolves.toBeUndefined();
  });
});

// ── dispatchBatch — never rejects ────────────────────────────────────────

describe("dispatchBatch — never rejects", () => {
  it("resolves even when no runtime is injected and none is globally configured", async () => {
    const send = makeSend();

    await expect(
      dispatchBatch(makeBatch(), { account: makeAccount(), cfg, client: makeClient(), send }),
    ).resolves.toBeUndefined();

    expect(send.sendText).not.toHaveBeenCalled();
  });

  it("resolves even when an empty batch is passed", async () => {
    const { runtime } = createMockRuntime();
    const send = makeSend();
    const batch = makeBatch({ messages: [] });

    await expect(
      dispatchBatch(batch, { account: makeAccount(), cfg, client: makeClient(), runtime: runtime as unknown as PluginRuntime, send }),
    ).resolves.toBeUndefined();
    expect(send.sendText).not.toHaveBeenCalled();
  });
});
