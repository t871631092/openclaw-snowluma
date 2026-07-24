/**
 * Active quote/forward resolution.
 *
 * QQ only sends a bare `{type:"reply",data:{id}}` (or `{type:"forward",data:{id}}`)
 * in the inbound message — the referenced content has to be actively fetched via
 * `get_msg` / `get_forward_msg`. This module does that fetching, defensively,
 * because both actions return untyped `JsonObject` (the SDK does not model the
 * message-history/forward-node payload shape) and because a slow or dead
 * SnowLuma instance must never take the inbound pipeline down with it.
 */

import type { SnowLumaApiClient } from "@snowluma/sdk";
import { extractForwardIds, renderSegments, toSegments } from "./segments.js";
import type {
  NormalizedMessage,
  ResolvedForwardNode,
  ResolvedQuote,
  ResolvedQuoteConfig,
  SnowLumaMessageSegment,
} from "./types.js";

export interface QuoteDeps {
  client: Pick<SnowLumaApiClient, "getMessage" | "getForwardMessage">;
  quote: ResolvedQuoteConfig;
  log?: { debug?(m: string): void; error?(m: string): void };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

interface ParsedMessageLike {
  senderId?: number;
  senderName?: string;
  time?: number;
  segments: SnowLumaMessageSegment[];
  messageId?: string;
}

/**
 * Both `get_msg` and `get_forward_msg` hand back untyped `JsonObject`s that in
 * practice look like a OneBot message record (`sender`, `time`, `message` or
 * `raw_message`, `message_id`). Read every field defensively — a shape mismatch
 * should degrade the rendered text, never throw.
 */
function parseMessageLike(raw: unknown): ParsedMessageLike {
  const obj = isRecord(raw) ? raw : {};
  const sender = isRecord(obj.sender) ? obj.sender : undefined;
  const senderId = numberOrUndefined(sender?.user_id ?? obj.user_id);
  const senderName = stringOrUndefined(sender?.card) ?? stringOrUndefined(sender?.nickname);
  const time = numberOrUndefined(obj.time);
  const rawMessage = stringOrUndefined(obj.raw_message);
  const content = obj.message ?? obj.content ?? rawMessage;
  const segments = toSegments(content, rawMessage);
  const messageId = obj.message_id != null ? String(obj.message_id) : undefined;
  return { senderId, senderName, time, segments, messageId };
}

/** Shared budget/cycle-guard threaded through one forward-expansion tree. */
interface ForwardWalkState {
  visited: Set<string>;
  remaining: number;
  truncated: boolean;
}

async function walkForward(
  forwardId: string,
  deps: QuoteDeps,
  depth: number,
  state: ForwardWalkState,
): Promise<ResolvedForwardNode[]> {
  if (state.remaining <= 0) {
    state.truncated = true;
    return [];
  }
  if (state.visited.has(forwardId)) return [];
  state.visited.add(forwardId);

  let messages: unknown[];
  try {
    const result = await deps.client.getForwardMessage(
      { id: forwardId },
      { timeoutMs: deps.quote.timeoutMs },
    );
    messages = Array.isArray(result?.messages) ? result.messages : [];
  } catch (err) {
    deps.log?.error?.(`[snowluma] getForwardMessage(${forwardId}) failed: ${String(err)}`);
    state.remaining -= 1;
    return [{ text: "[引用消息获取失败]", depth }];
  }

  const nodes: ResolvedForwardNode[] = [];
  for (const raw of messages) {
    if (state.remaining <= 0) {
      state.truncated = true;
      break;
    }
    const parsed = parseMessageLike(raw);
    state.remaining -= 1;
    nodes.push({
      senderId: parsed.senderId,
      senderName: parsed.senderName,
      time: parsed.time,
      text: renderSegments(parsed.segments),
      depth,
    });

    if (depth < deps.quote.maxDepth) {
      for (const nestedId of extractForwardIds(parsed.segments)) {
        if (state.remaining <= 0) {
          state.truncated = true;
          break;
        }
        const nested = await walkForward(nestedId, deps, depth + 1, state);
        nodes.push(...nested);
      }
    }
  }
  return nodes;
}

/** Expand one merged-forward id into flattened nodes, recursing to `quote.maxDepth`. */
export async function resolveForwardNodes(
  forwardId: string,
  deps: QuoteDeps,
  depth = 0,
): Promise<ResolvedForwardNode[]> {
  const state: ForwardWalkState = { visited: new Set(), remaining: deps.quote.maxNodes, truncated: false };
  return walkForward(forwardId, deps, depth, state);
}

function applyCharBudget(
  text: string,
  forwardNodes: ResolvedForwardNode[],
  maxChars: number,
): { text: string; forwardNodes: ResolvedForwardNode[]; truncated: boolean } {
  let remaining = Math.max(0, maxChars);
  let truncated = false;

  let outText = text;
  if (outText.length > remaining) {
    outText = outText.slice(0, remaining);
    truncated = true;
  }
  remaining -= outText.length;

  const outNodes: ResolvedForwardNode[] = [];
  for (const node of forwardNodes) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (node.text.length > remaining) {
      outNodes.push({ ...node, text: node.text.slice(0, remaining) });
      remaining = 0;
      truncated = true;
    } else {
      outNodes.push(node);
      remaining -= node.text.length;
    }
  }
  if (outNodes.length < forwardNodes.length) truncated = true;

