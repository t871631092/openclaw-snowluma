/**
 * Outbound sending: target parsing, text chunking, and the SnowLuma message builders.
 *
 * Everything here goes through the injected `SnowLumaApiClient` action methods and the
 * SDK's `messages` builders (`text`/`image`/`record`/`reply`) — no raw OneBot payloads.
 */

import type { SnowLumaApiClient } from "@snowluma/sdk";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
// The `text`/`image`/`record`/`reply` builders come from the lazy registry:
// every caller reaches here after `acquireActionClient` (which awaits
// `ensureSnowLumaSdk()`), so the synchronous lookup is always satisfied.
// A static SDK value import would defeat the load-time self-patch — see src/sdk.ts.
import { getSnowLumaSdk } from "./sdk.js";

// ── Targets ──────────────────────────────────────────────────────────────

export interface SendTarget {
  kind: "group" | "private";
  id: number;
}

const TARGET_PREFIX = "snowluma:";

/**
 * Accepts `snowluma:group:1`, `group:1`, `private:2`, `snowluma:2` (bare id, after the
 * channel prefix is stripped ⇒ private), and a bare `12345` (⇒ private).
 */
export function parseTarget(to: string): SendTarget {
  const trimmed = typeof to === "string" ? to.trim() : "";
  if (!trimmed) {
    throw new Error(`Invalid SnowLuma target: ${JSON.stringify(to)}`);
  }

  // Case-insensitive to match `channel.ts`'s `normalizeTarget` (`/^snowluma:/i`);
  // otherwise a mixed-case `SnowLuma:group:1` would normalize fine there but be
  // rejected here as an unknown target kind.
  const withoutChannel = trimmed.toLowerCase().startsWith(TARGET_PREFIX)
    ? trimmed.slice(TARGET_PREFIX.length)
    : trimmed;
  const parts = withoutChannel.split(":");

  let kind: "group" | "private";
  let idPart: string;
  if (parts.length === 1) {
    kind = "private";
    idPart = parts[0]!;
  } else if (parts.length === 2) {
    const [kindPart, id] = parts as [string, string];
    if (kindPart !== "group" && kindPart !== "private") {
      throw new Error(`Invalid SnowLuma target: ${JSON.stringify(to)} (unknown kind "${kindPart}")`);
    }
    kind = kindPart;
    idPart = id;
  } else {
    throw new Error(`Invalid SnowLuma target: ${JSON.stringify(to)}`);
  }

  if (!/^\d+$/.test(idPart)) {
    throw new Error(`Invalid SnowLuma target: ${JSON.stringify(to)} (id "${idPart}" is not numeric)`);
  }

  return { kind, id: Number(idPart) };
}

export function formatTarget(t: SendTarget): string {
  return `${TARGET_PREFIX}${t.kind}:${t.id}`;
}

// ── Text chunking ────────────────────────────────────────────────────────

const CQ_CODE_PATTERN = /\[CQ:[^\]]*\]/g;

/**
 * Splits `text` into chunks of at most `limit` characters, preferring to break right
 * after a newline when one falls within the limit, and never cutting inside a
 * `[CQ:...]` code even if that forces a chunk over `limit` (an unsplit code is the
 * only way to honor both constraints at once).
 */
export function chunkText(text: string, limit: number): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`chunkText: limit must be a positive number, got ${limit}`);
  }

  const protectedSpans: Array<[number, number]> = [];
  for (const match of text.matchAll(CQ_CODE_PATTERN)) {
    const start = match.index ?? 0;
    protectedSpans.push([start, start + match[0].length]);
  }
  const isInsideProtected = (index: number): boolean =>
    protectedSpans.some(([start, end]) => index > start && index < end);

  const chunks: string[] = [];
  const len = text.length;
  let start = 0;

  while (start < len) {
    // When everything that remains already fits within `limit`, emit it as a
    // single final chunk. The newline preference below is only meant to pick a
    // break point for a *forced* split (text longer than `limit`); without this
    // guard a mid-text newline makes it break anyway, so a short multi-line
    // message that fits comfortably gets scattered across several QQ sends.
    if (len - start <= limit) {
      chunks.push(text.slice(start));
      break;
    }

    const hardCap = Math.min(start + limit, len);
    let newlineSplit = -1;
    let lastSafe = -1;

    for (let i = start + 1; i <= hardCap; i++) {
      if (isInsideProtected(i)) continue;
      lastSafe = i;
      if (text[i - 1] === "\n") newlineSplit = i;
    }

    let splitAt: number;
    if (newlineSplit !== -1) {
      splitAt = newlineSplit;
    } else if (lastSafe !== -1) {
      splitAt = lastSafe;
    } else {
      // Everything up to `hardCap` sits inside one CQ code — extend past the limit to
      // that code's end rather than slice through it.
      let i = hardCap + 1;
      while (i <= len && isInsideProtected(i)) i++;
      splitAt = Math.min(i, len);
    }

    chunks.push(text.slice(start, splitAt));
    start = splitAt;
  }

  return chunks;
}

