import { describe, expect, it, vi } from "vitest";
import { createAggregator } from "../src/aggregator.js";
import type { AggregatedBatch } from "../src/aggregator.js";
import { QUOTE_DEFAULTS, RECEIVE_DEFAULTS } from "../src/config.js";
import type {
  NormalizedMessage,
  ResolvedReceiveConfig,
  ResolvedSnowLumaAccount,
  TriggerDecision,
} from "../src/types.js";

// ── deterministic fake clock, injected via AggregatorOptions ───────────────

function createFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map<number, { time: number; fn: () => void }>();

  function setTimeoutFn(fn: () => void, ms: number): unknown {
    const id = nextId++;
    timers.set(id, { time: currentTime + Math.max(0, ms), fn });
    return id;
  }

  function clearTimeoutFn(handle: unknown): void {
    timers.delete(handle as number);
  }

  function now(): number {
    return currentTime;
  }

  /** Advance the clock by `ms`, firing every timer due along the way, in order. */
  function advance(ms: number): void {
    const target = currentTime + ms;
    for (;;) {
      let next: [number, { time: number; fn: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].time <= target && (!next || entry[1].time < next[1].time)) {
          next = entry;
        }
      }
      if (!next) break;
      timers.delete(next[0]);
      currentTime = next[1].time;
      next[1].fn();
    }
    currentTime = target;
  }

  return { setTimeoutFn, clearTimeoutFn, now, advance };
}

// ── fixtures ────────────────────────────────────────────────────────────

function cloneReceive(): ResolvedReceiveConfig {
  return JSON.parse(JSON.stringify(RECEIVE_DEFAULTS));
}

function makeAccount(overrides: {
  selfId?: number;
  digest?: Partial<ResolvedReceiveConfig["digest"]>;
  realtime?: Partial<ResolvedReceiveConfig["realtime"]>;
  history?: Partial<ResolvedReceiveConfig["history"]>;
} = {}): ResolvedSnowLumaAccount {
  const receive = cloneReceive();
  Object.assign(receive.digest, overrides.digest);
  Object.assign(receive.realtime, overrides.realtime);
  Object.assign(receive.history, overrides.history);

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
    debug: false,
    reconnect: { enabled: true, retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30_000 },
    receive,
    quote: JSON.parse(JSON.stringify(QUOTE_DEFAULTS)),
    toolsEnabled: true,
    config: {},
  };
}

let messageIdCounter = 1;

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    peerId: "group:2001",
    peerKind: "group",
    groupId: 2001,
    senderId: 1001,
    senderName: "Alice",
    selfId: 9000,
    messageId: messageIdCounter++,
    time: 1_700_000_000,
    text: "hello",
    rawText: "hello",
    segments: [],
    mentions: [],
    atAll: false,
    imageUrls: [],
    recordUrls: [],
    forwardIds: [],
    ...overrides,
  };
}

const TRIGGERED: TriggerDecision = { triggered: true, reason: "mention" };
const NOT_TRIGGERED: TriggerDecision = { triggered: false };

// ── realtime engine ─────────────────────────────────────────────────────

