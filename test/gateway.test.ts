import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { __resetActionClients, tryGetActionClient } from "../src/client.js";
import { QUOTE_DEFAULTS, RECEIVE_DEFAULTS } from "../src/config.js";
import type { AggregatedBatch } from "../src/aggregator.js";
import type { DispatchDeps } from "../src/dispatch.js";
import { createSelfMessageTracker, startGateway } from "../src/gateway.js";
import type { ResolvedReceiveConfig, ResolvedSnowLumaAccount } from "../src/types.js";

// ── fixtures ────────────────────────────────────────────────────────────

function cloneReceive(): ResolvedReceiveConfig {
  return JSON.parse(JSON.stringify(RECEIVE_DEFAULTS));
}

function makeAccount(
  overrides: Partial<Omit<ResolvedSnowLumaAccount, "receive">> & {
    mention?: Partial<ResolvedReceiveConfig["mention"]>;
    digest?: Partial<ResolvedReceiveConfig["digest"]>;
    realtime?: Partial<ResolvedReceiveConfig["realtime"]>;
  } = {},
): ResolvedSnowLumaAccount {
  const { mention, digest, realtime, ...rest } = overrides;
  const receive = cloneReceive();
  if (mention) Object.assign(receive.mention, mention);
  if (digest) Object.assign(receive.digest, digest);
  if (realtime) Object.assign(receive.realtime, realtime);

  return {
    accountId: "default",
    enabled: true,
    wsUrl: "ws://127.0.0.1:3001/",
    selfId: undefined,
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

function makeGroupEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 888,
    user_id: 10001,
    self_id: 999,
    message_id: 500,
    time: 1_700_000_000,
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
    sender: { nickname: "张三", card: "" },
    ...overrides,
  };
}

function makePrivateEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "private",
    user_id: 20002,
    self_id: 999,
    message_id: 600,
    time: 1_700_000_000,
    message: [{ type: "text", data: { text: "hi" } }],
    raw_message: "hi",
    sender: { nickname: "李四" },
    ...overrides,
  };
}

interface FakeClient {
  client: SnowLumaWebSocketClient;
  emit: (event: unknown) => void;
  emitOn: (name: string, payload?: unknown) => void;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getLoginInfo: ReturnType<typeof vi.fn>;
  setMsgEmojiLike: ReturnType<typeof vi.fn>;
  sendGroupMessage: ReturnType<typeof vi.fn>;
  sendPrivateMessage: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  opts: { getLoginInfo?: () => Promise<{ user_id: number; nickname: string }> } = {},
): FakeClient {
  const messageHandlers: Array<(event: unknown) => void> = [];
  const onHandlers = new Map<string, Array<(payload: unknown) => void>>();
  let nextMessageId = 700;

  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const on = vi.fn((event: string, listener: (payload: unknown) => void) => {
    const list = onHandlers.get(event) ?? [];
    list.push(listener);
    onHandlers.set(event, list);
    return () => {
      onHandlers.set(event, (onHandlers.get(event) ?? []).filter((l) => l !== listener));
    };
  });
  const onMessage = vi.fn((handler: (event: unknown) => void) => {
    messageHandlers.push(handler);
    return () => {
      const idx = messageHandlers.indexOf(handler);
      if (idx >= 0) messageHandlers.splice(idx, 1);
    };
  });
  const getLoginInfo =
    opts.getLoginInfo !== undefined
      ? vi.fn(opts.getLoginInfo)
      : vi.fn().mockResolvedValue({ user_id: 999, nickname: "bot" });
  const setMsgEmojiLike = vi.fn().mockResolvedValue(null);
  const sendGroupMessage = vi.fn(async () => ({ message_id: nextMessageId++ }));
  const sendPrivateMessage = vi.fn(async () => ({ message_id: nextMessageId++ }));

  const fake = { connect, close, on, onMessage, getLoginInfo, setMsgEmojiLike, sendGroupMessage, sendPrivateMessage };

  return {
    client: fake as unknown as SnowLumaWebSocketClient,
    emit: (event: unknown) => messageHandlers.forEach((h) => h(event)),
    emitOn: (name: string, payload?: unknown) => (onHandlers.get(name) ?? []).forEach((h) => h(payload)),
    connect,
    close,
    getLoginInfo,
    setMsgEmojiLike,
    sendGroupMessage,
    sendPrivateMessage,
  };
}

/** Flushes pending microtasks (promise chains) without touching real/fake timers. */
async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const cfg = {} as OpenClawConfig;

function makeDispatchSpy() {
  const calls: Array<{ batch: AggregatedBatch; deps: DispatchDeps }> = [];
  const fn = vi.fn(async (batch: AggregatedBatch, deps: DispatchDeps) => {
    calls.push({ batch, deps });
  });
  return { fn, calls };
}