const DEFAULT_CHUNK_LIMIT = 4500; // matches config.ts's default `textChunkLimit`

/**
 * Stable phrase from OpenClaw's runtime "empty inbound" notice
 * ("I didn't receive any text in your message. Please resend or add a caption.").
 * The runtime emits it (not the agent) for turns it deems empty. We never want it
 * posted to QQ, so `sendText` drops any outbound text containing it — this is the
 * universal chokepoint every outbound path (gateway reply dispatch AND the
 * host-initiated channel adapter) funnels through, so blocking it here catches it
 * no matter which layer produced it. Matched as a substring to survive a response
 * prefix or trailing wording tweaks. See also the higher-level guards in
 * dispatch.ts (skip / deliver-drop) and channel.ts.
 */
export const OPENCLAW_EMPTY_INPUT_NOTICE = "I didn't receive any text in your message";

/** True when `text` is (or contains) OpenClaw's canned empty-inbound notice. */
export function isOpenClawEmptyInputNotice(text: string | undefined | null): boolean {
  return typeof text === "string" && text.includes(OPENCLAW_EMPTY_INPUT_NOTICE);
}

// ── Debug logging ──────────────────────────────────────────────────────────
//
// When debug mode is on, callers pass an `OutboundDebug` sink and every send
// records the raw payload it is about to hand to SnowLuma. This is the single
// chokepoint both outbound paths (gateway replies via dispatch.ts, and
// host-initiated sends via channel.ts) pass through, so wiring it here covers
// both. The sink is just a `(line) => void` so it stays trivially testable and
// leaves the "which log level / sink" decision to the caller.

export interface OutboundDebug {
  log: (line: string) => void;
}

/** SnowLuma message builders expose the raw OneBot segments via `.toSegments()`. */
function serializeOutgoingMessage(message: unknown): unknown {
  if (message && typeof (message as { toSegments?: unknown }).toSegments === "function") {
    try {
      return (message as { toSegments: () => unknown }).toSegments();
    } catch {
      // Fall through to the raw object if the builder can't render segments.
    }
  }
  return message;
}

function emitOutboundDebug(debug: OutboundDebug | undefined, method: string, target: SendTarget, detail: Record<string, unknown>): void {
  if (!debug) return;
  let serialized: string;
  try {
    serialized = JSON.stringify({ target, ...detail });
  } catch {
    serialized = String(detail);
  }
  debug.log(`[snowluma:outbound] ${method} ${formatTarget(target)} ${serialized}`);
}

// ── Sending ──────────────────────────────────────────────────────────────

async function dispatchOutgoing(
  client: SnowLumaApiClient,
  target: SendTarget,
  message: Parameters<SnowLumaApiClient["sendGroupMessage"]>[1],
): Promise<{ message_id: number }> {
  return target.kind === "group"
    ? client.sendGroupMessage(target.id, message)
    : client.sendPrivateMessage(target.id, message);
}

/**
 * Chunks `text` and sends each piece in order. When `replyToId` is given, only the
 * first chunk carries the `reply(...)` segment — later chunks are plain continuations
 * of the same reply, not additional quotes of the original message.
 */
export async function sendText(params: {
  client: SnowLumaApiClient;
  to: string;
  text: string;
  replyToId?: string | number;
  chunkLimit?: number;
  debug?: OutboundDebug;
}): Promise<{ messageIds: string[] }> {
  const { client, to, text: body, replyToId, chunkLimit = DEFAULT_CHUNK_LIMIT, debug } = params;
  const target = parseTarget(to);

  // Universal chokepoint: never send OpenClaw's canned empty-inbound notice to QQ,
  // whichever upstream path produced this reply. Returns as if nothing was queued.
  if (isOpenClawEmptyInputNotice(body)) {
    debug?.log(`[snowluma:outbound] suppressed empty-inbound notice to ${formatTarget(target)}`);
    return { messageIds: [] };
  }

  const chunks = chunkText(body, chunkLimit);

  const messageIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const { reply, text } = getSnowLumaSdk();
    const chunkReplyToId = i === 0 ? replyToId : undefined;
    const outgoing = chunkReplyToId !== undefined ? reply(chunkReplyToId).text(chunk) : text(chunk);
    emitOutboundDebug(debug, target.kind === "group" ? "sendGroupMessage" : "sendPrivateMessage", target, {
      chunk: `${i + 1}/${chunks.length}`,
      replyToId: chunkReplyToId,
      message: serializeOutgoingMessage(outgoing),
    });
    const result = await dispatchOutgoing(client, target, outgoing);
    messageIds.push(String(result.message_id));
  }

  return { messageIds };
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".ogg",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".amr",
  ".silk",
  ".opus",
]);

