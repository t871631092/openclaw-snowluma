/**
 * The gateway loop — owns one long-lived SnowLuma connection per account and
 * wires it to the trigger/aggregator/dispatch pipeline.
 *
 * `@snowluma/sdk` owns the socket lifecycle entirely: connecting, heartbeats,
 * and reconnection (`SnowLumaWebSocketClientOptions.reconnect`, configured by
 * `createSnowLumaClient` from the account's `reconnect` settings). This module
 * never opens a socket itself and never schedules a reconnect — it only reacts
 * to the client's `onMessage`/`on("open"|"close"|"error")` events.
 */

import type { OneBotMessageEvent, SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createAggregator } from "./aggregator.js";
import type { AggregatedBatch } from "./aggregator.js";
import { createSnowLumaClient, detectSelfId, registerActionClient, unregisterActionClient } from "./client.js";
import { ensureSnowLumaSdk } from "./sdk.js";
import { isPeerAllowed } from "./config.js";
import { dispatchBatch } from "./dispatch.js";
import type { DispatchDeps, DispatchLogger } from "./dispatch.js";
import { reactToMessage, sendMedia as defaultSendMedia, sendText as defaultSendText } from "./outbound.js";
import { normalizeMessageEvent } from "./segments.js";
import { evaluateTrigger } from "./triggers.js";
import type { ResolvedSnowLumaAccount } from "./types.js";

// ── Self-message tracking ───────────────────────────────────────────────
//
// `evaluateTrigger`'s "reply-to-self" rule needs to know whether a given
// message id is one the bot itself sent — SnowLuma has no `get_msg` flag for
// that, so the gateway remembers every id its own sends return. Bounded and
// FIFO-evicted so a long-running process never leaks memory over a busy chat.

export interface SelfMessageTracker {
  add(id: string): void;
  has(id: string): boolean;
}

const DEFAULT_TRACKER_CAPACITY = 500;

export function createSelfMessageTracker(maxSize = DEFAULT_TRACKER_CAPACITY): SelfMessageTracker {
  const ids = new Set<string>();
  const order: string[] = [];

  return {
    add(id: string) {
      if (ids.has(id)) return;
      ids.add(id);
      order.push(id);
      while (order.length > maxSize) {
        const oldest = order.shift();
        if (oldest !== undefined) ids.delete(oldest);
      }
    },
    has(id: string) {
      return ids.has(id);
    },
  };
}

/** Wraps `sendText`/`sendMedia` so every id the bot sends feeds the self-message tracker. */
function createTrackingSend(tracker: SelfMessageTracker): NonNullable<DispatchDeps["send"]> {
  return {
    sendText: async (params: Parameters<typeof defaultSendText>[0]) => {
      const result = await defaultSendText(params);
      for (const id of result.messageIds) tracker.add(id);
      return result;
    },
    sendMedia: async (params: Parameters<typeof defaultSendMedia>[0]) => {
      const result = await defaultSendMedia(params);
      for (const id of result.messageIds) tracker.add(id);
      return result;
    },
  };
}

// ── Gateway ──────────────────────────────────────────────────────────────