afterEach(() => {
  __resetActionClients();
  vi.useRealTimers();
});

// ── createSelfMessageTracker ─────────────────────────────────────────────

describe("createSelfMessageTracker", () => {
  it("tracks and forgets nothing under the cap", () => {
    const tracker = createSelfMessageTracker(10);
    tracker.add("a");
    tracker.add("b");
    expect(tracker.has("a")).toBe(true);
    expect(tracker.has("b")).toBe(true);
    expect(tracker.has("c")).toBe(false);
  });

  it("evicts the oldest id once the cap is exceeded (FIFO)", () => {
    const tracker = createSelfMessageTracker(3);
    tracker.add("1");
    tracker.add("2");
    tracker.add("3");
    tracker.add("4"); // evicts "1"
    expect(tracker.has("1")).toBe(false);
    expect(tracker.has("2")).toBe(true);
    expect(tracker.has("3")).toBe(true);
    expect(tracker.has("4")).toBe(true);
  });

  it("adding an id already tracked does not bump anything else out", () => {
    const tracker = createSelfMessageTracker(2);
    tracker.add("x");
    tracker.add("y");
    tracker.add("x");
    tracker.add("z"); // evicts "x" -- it was the oldest insertion order still
    expect(tracker.has("y")).toBe(true);
  });
});

// ── startGateway — setup ──────────────────────────────────────────────────

describe("startGateway — setup", () => {
  it("throws when wsUrl is missing", async () => {
    const account = makeAccount({ wsUrl: "" });
    await expect(
      startGateway({ account, cfg, abortSignal: new AbortController().signal }),
    ).rejects.toThrow(/wsUrl/);
  });

  it("connects, auto-detects selfId, and registers the action client", async () => {
    const { client, connect, getLoginInfo } = makeFakeClient();
    const account = makeAccount({ selfId: undefined });
    const controller = new AbortController();
    const onReady = vi.fn();
    const { fn: dispatch } = makeDispatchSpy();

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch,
      onReady,
    });

    await flushMicrotasks();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(getLoginInfo).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ selfId: 999 });
    expect(tryGetActionClient("default")).toBe(client);

    controller.abort();
    await done;
  });

  it("uses the account's configured selfId instead of auto-detecting", async () => {
    const { client, getLoginInfo } = makeFakeClient();
    const account = makeAccount({ selfId: 12345 });
    const controller = new AbortController();
    const onReady = vi.fn();

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch: makeDispatchSpy().fn,
      onReady,
    });

    await flushMicrotasks();

    expect(getLoginInfo).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith({ selfId: 12345 });

    controller.abort();
    await done;
  });

  it("still becomes ready (with selfId undefined) when detection fails", async () => {
    const { client } = makeFakeClient({ getLoginInfo: () => Promise.reject(new Error("boom")) });
    const account = makeAccount({ selfId: undefined });
    const controller = new AbortController();
    const onReady = vi.fn();
    const errors: string[] = [];

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch: makeDispatchSpy().fn,
      onReady,
      log: { error: (m) => errors.push(m) },
    });

    await flushMicrotasks();

    expect(onReady).toHaveBeenCalledWith({ selfId: undefined });
    expect(errors.some((m) => m.includes("could not determine"))).toBe(true);

    controller.abort();
    await done;
  });

  it("propagates socket errors to onError", async () => {
    const { client, emitOn } = makeFakeClient();
    const account = makeAccount();
    const controller = new AbortController();
    const onError = vi.fn();

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch: makeDispatchSpy().fn,
      onError,
    });

    await flushMicrotasks();
    emitOn("error", new Error("socket blew up"));

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("socket blew up");

    controller.abort();
    await done;
  });
});

// ── startGateway — message routing ────────────────────────────────────────