describe("aggregator: realtime engine", () => {
  it("coalesces three messages within the window into one batch", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const msg1 = makeMessage({ text: "one" });
    agg.accept(msg1, TRIGGERED);
    clock.advance(100);
    const msg2 = makeMessage({ text: "two" });
    agg.accept(msg2, NOT_TRIGGERED);
    clock.advance(100);
    const msg3 = makeMessage({ text: "three" });
    agg.accept(msg3, NOT_TRIGGERED);

    expect(onFlush).not.toHaveBeenCalled();
    clock.advance(800); // windowMs default — quiet period since msg3

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.kind).toBe("realtime");
    expect(batch.reason).toBe("quiet");
    expect(batch.messages).toEqual([msg1, msg2, msg3]);
    expect(batch.trigger).toEqual(TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toEqual([]);
  });

  it("flushes on a quiet gap longer than windowMs", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const msg = makeMessage();
    agg.accept(msg, TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toEqual(["group:2001::1001"]);

    clock.advance(799);
    expect(onFlush).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].reason).toBe("quiet");
    expect(onFlush.mock.calls[0][0].messages).toEqual([msg]);
  });

  it("maxWindowMs caps a continuous stream even if it stays quiet-busy", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ realtime: { windowMs: 800, maxWindowMs: 2000, maxMessages: 100, maxChars: 100_000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const messages: NormalizedMessage[] = [];
    const first = makeMessage({ text: "m0" });
    messages.push(first);
    agg.accept(first, TRIGGERED);

    // Keep resetting the quiet timer every 500ms (< windowMs) so it never
    // fires on its own — only the 2000ms maxWindowMs ceiling should flush.
    for (let i = 1; i <= 3; i++) {
      clock.advance(500);
      const m = makeMessage({ text: `m${i}` });
      messages.push(m);
      agg.accept(m, NOT_TRIGGERED);
    }

    expect(onFlush).not.toHaveBeenCalled();
    clock.advance(500); // total elapsed since open: 2000ms

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("max-window");
    expect(batch.messages).toEqual(messages);
  });

  it("maxMessages forces an early, synchronous flush", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ realtime: { maxMessages: 3, maxChars: 100_000, windowMs: 5000, maxWindowMs: 60_000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "a" }), TRIGGERED);
    agg.accept(makeMessage({ text: "b" }), NOT_TRIGGERED);
    expect(onFlush).not.toHaveBeenCalled();
    agg.accept(makeMessage({ text: "c" }), NOT_TRIGGERED);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("max-messages");
    expect(batch.messages).toHaveLength(3);
  });

  it("maxChars forces an early, synchronous flush", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ realtime: { maxChars: 10, maxMessages: 1000, windowMs: 5000, maxWindowMs: 60_000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "hello!" }), TRIGGERED); // 6 chars, under cap
    expect(onFlush).not.toHaveBeenCalled();
    agg.accept(makeMessage({ text: "world!" }), NOT_TRIGGERED); // 12 chars total, over cap

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("max-chars");
    expect(batch.messages).toHaveLength(2);
  });

  it("an untriggered message alone opens nothing", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage(), NOT_TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toEqual([]);
    clock.advance(10_000);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("an untriggered message joins an already-open window", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "trigger" }), TRIGGERED);
    agg.accept(makeMessage({ text: "follow-up" }), NOT_TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toEqual(["group:2001::1001"]);

    clock.advance(800);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].messages).toHaveLength(2);
  });

  it("realtime.enabled:false flushes triggered messages immediately with reason 'immediate', and never opens a window", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ realtime: { enabled: false } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "untriggered" }), NOT_TRIGGERED);
    expect(onFlush).not.toHaveBeenCalled();
    expect(agg.pendingRealtimeKeys()).toEqual([]);

    const msg = makeMessage({ text: "triggered" });
    agg.accept(msg, TRIGGERED);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("immediate");
    expect(batch.messages).toEqual([msg]);
    expect(agg.pendingRealtimeKeys()).toEqual([]);
  });
});

// ── digest engine ───────────────────────────────────────────────────────

describe("aggregator: digest engine", () => {
  it("flushes on maxMessages", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, maxMessages: 3, minMessages: 1, intervalMs: 100_000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "a" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "b" }), NOT_TRIGGERED);
    expect(onFlush).not.toHaveBeenCalled();
    agg.accept(makeMessage({ text: "c" }), NOT_TRIGGERED);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.kind).toBe("digest");
    expect(batch.reason).toBe("max-messages");
    expect(batch.trigger).toBeUndefined();
    expect(batch.messages).toHaveLength(3);
  });

  it("flushes on intervalMs once minMessages is met", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, maxMessages: 100, minMessages: 1, intervalMs: 5000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "a" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "b" }), NOT_TRIGGERED);
    clock.advance(4999);
    expect(onFlush).not.toHaveBeenCalled();
    clock.advance(1);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("interval");
    expect(batch.messages).toHaveLength(2);
  });

  it("suppresses a flush below minMessages and retries on the next interval", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, maxMessages: 100, minMessages: 3, intervalMs: 1000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "a" }), NOT_TRIGGERED); // t=0, buffer=1

    clock.advance(1000); // t=1000: interval fires, buffer(1) < min(3) — suppressed, retried
    expect(onFlush).not.toHaveBeenCalled();
    expect(agg.pendingDigestKeys()).toEqual(["group:2001"]);

    agg.accept(makeMessage({ text: "b" }), NOT_TRIGGERED); // t=1000, buffer=2

    clock.advance(1000); // t=2000: interval fires again, buffer(2) < min(3) — suppressed again
    expect(onFlush).not.toHaveBeenCalled();

    agg.accept(makeMessage({ text: "c" }), NOT_TRIGGERED); // t=2000, buffer=3

    clock.advance(1000); // t=3000: interval fires, buffer(3) >= min(3) — flush
    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("interval");
    expect(batch.messages).toHaveLength(3);
  });

  it("ignores out-of-scope peers", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, scope: "group" } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const directMsg = makeMessage({ peerId: "private:1001", peerKind: "direct", groupId: undefined });
    agg.accept(directMsg, NOT_TRIGGERED);

    expect(agg.pendingDigestKeys()).toEqual([]);
    clock.advance(1_000_000);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("filters by digest.peers when set", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, peers: ["group:2001"] } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ peerId: "group:2001", groupId: 2001, text: "allowed" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ peerId: "group:2002", groupId: 2002, text: "not allowed" }), NOT_TRIGGERED);

    expect(agg.pendingDigestKeys()).toEqual(["group:2001"]);
  });

  it("trims oldest messages so the transcript stays under maxTranscriptChars", async () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({
        digest: { enabled: true, maxTranscriptChars: 25, maxMessages: 100, minMessages: 1, intervalMs: 100_000 },
      }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "AAAAAAAAAA" }), NOT_TRIGGERED); // 10 chars, total 10
    agg.accept(makeMessage({ text: "BBBBBBBBBB" }), NOT_TRIGGERED); // 10 chars, total 20 — kept
    agg.accept(makeMessage({ text: "CCCCCCCCCC" }), NOT_TRIGGERED); // 10 chars, total 30 — trims "AAAA..."

    await agg.flushAll("test-check");
    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.messages.map((m: NormalizedMessage) => m.text)).toEqual(["BBBBBBBBBB", "CCCCCCCCCC"]);
  });
});