function extensionOf(mediaPath: string): string {
  const withoutQuery = mediaPath.split(/[?#]/)[0] ?? mediaPath;
  const dot = withoutQuery.lastIndexOf(".");
  const slash = Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return withoutQuery.slice(dot).toLowerCase();
}

/**
 * Leaves `http(s)://` and `file://` URIs untouched; converts a bare absolute
 * local path to `file://`.
 *
 * `isAbsolute`/`pathToFileURL` follow the *host* OS's path semantics. That is
 * correct here because media paths originate from the co-located OpenClaw host
 * (the agent's reply pipeline), so they are always in the running host's native
 * format — we intentionally do not try to interpret foreign-OS path strings.
 */
function toFileUri(mediaPath: string): string {
  if (/^(https?|file):\/\//i.test(mediaPath)) return mediaPath;
  if (isAbsolute(mediaPath)) return pathToFileURL(mediaPath).href;
  return mediaPath;
}

/** Pulls whatever id-like field the action returned, for a uniform `messageIds` result. */
function extractSentId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const data = result as { message_id?: unknown; file_id?: unknown };
  if (data.message_id != null) return String(data.message_id);
  if (data.file_id != null) return String(data.file_id);
  return undefined;
}

/**
 * Sends `mediaPath` as an image or voice message when its extension matches a known
 * media type; anything else falls back to a group/private file upload, since OneBot
 * has no generic "send arbitrary file inline" message segment. `caption`, if given, is
 * sent as a separate text message after the media.
 */
export async function sendMedia(params: {
  client: SnowLumaApiClient;
  to: string;
  mediaPath: string;
  caption?: string;
  debug?: OutboundDebug;
}): Promise<{ messageIds: string[] }> {
  const { client, to, mediaPath, caption, debug } = params;
  const target = parseTarget(to);
  const fileRef = toFileUri(mediaPath);
  const ext = extensionOf(mediaPath);

  const messageIds: string[] = [];
  let mediaResult: unknown;
  if (IMAGE_EXTENSIONS.has(ext)) {
    const outgoing = getSnowLumaSdk().image(fileRef);
    emitOutboundDebug(debug, "sendImage", target, { mediaPath, fileRef, message: serializeOutgoingMessage(outgoing) });
    mediaResult = await dispatchOutgoing(client, target, outgoing);
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    const outgoing = getSnowLumaSdk().record(fileRef);
    emitOutboundDebug(debug, "sendRecord", target, { mediaPath, fileRef, message: serializeOutgoingMessage(outgoing) });
    mediaResult = await dispatchOutgoing(client, target, outgoing);
  } else if (target.kind === "group") {
    emitOutboundDebug(debug, "upload_group_file", target, { mediaPath, fileRef, params: { group_id: target.id, file: fileRef } });
    mediaResult = await client.raw("upload_group_file", { group_id: target.id, file: fileRef });
  } else {
    emitOutboundDebug(debug, "upload_private_file", target, { mediaPath, fileRef, params: { user_id: target.id, file: fileRef } });
    mediaResult = await client.raw("upload_private_file", { user_id: target.id, file: fileRef });
  }
  const mediaId = extractSentId(mediaResult);
  if (mediaId !== undefined) messageIds.push(mediaId);

  if (caption && caption.trim()) {
    const captionResult = await sendText({ client, to, text: caption, debug });
    messageIds.push(...captionResult.messageIds);
  }

  return { messageIds };
}

/** Wraps `setMsgEmojiLike`; never throws — failures come back as `{ ok: false, error }`. */
export async function reactToMessage(
  client: SnowLumaApiClient,
  messageId: string | number,
  emojiId: string | number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.setMsgEmojiLike(Number(messageId), String(emojiId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
