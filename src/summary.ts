/**
 * The on-demand `/summary` command — digest mode's manual counterpart.
 *
 * Digest mode summarises whatever happened to pass through the gateway's own
 * window. `/summary` instead asks SnowLuma for the peer's most recent messages
 * (100 by default) via `get_group_msg_history` / `get_friend_msg_history`, so it
 * works on the first day the bot joins a group, with digest mode switched off,
 * and over messages the gateway never observed.
 *
 * The command is matched here and dispatched as an ordinary `AggregatedBatch`
 * of `kind: "summary"` — it never touches the aggregator's windows, so an
 * in-flight realtime burst or digest window is left exactly as it was.
 */

import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { AggregatedBatch } from "./aggregator.js";
import type { DispatchLogger } from "./dispatch.js";
import { sendText as defaultSendText } from "./outbound.js";
import { normalizeHistoryEntry } from "./segments.js";
import { stripLeadingMention } from "./triggers.js";
import type { NormalizedMessage, ResolvedSnowLumaAccount } from "./types.js";

/** A matched `/summary` invocation: which command word fired, and how many messages it asked for. */
export interface SummaryRequest {
  command: string;
  count: number;
}

export interface SummaryDeps {
  account: ResolvedSnowLumaAccount;
  client: SnowLumaApiClient;
  log?: DispatchLogger;
  /** Hands the composed batch to the normal dispatch path. */
  dispatch: (batch: AggregatedBatch) => Promise<void>;
  /** Defaults to `sendText` from ./outbound.js — used only for the "nothing to summarise" / failure notices. */
  send?: { sendText: typeof defaultSendText };
  /** Defaults to the SDK's history actions; injectable so tests need no client. */
  fetchHistory?: (params: { count: number }) => Promise<unknown[]>;
}

const LEADING_COUNT = /^(\d{1,4})\b/;

/**
 * Does `text` start with `command`? A command word must be followed by the end
 * of the message or a delimiter, so `/summary` never matches `/summarylater`.
 * Returns the remainder after the command, or `undefined` when it did not match.
 */
function afterCommand(text: string, command: string): string | undefined {
  if (text.length < command.length) return undefined;
  if (text.slice(0, command.length).toLowerCase() !== command.toLowerCase()) return undefined;
  const rest = text.slice(command.length);
  // A CJK command word ("/总结") has no word boundary before an argument, so a
  // digit is an accepted delimiter too: "/总结50" reads as "summarise 50".
  if (rest.length > 0 && !/^[\s\d]/.test(rest)) return undefined;
  return rest;
}

/**
 * Decide whether `msg` is a `/summary` command for this account, and for how
 * many messages. Pure — no I/O — so the gateway can call it on every inbound
 * message. Returns `null` when the command is disabled, out of scope, or absent.
 */
export function matchSummaryCommand(
  msg: NormalizedMessage,
  account: ResolvedSnowLumaAccount,
): SummaryRequest | null {
  const cfg = account.receive.summary;
  if (!cfg.enabled) return null;
  if (cfg.scope === "group" && msg.peerKind !== "group") return null;
  if (cfg.scope === "direct" && msg.peerKind !== "direct") return null;
  if (cfg.peers.length > 0 && !cfg.peers.includes(msg.peerId)) return null;

  // "@bot /summary" is how people address a bot in a group, so the mention is
  // stripped before matching — exactly as `dispatch.ts` does for a reply turn.
  const text = stripLeadingMention(msg.text, account.selfId).trim();
  if (!text) return null;

  for (const command of cfg.commands) {
    const rest = afterCommand(text, command);
    if (rest === undefined) continue;

    // Anything that isn't a leading number is ignored rather than rejected:
    // "/summary 最近聊了什么" should still produce a summary.
    const countMatch = LEADING_COUNT.exec(rest.trim());
    const requested = countMatch ? Number(countMatch[1]) : cfg.count;
    const count = Math.min(Math.max(requested > 0 ? requested : cfg.count, 1), cfg.maxCount);
    return { command, count };
  }

  return null;
}