// ── reply-history engine ─────────────────────────────────────────────────

describe("aggregator: reply-history engine", () => {
  it("attaches prior messages as batch.history (excluding the batch itself) and drains the buffer on flush", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const ctx1 = makeMessage({ text: "闲聊一" });
    const ctx2 = makeMessage({ text: "闲聊二" });
    agg.accept(ctx1, NOT_TRIGGERED); // pure context, opens no window
    agg.accept(ctx2, NOT_TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toEqual([]);
    expect(agg.pendingHistoryKeys()).toEqual(["group:2001"]);

    const trigger = makeMessage({ text: "在吗" });
    agg.accept(trigger, TRIGGERED);
    clock.advance(800); // quiet flush

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.messages).toEqual([trigger]);
    expect(batch.history).toEqual([ctx1, ctx2]);
    // Drained on consume so it is not re-sent next time.
    expect(agg.pendingHistoryKeys()).toEqual([]);
  });

  it("excludes coalesced burst messages from the history it hands to the reply", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const older = makeMessage({ text: "更早的上下文" });
    agg.accept(older, NOT_TRIGGERED);
    const a = makeMessage({ text: "触发" });
    agg.accept(a, TRIGGERED);
    const b = makeMessage({ text: "跟进" });
    agg.accept(b, NOT_TRIGGERED); // joins the open window (same sender)

    clock.advance(800);

    const batch = onFlush.mock.calls[0][0];
    expect(batch.messages).toEqual([a, b]);
    expect(batch.history).toEqual([older]);
  });

  it("does not repeat already-consumed history on a later reply", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "旧一" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "旧二" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "第一次触发" }), TRIGGERED);
    clock.advance(800);

    const fresh = makeMessage({ text: "新上下文" });
    agg.accept(fresh, NOT_TRIGGERED);
    const trigger2 = makeMessage({ text: "第二次触发" });
    agg.accept(trigger2, TRIGGERED);
    clock.advance(800);

    expect(onFlush).toHaveBeenCalledTimes(2);
    const secondBatch = onFlush.mock.calls[1][0];
    expect(secondBatch.messages).toEqual([trigger2]);
    expect(secondBatch.history).toEqual([fresh]); // only what arrived since the first reply
  });

  it("trims the history buffer to history.maxMessages (newest kept)", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ history: { maxMessages: 2 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "c1" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "c2" }), NOT_TRIGGERED);
    const c3 = makeMessage({ text: "c3" });
    agg.accept(c3, NOT_TRIGGERED); // evicts c1, buffer=[c2,c3]

    const trigger = makeMessage({ text: "go" });
    agg.accept(trigger, TRIGGERED); // evicts c2, buffer=[c3,trigger]
    clock.advance(800);

    const batch = onFlush.mock.calls[0][0];
    expect(batch.history?.map((m: NormalizedMessage) => m.text)).toEqual(["c3"]);
  });

  it("drops history older than history.maxAgeMs (by QQ timestamp) at snapshot time", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ history: { maxAgeMs: 5000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "old", time: 10 }), NOT_TRIGGERED); // 10s
    agg.accept(makeMessage({ text: "recent", time: 18 }), NOT_TRIGGERED); // 18s

    clock.advance(20_000); // now() = 20_000ms = 20s
    agg.accept(makeMessage({ text: "go", time: 20 }), TRIGGERED);
    clock.advance(800); // quiet flush at 20_800ms ⇒ cutoff = (20_800 - 5_000)/1000 = 15.8s

    const batch = onFlush.mock.calls[0][0];
    // old(10s) < 15.8s cutoff ⇒ dropped; recent(18s) kept.
    expect(batch.history?.map((m: NormalizedMessage) => m.text)).toEqual(["recent"]);
  });

  it("keeps no history and attaches none when history.enabled is false", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ history: { enabled: false } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "context" }), NOT_TRIGGERED);
    expect(agg.pendingHistoryKeys()).toEqual([]);

    agg.accept(makeMessage({ text: "trigger" }), TRIGGERED);
    clock.advance(800);

    const batch = onFlush.mock.calls[0][0];
    expect(batch.history ?? []).toEqual([]);
  });

  it("keeps the digest queue independent of the drained history buffer", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true, maxMessages: 100, minMessages: 1, intervalMs: 100_000 } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "闲聊" }), NOT_TRIGGERED);
    agg.accept(makeMessage({ text: "触发" }), TRIGGERED);
    clock.advance(800); // realtime flush drains history

    // The realtime reply drained the history buffer, but the digest window for
    // the same peer is untouched — the two queues are stored separately.
    expect(agg.pendingHistoryKeys()).toEqual([]);
    expect(agg.pendingDigestKeys()).toEqual(["group:2001"]);
  });

  it("also attaches history on the immediate path when realtime coalescing is disabled", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ realtime: { enabled: false } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    const ctx = makeMessage({ text: "先说一句" });
    agg.accept(ctx, NOT_TRIGGERED); // buffered as history, no window opened
    const trigger = makeMessage({ text: "然后叫机器人" });
    agg.accept(trigger, TRIGGERED); // immediate flush

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.reason).toBe("immediate");
    expect(batch.messages).toEqual([trigger]);
    expect(batch.history).toEqual([ctx]);
  });
});