export interface GatewayContext {
  account: ResolvedSnowLumaAccount;
  cfg: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: DispatchLogger;
  onReady?: (info: { selfId?: number }) => void;
  onError?: (error: Error) => void;
  /** Defaults to `createSnowLumaClient`. */
  clientFactory?: (account: ResolvedSnowLumaAccount) => SnowLumaWebSocketClient;
  /** Defaults to `dispatchBatch`. */
  dispatch?: (batch: AggregatedBatch, deps: DispatchDeps) => Promise<void>;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Runs the gateway loop for one account until `abortSignal` fires. Resolves
 * once shutdown (flush + unregister + close) has completed — mirrors the
 * reference plugin's trailing "wait for abort" promise, minus any hand-rolled
 * reconnect: that part is entirely the SDK's job.
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, cfg, abortSignal, log, onReady, onError } = ctx;

  if (!account.wsUrl) {
    throw new Error(`SnowLuma account "${account.accountId}" is not configured (missing wsUrl)`);
  }

  const clientFactory = ctx.clientFactory ?? createSnowLumaClient;
  const dispatch = ctx.dispatch ?? dispatchBatch;

  // Load (and, on an `--ignore-scripts` gateway install, self-patch) the SDK
  // before anything downstream needs it: the default client factory, segment
  // parsing, and the outbound builders all read the registry synchronously.
  await ensureSnowLumaSdk(log);

  const client = clientFactory(account);

  // Wired before `connect()` so a client that fires "open"/"error" during the
  // initial handshake (or on the SDK's own later reconnects) is never missed.
  const unsubscribeError = client.on("error", (err) => {
    log?.error?.(`[snowluma:${account.accountId}] socket error: ${String(err)}`);
    onError?.(toError(err));
  });
  const unsubscribeOpen = client.on("open", () => {
    log?.info?.(`[snowluma:${account.accountId}] socket open`);
  });
  const unsubscribeClose = client.on("close", (info) => {
    const suffix = info?.code !== undefined ? ` (code ${info.code}${info.reason ? `: ${info.reason}` : ""})` : "";
    log?.info?.(`[snowluma:${account.accountId}] socket closed${suffix}`);
  });

  // The SDK starts its own reconnect loop the instant a connect attempt closes
  // while `closedByUser` is still false. If the *initial* connect rejects and we
  // just propagate, that loop keeps running forever with no reference left to
  // stop it. `client.close()` sets `closedByUser` and clears the reconnect timer,
  // so always close on the failure path before rethrowing.
  try {
    await client.connect();
  } catch (err) {
    unsubscribeError();
    unsubscribeOpen();
    unsubscribeClose();
    client.close();
    throw err;
  }

  const selfId = account.selfId ?? (await detectSelfId(client, log));
  if (selfId === undefined) {
    log?.error?.(
      `[snowluma:${account.accountId}] could not determine the bot's own QQ id — ` +
        "mention detection cannot work until selfId is configured or auto-detected.",
    );
  }
  const effectiveAccount: ResolvedSnowLumaAccount = selfId === undefined ? account : { ...account, selfId };

  registerActionClient(account.accountId, client);

  const selfMessageTracker = createSelfMessageTracker();
  const trackingSend = createTrackingSend(selfMessageTracker);

  const aggregator = createAggregator({
    account: effectiveAccount,
    log,
    onFlush: async (batch) => {
      try {
        await dispatch(batch, { account: effectiveAccount, cfg, client, log, send: trackingSend });
      } catch (err) {
        log?.error?.(`[snowluma:${account.accountId}] dispatch failed: ${String(err)}`);
      }
    },
  });

  const unsubscribeMessages = client.onMessage((event: OneBotMessageEvent) => {
    try {
      // The SDK delivers `post_type: "message_sent"` (the bot's own outgoing
      // messages, echoed back by SnowLuma) to `onMessage` too. Drop them
      // unconditionally — this is the standard self-echo vector, and relying on
      // the `senderId === selfId` check below would leave the door open to an
      // infinite reply loop whenever `selfId` couldn't be determined.
      if (event.post_type === "message_sent") return;

      const msg = normalizeMessageEvent(event);

      // Never react to our own sends (covers backends that echo self messages
      // as ordinary `post_type: "message"` events rather than "message_sent").
      if (selfId !== undefined && msg.senderId === selfId) return;
      if (!isPeerAllowed(account, msg.peerId)) return;

      const decision = evaluateTrigger(msg, effectiveAccount, {
        isSelfMessageId: (id) => selfMessageTracker.has(id),
      });

      if (decision.triggered && msg.peerKind === "group" && account.groupAutoReact) {
        void reactToMessage(client, msg.messageId, account.groupAutoReactEmojiId)
          .then((result) => {
            if (!result.ok) {
              log?.error?.(
                `[snowluma:${account.accountId}] group auto-react failed for ${msg.peerId}#${msg.messageId}: ${
                  result.error ?? "unknown error"
                }`,
              );
            }
          })
          // `reactToMessage` is contracted never to throw, but a caller-supplied
          // `log.error` that throws would otherwise surface as an unhandled
          // rejection — keep the fire-and-forget path fully self-contained.
          .catch(() => {});
      }

      aggregator.accept(msg, decision);
    } catch (err) {
      log?.error?.(`[snowluma:${account.accountId}] message handling failed: ${String(err)}`);
    }
  });

  log?.info?.(
    `[snowluma:${account.accountId}] gateway ready${selfId !== undefined ? ` (selfId=${selfId})` : ""}`,
  );
  onReady?.({ selfId });

  return new Promise<void>((resolve) => {
    const shutdown = () => {
      void (async () => {
        // `finally { resolve() }` so a throw from any cleanup step (a broken
        // socket's `close()`, an unregister, a flush) can never leave this
        // promise — and whatever orchestration is awaiting it — hung forever.
        try {
          unsubscribeMessages();
          unsubscribeError();
          unsubscribeOpen();
          unsubscribeClose();
          await aggregator.flushAll("shutdown");
          unregisterActionClient(account.accountId);
          client.close();
        } catch (err) {
          log?.error?.(`[snowluma:${account.accountId}] shutdown error: ${String(err)}`);
        } finally {
          resolve();
        }
      })();
    };

    // `addEventListener("abort")` never fires for a signal that is *already*
    // aborted (e.g. the host aborted during `connect()`/`detectSelfId`), which
    // would otherwise leave the gateway registered, the socket open, and this
    // promise pending forever. Run cleanup immediately in that case.
    if (abortSignal.aborted) {
      shutdown();
      return;
    }
    abortSignal.addEventListener("abort", shutdown, { once: true });
  });
}