describe("startGateway — message routing", () => {
  it("drops messages sent by the bot itself", async () => {
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999 });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makeGroupEvent({ user_id: 999, message: [{ type: "text", data: { text: "@999 hi" } }] }));
    await flushMicrotasks();

    controller.abort();
    await done;

    expect(calls).toHaveLength(0);
  });

  it("drops messages from peers not allowed by allowFrom", async () => {
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999, allowFrom: ["private:1"] });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makeGroupEvent({ message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "hi" } }] }));
    await flushMicrotasks();

    controller.abort();
    await done;

    expect(calls).toHaveLength(0);
  });

  it("does not dispatch an untriggered group message", async () => {
    vi.useFakeTimers();
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999, realtime: { windowMs: 20 } });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makeGroupEvent({ message: [{ type: "text", data: { text: "just chatting" } }] }));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);

    controller.abort();
    await done;

    expect(calls).toHaveLength(0);
  });

  it("dispatches a triggered group message once the realtime window flushes", async () => {
    vi.useFakeTimers();
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999, realtime: { windowMs: 20 } });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(
      makeGroupEvent({
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "在吗" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    controller.abort();
    await done;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.kind).toBe("realtime");
    expect(calls[0]!.batch.reason).toBe("quiet");
    expect(calls[0]!.batch.trigger?.reason).toBe("mention");
  });

  it("dispatches an always-on direct message immediately (realtime disabled)", async () => {
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999, realtime: { enabled: false } });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makePrivateEvent({ message: [{ type: "text", data: { text: "你好" } }] }));
    await flushMicrotasks();

    controller.abort();
    await done;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.reason).toBe("immediate");
  });

  it("fires groupAutoReact only for triggered group messages, not untriggered ones", async () => {
    vi.useFakeTimers();
    const { client, emit, setMsgEmojiLike } = makeFakeClient();
    const account = makeAccount({ selfId: 999, groupAutoReact: true, realtime: { windowMs: 20 } });
    const controller = new AbortController();
    const { fn: dispatch } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makeGroupEvent({ message_id: 1, message: [{ type: "text", data: { text: "no mention here" } }] }));
    await flushMicrotasks();
    expect(setMsgEmojiLike).not.toHaveBeenCalled();

    emit(
      makeGroupEvent({
        message_id: 2,
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "帮我" } }],
      }),
    );
    await flushMicrotasks();
    expect(setMsgEmojiLike).toHaveBeenCalledTimes(1);
    expect(setMsgEmojiLike.mock.calls[0]![0]).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await done;
  });

  it("does not groupAutoReact for a triggered direct message", async () => {
    const { client, emit, setMsgEmojiLike } = makeFakeClient();
    const account = makeAccount({ selfId: 999, groupAutoReact: true, realtime: { enabled: false } });
    const controller = new AbortController();
    const { fn: dispatch } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makePrivateEvent({ message: [{ type: "text", data: { text: "hi" } }] }));
    await flushMicrotasks();

    controller.abort();
    await done;

    expect(setMsgEmojiLike).not.toHaveBeenCalled();
  });

  it("dispatches a digest batch once the digest interval elapses, regardless of trigger", async () => {
    vi.useFakeTimers();
    const { client, emit } = makeFakeClient();
    const account = makeAccount({
      selfId: 999,
      digest: { enabled: true, intervalMs: 30, minMessages: 1, scope: "group" },
    });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(makeGroupEvent({ message: [{ type: "text", data: { text: "闲聊内容" } }] }));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    controller.abort();
    await done;

    expect(calls.some((c) => c.batch.kind === "digest")).toBe(true);
  });

  it("a rejecting injected dispatch is caught and logged, and later messages still flow", async () => {
    vi.useFakeTimers();
    const { client, emit } = makeFakeClient();
    const account = makeAccount({ selfId: 999, realtime: { windowMs: 20 } });
    const controller = new AbortController();
    const errors: string[] = [];
    let call = 0;
    const dispatch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("dispatch boom");
    });

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch,
      log: { error: (m) => errors.push(m) },
    });
    await flushMicrotasks();

    emit(
      makeGroupEvent({
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "第一条" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    emit(
      makeGroupEvent({
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "第二条" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    controller.abort();
    await done;

    expect(call).toBe(2);
    expect(errors.some((m) => m.includes("dispatch failed"))).toBe(true);
  });
});

// ── startGateway — self-message tracking ──────────────────────────────────

describe("startGateway — self-message tracking", () => {
  it("wires a tracking send into DispatchDeps so a later reply-to-self triggers", async () => {
    vi.useFakeTimers();
    const { client, emit } = makeFakeClient();
    const account = makeAccount({
      selfId: 999,
      realtime: { windowMs: 20 },
      mention: { requireMentionInGroup: true, triggerOnReplyToSelf: true },
    });
    const controller = new AbortController();
    const calls: Array<{ batch: AggregatedBatch; deps: DispatchDeps }> = [];
    let sentMessageId: string | undefined;

    const dispatch = vi.fn(async (batch: AggregatedBatch, deps: DispatchDeps) => {
      calls.push({ batch, deps });
      if (calls.length === 1) {
        const result = await deps.send!.sendText({
          client: deps.client,
          to: `snowluma:${batch.peerId}`,
          text: "bot reply",
        });
        sentMessageId = result.messageIds[0];
      }
    });

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    // First message: an explicit mention from sender A -- triggers, and the
    // dispatch's simulated reply seeds the self-message tracker.
    emit(
      makeGroupEvent({
        user_id: 10001,
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "在吗" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(sentMessageId).toBeTruthy();

    // Second message: a *different* sender replies to the bot's message id with
    // no mention and no keyword -- only triggers via reply-to-self.
    emit(
      makeGroupEvent({
        user_id: 20002,
        message_id: 999999,
        message: [{ type: "reply", data: { id: sentMessageId } }, { type: "text", data: { text: "谢谢" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    controller.abort();
    await done;

    expect(calls).toHaveLength(2);
    expect(calls[1]!.batch.trigger?.reason).toBe("reply-to-self");
  });
});

// ── startGateway — shutdown ────────────────────────────────────────────────

describe("startGateway — shutdown", () => {
  it("flushes pending windows, unregisters the action client, and closes the socket on abort", async () => {
    vi.useFakeTimers();
    const { client, emit, close } = makeFakeClient();
    const account = makeAccount({ selfId: 999, realtime: { windowMs: 5000 } });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    emit(
      makeGroupEvent({
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "在吗" } }],
      }),
    );
    await flushMicrotasks();

    // Window is still open (windowMs is 5s and no time has passed) -- abort must flush it anyway.
    expect(calls).toHaveLength(0);

    controller.abort();
    await done;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.reason).toBe("shutdown");
    expect(tryGetActionClient("default")).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resolves even when nothing was ever pending", async () => {
    const { client, close } = makeFakeClient();
    const account = makeAccount();
    const controller = new AbortController();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch: makeDispatchSpy().fn });
    await flushMicrotasks();

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ── startGateway — review regressions ─────────────────────────────────────
// Each case here reproduces a specific defect found in code review that the
// original suite did not cover.

describe("startGateway — review regressions", () => {
  it("closes the client (stopping the SDK's orphan reconnect loop) when the initial connect fails", async () => {
    const { client, connect, close } = makeFakeClient();
    connect.mockRejectedValueOnce(new Error("connect refused"));
    const account = makeAccount({ selfId: 999 });

    await expect(
      startGateway({
        account,
        cfg,
        abortSignal: new AbortController().signal,
        clientFactory: () => client,
        dispatch: makeDispatchSpy().fn,
      }),
    ).rejects.toThrow(/connect refused/);

    // Without close(), the SDK keeps reconnecting forever with no handle to stop it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(tryGetActionClient("default")).toBeUndefined();
  });

  it("still resolves on abort even if client.close() throws during shutdown", async () => {
    const { client, close } = makeFakeClient();
    close.mockImplementation(() => {
      throw new Error("close boom");
    });
    const account = makeAccount({ selfId: 999 });
    const controller = new AbortController();
    const errors: string[] = [];

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch: makeDispatchSpy().fn,
      log: { error: (m) => errors.push(m) },
    });
    await flushMicrotasks();

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(errors.some((m) => m.includes("shutdown error"))).toBe(true);
  });

  it("cleans up immediately when the abort signal is already aborted before setup finishes", async () => {
    const { client, close } = makeFakeClient();
    const account = makeAccount({ selfId: 999 });
    const controller = new AbortController();
    controller.abort(); // aborted up-front — addEventListener('abort') would never fire

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch: makeDispatchSpy().fn,
    });

    await expect(done).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(tryGetActionClient("default")).toBeUndefined();
  });

  it("drops post_type:'message_sent' self-echo even when it would otherwise trigger (and even without selfId)", async () => {
    const { client, emit } = makeFakeClient({ getLoginInfo: () => Promise.reject(new Error("no login info")) });
    const account = makeAccount({ selfId: undefined, realtime: { enabled: false } });
    const controller = new AbortController();
    const { fn: dispatch, calls } = makeDispatchSpy();

    const done = startGateway({ account, cfg, abortSignal: controller.signal, clientFactory: () => client, dispatch });
    await flushMicrotasks();

    // A private message the bot itself sent, echoed back. selfId is unknown, so
    // the senderId===selfId guard can't catch it — the post_type check must.
    emit(makePrivateEvent({ post_type: "message_sent", message: [{ type: "text", data: { text: "echoed" } }] }));
    await flushMicrotasks();

    controller.abort();
    await done;

    expect(calls).toHaveLength(0);
  });

  it("does not leak an unhandled rejection when a groupAutoReact failure handler's logger throws", async () => {
    vi.useFakeTimers();
    const { client, emit, setMsgEmojiLike } = makeFakeClient();
    setMsgEmojiLike.mockRejectedValue(new Error("react rejected"));
    const account = makeAccount({ selfId: 999, groupAutoReact: true, realtime: { windowMs: 20 } });
    const controller = new AbortController();
    const { fn: dispatch } = makeDispatchSpy();

    const done = startGateway({
      account,
      cfg,
      abortSignal: controller.signal,
      clientFactory: () => client,
      dispatch,
      // A logger that itself throws — the fire-and-forget react path must swallow it.
      log: {
        error: () => {
          throw new Error("logger blew up");
        },
      },
    });
    await flushMicrotasks();

    emit(
      makeGroupEvent({
        message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "帮我" } }],
      }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