// ── flushAll / dispose ──────────────────────────────────────────────────

describe("aggregator: flushAll and dispose", () => {
  it("flushAll flushes every open window and awaits every onFlush", async () => {
    const clock = createFakeClock();
    const flushOrder: string[] = [];
    const onFlush = vi.fn(async (batch: AggregatedBatch) => {
      await Promise.resolve();
      flushOrder.push(batch.kind);
    });
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage({ text: "realtime-opener" }), TRIGGERED);
    agg.accept(makeMessage({ peerId: "group:9999", groupId: 9999, senderId: 5, text: "digest-only" }), NOT_TRIGGERED);

    expect(agg.pendingRealtimeKeys()).toHaveLength(1);
    expect(agg.pendingDigestKeys()).toHaveLength(2); // group:2001 (from realtime opener) and group:9999

    await agg.flushAll("shutdown");

    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(onFlush.mock.calls.every(([batch]) => batch.reason === "shutdown")).toBe(true);
    expect(flushOrder).toHaveLength(3);
    expect(agg.pendingRealtimeKeys()).toEqual([]);
    expect(agg.pendingDigestKeys()).toEqual([]);
  });

  it("flushAll defaults reason to 'shutdown' when called without an argument", async () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount(),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage(), TRIGGERED);
    await agg.flushAll();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].reason).toBe("shutdown");
  });

  it("dispose clears all timers without flushing", () => {
    const clock = createFakeClock();
    const onFlush = vi.fn<(batch: AggregatedBatch) => void>();
    const agg = createAggregator({
      account: makeAccount({ digest: { enabled: true } }),
      onFlush,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    agg.accept(makeMessage(), TRIGGERED);
    expect(agg.pendingRealtimeKeys()).toHaveLength(1);
    expect(agg.pendingDigestKeys()).toHaveLength(1);

    agg.dispose();
    expect(agg.pendingRealtimeKeys()).toEqual([]);
    expect(agg.pendingDigestKeys()).toEqual([]);

    // Timers must genuinely be cancelled, not just forgotten about — advancing
    // far past every configured window/interval must not trigger a flush.
    clock.advance(10_000_000);
    expect(onFlush).not.toHaveBeenCalled();
  });
});

// ── error isolation ─────────────────────────────────────────────────────

describe("aggregator: onFlush error isolation", () => {
  it("a synchronously throwing onFlush is caught and logged; accept() never throws", () => {
    const clock = createFakeClock();
    const log = { error: vi.fn() };
    const onFlush = vi.fn(() => {
      throw new Error("boom-sync");
    });
    const agg = createAggregator({
      account: makeAccount({ realtime: { enabled: false } }),
      onFlush,
      log,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    expect(() => agg.accept(makeMessage(), TRIGGERED)).not.toThrow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("a rejecting async onFlush is caught and logged; accept() never throws", async () => {
    const clock = createFakeClock();
    const log = { error: vi.fn() };
    const onFlush = vi.fn(async () => {
      throw new Error("boom-async");
    });
    const agg = createAggregator({
      account: makeAccount({ realtime: { enabled: false } }),
      onFlush,
      log,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    expect(() => agg.accept(makeMessage(), TRIGGERED)).not.toThrow();
    // Let the rejected promise's .catch() handler run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
