/**
 * Receive-mode B & C: realtime coalescing and digest summarisation.
 *
 * Two fully independent windowing engines share one `accept()` entry point.
 * Every message that reaches `accept` may feed both — a burst of triggered
 * messages opens a realtime window while the same messages also accumulate
 * in that peer's digest window. Timers are injected so tests can drive this
 * deterministically instead of racing real wall-clock delays.
 */

import type { NormalizedMessage, PeerKind, ResolvedSnowLumaAccount, TriggerDecision } from "./types.js";

/**
 * `"summary"` batches never come out of this module — they are built on demand
 * by `summary.ts` when a user types `/summary` — but they travel the same
 * `AggregatedBatch` → `dispatch.ts` path, so the kind lives here with the others.
 */
export type FlushKind = "realtime" | "digest" | "summary";

export interface AggregatedBatch {
  kind: FlushKind;
  peerId: string;
  peerKind: PeerKind;
  groupId?: number;
  messages: NormalizedMessage[];
  /**
   * Prior messages from this peer's rolling reply-history buffer, oldest first,
   * excluding the batch's own `messages`. Only ever populated for realtime
   * batches — it is the accumulated chat context handed to the reply turn.
   * Empty/undefined when history is disabled or nothing preceded the batch.
   */
  history?: NormalizedMessage[];
  /**
   * The message that explicitly asked for this batch (`"summary"` only). It is
   * deliberately NOT part of `messages` — it is the command, not transcript
   * content — but dispatch attributes the turn to it and quote-replies to it.
   */
  commandMessage?: NormalizedMessage;
  trigger?: TriggerDecision;
  /** Why this batch flushed: "quiet" | "max-window" | "max-messages" | "max-chars" | "interval" | "immediate" | "shutdown" (or a caller-supplied reason passed to `flushAll`). */
  reason: string;
}

export interface AggregatorOptions {
  account: ResolvedSnowLumaAccount;
  onFlush: (batch: AggregatedBatch) => void | Promise<void>;
  log?: { debug?(m: string): void; error?(m: string): void };
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface Aggregator {
  /** Feed one authorized inbound message plus its trigger decision. Never throws. */
  accept(msg: NormalizedMessage, trigger: TriggerDecision): void;
  /** Flush every open window (used on shutdown). Resolves once every `onFlush` call has settled. */
  flushAll(reason?: string): Promise<void>;
  /** Clear all pending timers without flushing — buffered messages are discarded. */
  dispose(): void;
  /** Introspection for tests: open realtime window keys (`${peerId}::${senderId}`). */
  pendingRealtimeKeys(): string[];
  /** Introspection for tests: open digest window keys (`peerId`). */
  pendingDigestKeys(): string[];
  /** Introspection for tests: peers with a non-empty reply-history buffer (`peerId`). */
  pendingHistoryKeys(): string[];
}

interface RealtimeWindow {
  peerId: string;
  peerKind: PeerKind;
  groupId?: number;
  senderId: number;
  messages: NormalizedMessage[];
  /** The decision from the message that opened this window — carried through to the flushed batch. */
  trigger: TriggerDecision;
  openedAt: number;
  quietTimer?: unknown;
  maxWindowTimer?: unknown;
}

interface DigestWindow {
  peerId: string;
  peerKind: PeerKind;
  groupId?: number;
  messages: NormalizedMessage[];
  openedAt: number;
  intervalTimer?: unknown;
}

/**
 * Rolling per-peer buffer of recent messages, kept independently of the digest
 * queue. Drained into a realtime batch's `history` the moment that peer replies.
 */
interface HistoryBuffer {
  messages: NormalizedMessage[];
}

function realtimeKey(peerId: string, senderId: number): string {
  return `${peerId}::${senderId}`;
}

/** Rendered-text volume used against `maxChars` / `maxTranscriptChars`. */
function totalChars(messages: NormalizedMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.text?.length ?? 0), 0);
}