  return { text: outText, forwardNodes: outNodes, truncated };
}

/** Actively fetch the quoted message (get_msg) and any merged forwards (get_forward_msg). */
export async function resolveQuoteContext(
  msg: NormalizedMessage,
  deps: QuoteDeps,
): Promise<ResolvedQuote | null> {
  if (!deps.quote.enabled) return null;
  if (!msg.replyToId && msg.forwardIds.length === 0) return null;

  let messageId = msg.replyToId ?? String(msg.messageId);
  let senderId: number | undefined;
  let senderName: string | undefined;
  let time: number | undefined;
  let text = "";
  let quoteForwardIds: string[] = [];

  if (msg.replyToId) {
    const numericReplyId = Number(msg.replyToId);
    try {
      // `get_msg` takes a numeric message id; a non-numeric reply id would send
      // `NaN` (serialised as `null`) and depend on the server rejecting it.
      // Fail fast locally to the placeholder instead of round-tripping garbage.
      if (!Number.isFinite(numericReplyId)) {
        throw new Error(`non-numeric reply id "${msg.replyToId}"`);
      }
      const raw = await deps.client.getMessage(numericReplyId, {
        timeoutMs: deps.quote.timeoutMs,
      });
      const parsed = parseMessageLike(raw);
      senderId = parsed.senderId;
      senderName = parsed.senderName;
      time = parsed.time;
      text = renderSegments(parsed.segments);
      quoteForwardIds = extractForwardIds(parsed.segments);
      if (parsed.messageId) messageId = parsed.messageId;
    } catch (err) {
      deps.log?.error?.(`[snowluma] getMessage(${msg.replyToId}) failed: ${String(err)}`);
      text = "[引用消息获取失败]";
    }
  }

  const forwardNodes: ResolvedForwardNode[] = [];
  let forwardTruncated = false;

  if (deps.quote.resolveForward) {
    const state: ForwardWalkState = { visited: new Set(), remaining: deps.quote.maxNodes, truncated: false };
    const forwardIds = [...msg.forwardIds, ...quoteForwardIds];
    for (const forwardId of forwardIds) {
      if (state.remaining <= 0) {
        state.truncated = true;
        break;
      }
      const nodes = await walkForward(forwardId, deps, 0, state);
      forwardNodes.push(...nodes);
    }
    forwardTruncated = state.truncated;
  }

  const budgeted = applyCharBudget(text, forwardNodes, deps.quote.maxChars);

  return {
    messageId,
    senderId,
    senderName,
    time,
    text: budgeted.text,
    forwardNodes: budgeted.forwardNodes,
    truncated: forwardTruncated || budgeted.truncated,
  };
}

function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatWho(senderName: string | undefined, senderId: number | undefined): string {
  if (senderName) return senderId !== undefined ? `${senderName}(${senderId})` : senderName;
  return senderId !== undefined ? String(senderId) : "未知";
}

/** Render a resolved quote for injection into the agent-visible body. */
export function formatQuoteContext(quote: ResolvedQuote | null): string {
  if (!quote) return "";

  const hasSender = quote.senderName !== undefined || quote.senderId !== undefined || quote.time !== undefined;
  const timeSuffix = quote.time !== undefined ? ` 于 ${formatTime(quote.time)}` : "";
  const header = hasSender
    ? `[引用 ${formatWho(quote.senderName, quote.senderId)}${timeSuffix} 的消息：${quote.text}`
    : `[引用消息：${quote.text}`;

  const lines = [header];
  for (const node of quote.forwardNodes) {
    const indent = "  ".repeat(node.depth + 1);
    const nodeTimeSuffix = node.time !== undefined ? ` ${formatTime(node.time)}` : "";
    lines.push(`${indent}- ${formatWho(node.senderName, node.senderId)}${nodeTimeSuffix}：${node.text}`);
  }

  return lines.join("\n") + (quote.truncated ? "（已截断）]" : "]");
}