/** The peer to ask SnowLuma about — derived from the command message, not re-parsed from `peerId`. */
function resolveHistoryTarget(
  msg: NormalizedMessage,
): { kind: "group"; id: number } | { kind: "private"; id: number } | null {
  if (msg.peerKind === "group") {
    return msg.groupId !== undefined && Number.isFinite(msg.groupId)
      ? { kind: "group", id: msg.groupId }
      : null;
  }
  return Number.isFinite(msg.senderId) ? { kind: "private", id: msg.senderId } : null;
}

function timeOf(entry: unknown): number {
  const raw = (entry as { time?: unknown } | null)?.time;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Run a matched `/summary` command end to end: fetch the recent messages, build
 * the batch, dispatch it. Never rejects — every failure is reported to the chat
 * that asked (a silent no-op would read as the bot ignoring the command) and
 * logged.
 */
export async function runSummaryCommand(
  msg: NormalizedMessage,
  request: SummaryRequest,
  deps: SummaryDeps,
): Promise<void> {
  const { account, client, log, dispatch } = deps;
  const send = deps.send ?? { sendText: defaultSendText };
  const address = `snowluma:${msg.peerId}`;

  const outboundDebug = account.debug
    ? { log: (line: string) => log?.info?.(`[snowluma:${account.accountId}] ${line}`) }
    : undefined;

  const notify = async (text: string): Promise<void> => {
    try {
      await send.sendText({
        client,
        to: address,
        text,
        replyToId: account.replyToTrigger ? msg.messageId : undefined,
        chunkLimit: account.textChunkLimit,
        debug: outboundDebug,
      });
    } catch (err) {
      log?.error?.(`[snowluma:${account.accountId}] summary notice send failed: ${String(err)}`);
    }
  };

  try {
    const target = resolveHistoryTarget(msg);
    if (!target) {
      log?.error?.(`[snowluma:${account.accountId}] /summary: cannot resolve a history target for ${msg.peerId}`);
      return;
    }

    const fetchHistory =
      deps.fetchHistory ??
      (async ({ count }: { count: number }) => {
        if (target.kind === "group") {
          const { messages } = await client.getGroupMessageHistory({ group_id: target.id, count });
          return messages ?? [];
        }
        const { messages } = await client.getFriendMessageHistory({ user_id: target.id, count });
        return messages ?? [];
      });

    let entries: unknown[];
    try {
      // One extra message of headroom: the command itself is almost always the
      // newest entry and gets filtered out below, so asking for exactly `count`
      // would return `count - 1` messages of actual conversation.
      entries = await fetchHistory({ count: request.count + 1 });
    } catch (err) {
      log?.error?.(`[snowluma:${account.accountId}] /summary history fetch failed: ${String(err)}`);
      await notify(`获取最近聊天记录失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const peer = {
      peerId: msg.peerId,
      peerKind: msg.peerKind,
      groupId: msg.groupId,
      selfId: msg.selfId,
    };
    const messages = [...(Array.isArray(entries) ? entries : [])]
      .sort((a, b) => timeOf(a) - timeOf(b))
      .map((entry) => normalizeHistoryEntry(entry, peer))
      .filter((m): m is NormalizedMessage => m !== null)
      // The command message is an instruction, not conversation — and the
      // history call may or may not include it depending on timing.
      .filter((m) => m.messageId !== msg.messageId)
      .slice(-request.count);

    if (messages.length === 0) {
      await notify("最近没有可以总结的聊天记录。");
      return;
    }

    log?.info?.(
      `[snowluma:${account.accountId}] /summary for ${msg.peerId}: summarising ${messages.length} message(s) ` +
        `(requested ${request.count}, by ${msg.senderName}(${msg.senderId}))`,
    );

    await dispatch({
      kind: "summary",
      peerId: msg.peerId,
      peerKind: msg.peerKind,
      groupId: msg.groupId,
      messages,
      commandMessage: msg,
      trigger: { triggered: true, reason: "summary" },
      reason: "command",
    });
  } catch (err) {
    log?.error?.(`[snowluma:${account.accountId}] /summary failed: ${String(err)}`);
    await notify(`总结失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