export function createAggregator(options: AggregatorOptions): Aggregator {
  const { account, onFlush, log } = options;
  const now = options.now ?? (() => Date.now());
  const scheduleTimeout = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelTimeout = options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));

  const realtimeWindows = new Map<string, RealtimeWindow>();
  const digestWindows = new Map<string, DigestWindow>();
  const historyBuffers = new Map<string, HistoryBuffer>();

  function clearTimer(handle: unknown): void {
    if (handle !== undefined) cancelTimeout(handle);
  }

  /** Runs `onFlush`, catching both synchronous throws and promise rejections so callers never see them. */
  function runOnFlush(batch: AggregatedBatch): Promise<void> {
    try {
      return Promise.resolve(onFlush(batch)).catch((err: unknown) => {
        log?.error?.(`[snowluma] ${batch.kind} onFlush failed: ${String(err)}`);
      });
    } catch (err) {
      log?.error?.(`[snowluma] ${batch.kind} onFlush threw: ${String(err)}`);
      return Promise.resolve();
    }
  }

  // ── realtime engine ────────────────────────────────────────────────────

  function flushRealtimeWindow(key: string, reason: string): Promise<void> {
    const win = realtimeWindows.get(key);
    if (!win) return Promise.resolve();
    realtimeWindows.delete(key);
    clearTimer(win.quietTimer);
    clearTimer(win.maxWindowTimer);
    return runOnFlush({
      kind: "realtime",
      peerId: win.peerId,
      peerKind: win.peerKind,
      groupId: win.groupId,
      messages: win.messages,
      history: takeHistoryForReply(win.peerId, win.messages),
      trigger: win.trigger,
      reason,
    });
  }

  function emitImmediateRealtime(msg: NormalizedMessage, trigger: TriggerDecision): Promise<void> {
    return runOnFlush({
      kind: "realtime",
      peerId: msg.peerId,
      peerKind: msg.peerKind,
      groupId: msg.groupId,
      messages: [msg],
      history: takeHistoryForReply(msg.peerId, [msg]),
      trigger,
      reason: "immediate",
    });
  }

  /** Returns true if the window was flushed (and therefore must not be touched further). */
  function checkRealtimeCaps(win: RealtimeWindow, key: string): boolean {
    const cfg = account.receive.realtime;
    if (win.messages.length >= cfg.maxMessages) {
      void flushRealtimeWindow(key, "max-messages");
      return true;
    }
    if (totalChars(win.messages) >= cfg.maxChars) {
      void flushRealtimeWindow(key, "max-chars");
      return true;
    }
    return false;
  }

  function scheduleQuietTimer(win: RealtimeWindow, key: string): void {
    clearTimer(win.quietTimer);
    win.quietTimer = scheduleTimeout(() => {
      void flushRealtimeWindow(key, "quiet");
    }, account.receive.realtime.windowMs);
  }

  function scheduleMaxWindowTimer(win: RealtimeWindow, key: string): void {
    win.maxWindowTimer = scheduleTimeout(() => {
      void flushRealtimeWindow(key, "max-window");
    }, account.receive.realtime.maxWindowMs);
  }

  function acceptRealtime(msg: NormalizedMessage, trigger: TriggerDecision): void {
    const cfg = account.receive.realtime;
    const key = realtimeKey(msg.peerId, msg.senderId);

    if (!cfg.enabled) {
      // No window state is ever kept while realtime is off — a triggered
      // message flushes on its own; an untriggered one is simply not observed.
      if (trigger.triggered) void emitImmediateRealtime(msg, trigger);
      return;
    }

    const existing = realtimeWindows.get(key);
    if (existing) {
      existing.messages.push(msg);
      if (checkRealtimeCaps(existing, key)) return;
      scheduleQuietTimer(existing, key);
      return;
    }

    // Only a triggered message may open a new window.
    if (!trigger.triggered) return;

    const win: RealtimeWindow = {
      peerId: msg.peerId,
      peerKind: msg.peerKind,
      groupId: msg.groupId,
      senderId: msg.senderId,
      messages: [msg],
      trigger,
      openedAt: now(),
    };
    realtimeWindows.set(key, win);
    if (checkRealtimeCaps(win, key)) return;
    scheduleQuietTimer(win, key);
    scheduleMaxWindowTimer(win, key);
  }

  // ── digest engine ──────────────────────────────────────────────────────

  function inDigestScope(msg: NormalizedMessage): boolean {
    const cfg = account.receive.digest;
    if (cfg.scope === "group" && msg.peerKind !== "group") return false;
    if (cfg.scope === "direct" && msg.peerKind !== "direct") return false;
    if (cfg.peers.length > 0 && !cfg.peers.includes(msg.peerId)) return false;
    return true;
  }

  function trimDigestTranscript(win: DigestWindow): void {
    const limit = account.receive.digest.maxTranscriptChars;
    while (win.messages.length > 1 && totalChars(win.messages) > limit) {
      win.messages.shift();
    }
  }

  function flushDigestWindow(key: string, reason: string): Promise<void> {
    const win = digestWindows.get(key);
    if (!win) return Promise.resolve();
    digestWindows.delete(key);
    clearTimer(win.intervalTimer);
    return runOnFlush({
      kind: "digest",
      peerId: win.peerId,
      peerKind: win.peerKind,
      groupId: win.groupId,
      messages: win.messages,
      reason,
    });
  }

  function scheduleDigestTimer(win: DigestWindow, key: string): void {
    win.intervalTimer = scheduleTimeout(() => {
      win.intervalTimer = undefined;
      if (win.messages.length < account.receive.digest.minMessages) {
        // Too little to say yet — keep the buffer and wait another interval.
        scheduleDigestTimer(win, key);
        return;
      }
      void flushDigestWindow(key, "interval");
    }, account.receive.digest.intervalMs);
  }

  function acceptDigest(msg: NormalizedMessage): void {
    const cfg = account.receive.digest;
    if (!cfg.enabled) return;
    if (!inDigestScope(msg)) return;

    const key = msg.peerId;
    let win = digestWindows.get(key);
    if (!win) {
      win = { peerId: msg.peerId, peerKind: msg.peerKind, groupId: msg.groupId, messages: [], openedAt: now() };
      digestWindows.set(key, win);
    }
    win.messages.push(msg);
    trimDigestTranscript(win);

    if (win.messages.length >= cfg.maxMessages) {
      void flushDigestWindow(key, "max-messages");
      return;
    }

    if (win.intervalTimer === undefined) {
      scheduleDigestTimer(win, key);
    }
  }

  // ── reply-history engine ───────────────────────────────────────────────
  //
  // A rolling per-peer buffer, entirely separate from the digest queue above.
  // Every observed message accumulates here; when that peer next produces a
  // realtime reply, the whole buffer (minus the batch's own messages) is handed
  // to the turn as context and then drained — so a reply carries the surrounding
  // conversation, including lines that never addressed the bot.

  function trimHistoryBuffer(buf: HistoryBuffer): void {
    const cfg = account.receive.history;
    while (buf.messages.length > cfg.maxMessages) buf.messages.shift();
    while (buf.messages.length > 1 && totalChars(buf.messages) > cfg.maxChars) {
      buf.messages.shift();
    }
  }

  function acceptHistory(msg: NormalizedMessage): void {
    if (!account.receive.history.enabled) return;
    const key = msg.peerId;
    let buf = historyBuffers.get(key);
    if (!buf) {
      buf = { messages: [] };
      historyBuffers.set(key, buf);
    }
    buf.messages.push(msg);
    trimHistoryBuffer(buf);
  }

  /**
   * Snapshot a peer's accumulated history for a reply and drain the buffer.
   * Excludes the batch's own messages (they are the current input, not context)
   * and, when `maxAgeMs > 0`, any message older than that relative to `now()`.
   */
  function takeHistoryForReply(peerId: string, batchMessages: NormalizedMessage[]): NormalizedMessage[] {
    const cfg = account.receive.history;
    if (!cfg.enabled) return [];
    const buf = historyBuffers.get(peerId);
    if (!buf) return [];
    // Draining is the point: everything up to now has been handed to the agent
    // (as history or as the batch itself), so keeping it would only re-send the
    // same context on the next reply. The agent's own session memory carries
    // continuity from here.
    historyBuffers.delete(peerId);

    const batchIds = new Set(batchMessages.map((m) => m.messageId));
    const cutoffSeconds = cfg.maxAgeMs > 0 ? (now() - cfg.maxAgeMs) / 1000 : Number.NEGATIVE_INFINITY;
    return buf.messages.filter((m) => !batchIds.has(m.messageId) && m.time >= cutoffSeconds);
  }

  // ── public surface ─────────────────────────────────────────────────────

  return {
    accept(msg, trigger) {
      // History accumulates first so a synchronous realtime flush (immediate /
      // max-messages / max-chars) triggered by this same message can already
      // see it in the buffer — then exclude it from the snapshot as its own input.
      try {
        acceptHistory(msg);
      } catch (err) {
        log?.error?.(`[snowluma] history accept failed: ${String(err)}`);
      }
      try {
        acceptRealtime(msg, trigger);
      } catch (err) {
        log?.error?.(`[snowluma] realtime accept failed: ${String(err)}`);
      }
      try {
        acceptDigest(msg);
      } catch (err) {
        log?.error?.(`[snowluma] digest accept failed: ${String(err)}`);
      }
    },

    async flushAll(reason = "shutdown") {
      const flushes: Promise<void>[] = [];
      for (const key of Array.from(realtimeWindows.keys())) {
        flushes.push(flushRealtimeWindow(key, reason));
      }
      for (const key of Array.from(digestWindows.keys())) {
        flushes.push(flushDigestWindow(key, reason));
      }
      await Promise.all(flushes);
    },

    dispose() {
      for (const win of realtimeWindows.values()) {
        clearTimer(win.quietTimer);
        clearTimer(win.maxWindowTimer);
      }
      for (const win of digestWindows.values()) {
        clearTimer(win.intervalTimer);
      }
      realtimeWindows.clear();
      digestWindows.clear();
      historyBuffers.clear();
    },

    pendingRealtimeKeys() {
      return Array.from(realtimeWindows.keys());
    },

    pendingDigestKeys() {
      return Array.from(digestWindows.keys());
    },

    pendingHistoryKeys() {
      return Array.from(historyBuffers.keys());
    },
  };
}
