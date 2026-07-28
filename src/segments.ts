/**
 * Inbound message segment parsing.
 *
 * `event.message` from `@snowluma/sdk` is typed only as `JsonValue` at the SDK
 * level (OneBot servers may run in "array" or "string" message format, and some
 * proxies hand back a bare plain string in place of either). Everything
 * downstream (`triggers.ts`, `aggregator.ts`, `quote.ts`) wants one normalized
 * `SnowLumaMessageSegment[]` shape, so all three inbound shapes funnel through
 * `toSegments` here rather than each caller re-deriving it.
 */

import type { OneBotGroupMessageEvent, OneBotMessageEvent } from "@snowluma/sdk";
// `parseSegments` comes from the lazy registry: a static SDK value import here
// would pull the (possibly still unpatched) SDK into the entry graphs before
// the self-patch in `./sdk.js` can run. See src/sdk.ts.
import { getSnowLumaSdk } from "./sdk.js";
import type { NormalizedMessage, SnowLumaMessageSegment } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First candidate that stringifies to something non-empty, else undefined. */
function firstNonEmpty(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

/**
 * Normalize any of the three inbound `message` shapes (a real segment array,
 * a CQ-code string, or a plain string) into plain segment objects. Never
 * throws: unparseable input degrades to a single `text` segment (preferring
 * `rawMessage` when it was supplied) or, failing that, `[]`.
 */
export function toSegments(message: unknown, rawMessage?: string): SnowLumaMessageSegment[] {
  try {
    if (Array.isArray(message)) {
      const segs = message
        .filter(isRecord)
        .filter((item) => typeof item.type === "string")
        .map((item) => ({
          type: item.type as string,
          data: isRecord(item.data) ? (item.data as Record<string, unknown>) : {},
        }));
      if (segs.length > 0) return segs;
      // Array present but nothing usable in it — fall through to the plain
      // text fallback below rather than reporting no content at all.
    } else if (typeof message === "string" && message.length > 0) {
      // The SDK's CQ parser handles both shapes here: a string with no
      // `[CQ:...]` codes comes back as a single `text` segment, same as a
      // plain string would need to. In production the gateway loads the SDK
      // before any event reaches this point; if the registry is somehow not
      // loaded yet, `getSnowLumaSdk` throws and the catch below degrades to
      // the plain-text fallback instead of dropping the message.
      return getSnowLumaSdk()
        .parseSegments(message)
        .map((seg) => ({
          type: seg.type,
          data: isRecord(seg.data) ? (seg.data as Record<string, unknown>) : {},
        }));
    }
  } catch {
    // Malformed input of some kind — degrade below instead of throwing.
  }

  const fallbackText = firstNonEmpty(rawMessage, typeof message === "string" ? message : undefined);
  return fallbackText ? [{ type: "text", data: { text: fallbackText } }] : [];
}

/** Concatenated `text` segment content, trimmed. */
export function extractText(segments: SnowLumaMessageSegment[]): string {
  return segments
    .filter((seg) => seg.type === "text")
    .map((seg) => (typeof seg.data.text === "string" ? seg.data.text : ""))
    .join("")
    .trim();
}

/** QQ ids mentioned via `at`; `@全体成员` (`qq === "all"`) sets `atAll` instead. */
export function extractMentions(segments: SnowLumaMessageSegment[]): {
  mentions: string[];
  atAll: boolean;
} {
  const mentions: string[] = [];
  let atAll = false;
  for (const seg of segments) {
    if (seg.type !== "at") continue;
    const qq = seg.data.qq;
    if (qq === "all") {
      atAll = true;
    } else if (typeof qq === "string" && qq.length > 0) {
      mentions.push(qq);
    } else if (typeof qq === "number") {
      mentions.push(String(qq));
    }
  }
  return { mentions, atAll };
}

export function extractImageUrls(segments: SnowLumaMessageSegment[]): string[] {
  const urls: string[] = [];
  for (const seg of segments) {
    if (seg.type !== "image") continue;
    const url = firstNonEmpty(seg.data.url, seg.data.file);
    if (url) urls.push(url);
  }
  return urls;
}

export function extractRecordUrls(segments: SnowLumaMessageSegment[]): string[] {
  const urls: string[] = [];
  for (const seg of segments) {
    if (seg.type !== "record") continue;
    const url = firstNonEmpty(seg.data.url, seg.data.file);
    if (url) urls.push(url);
  }
  return urls;
}

export function extractReplyToId(segments: SnowLumaMessageSegment[]): string | undefined {
  for (const seg of segments) {
    // Reject empty-string ids the same way `extractForwardIds` does, so a
    // malformed `{type:"reply",data:{id:""}}` wire payload is treated as "no
    // reply" consistently across the two extractors (and their `quote.ts` gates).
    if (seg.type === "reply" && seg.data.id != null && String(seg.data.id).length > 0) {
      return String(seg.data.id);
    }
  }
  return undefined;
}

export function extractForwardIds(segments: SnowLumaMessageSegment[]): string[] {
  const ids: string[] = [];
  for (const seg of segments) {
    if (seg.type !== "forward") continue;
    const id = seg.data.id ?? seg.data.res_id ?? seg.data.forward_id;
    if (id != null && String(id).length > 0) ids.push(String(id));
  }
  return ids;
}

const PLACEHOLDERS: Record<string, string> = {
  image: "[图片]",
  record: "[语音]",
  face: "[表情]",
  video: "[视频]",
  file: "[文件]",
  forward: "[合并转发]",
};

/**
 * Flatten a display name to a single safe line, mirroring the host's
 * `sanitizeEnvelopeHeaderPart`.
 *
 * Every nickname/group card we put into an agent-visible body is free-form text
 * chosen by a remote user: `dispatch.ts` uses them for transcript lines and the
 * current-message label, `quote.ts` for the `[引用 …]` header and its forward
 * nodes. Left raw, a nickname containing a newline opens a brand-new line in
 * those blocks — one the agent reads as a separate message from someone else,
 * including after the "reply to this one" footer. Brackets fold to parentheses
 * so a name cannot imitate our own `[HH:mm:ss]`/`[图片]`/`[引用 …]` markers.
 */
export function sanitizeDisplayName(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Human-readable rendering for the agent: text flows inline, `at` becomes
 * `@<name or qq>`, everything else collapses to a `[placeholder]`. `reply` is
 * intentionally omitted here — `quote.ts` actively resolves and injects that
 * content elsewhere in the body, so rendering it here would duplicate it.
 */
export function renderSegments(segments: SnowLumaMessageSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      const text = typeof seg.data.text === "string" ? seg.data.text : "";
      if (text) parts.push(text);
    } else if (seg.type === "at") {
      // `seg.data.name` is the mentioned member's group card — remote free-form
      // text like every other display name, and it reaches the agent through
      // the transcript lines this renders. Flatten it for the same reason
      // `renderTranscriptLine` flattens the sender's own nickname: otherwise a
      // card containing a newline forges a whole extra line in the transcript,
      // and its owner never has to say a word to plant it — being @-mentioned
      // once by someone else is enough.
      const raw = seg.data.qq === "all" ? "全体成员" : (firstNonEmpty(seg.data.name, seg.data.qq) ?? "");
      parts.push(`@${sanitizeDisplayName(raw)}`);
    } else if (seg.type === "reply") {
      continue;
    } else if (Object.hasOwn(PLACEHOLDERS, seg.type)) {
      // `Object.hasOwn`, not `in`: a segment whose type collides with an
      // inherited `Object.prototype` key ("constructor", "toString", …) must
      // fall through to the generic `[type]` placeholder, not resolve to a
      // prototype member and render as "function Object() { [native code] }".
      parts.push(PLACEHOLDERS[seg.type]);
    } else {
      parts.push(`[${seg.type}]`);
    }
  }
  return parts.join("");
}

/**
 * Normalize one entry from `get_group_msg_history` / `get_friend_msg_history`
 * into the same shape a live event produces.
 *
 * History entries arrive as untyped `JsonObject`s (the SDK types them no more
 * precisely than the wire does) and, unlike an event, carry no reliable
 * `message_type`/`group_id`/`self_id` — the caller already knows which peer it
 * asked about, so that context is passed in via `peer`. Returns `null` when the
 * entry has no usable sender or message id, so a malformed row is skipped
 * rather than rendered as `?(?)`.
 */
export function normalizeHistoryEntry(
  entry: unknown,
  peer: { peerId: string; peerKind: NormalizedMessage["peerKind"]; groupId?: number; selfId: number },
): NormalizedMessage | null {
  if (!isRecord(entry)) return null;

  const sender = isRecord(entry.sender) ? entry.sender : {};
  const senderId = Number(sender.user_id ?? entry.user_id);
  const messageId = Number(entry.message_id);
  if (!Number.isFinite(senderId) || !Number.isFinite(messageId)) return null;

  const rawMessage = typeof entry.raw_message === "string" ? entry.raw_message : "";
  const segments = toSegments(entry.message, rawMessage);
  const { mentions, atAll } = extractMentions(segments);
  const time = Number(entry.time);
  const senderName = firstNonEmpty(sender.card, sender.nickname) ?? String(senderId);

  return {
    peerId: peer.peerId,
    peerKind: peer.peerKind,
    groupId: peer.groupId,
    senderId,
    senderName,
    selfId: peer.selfId,
    messageId,
    time: Number.isFinite(time) ? time : 0,
    text: extractText(segments),
    rawText: rawMessage,
    segments,
    mentions,
    atAll,
    imageUrls: extractImageUrls(segments),
    recordUrls: extractRecordUrls(segments),
    replyToId: extractReplyToId(segments),
    forwardIds: extractForwardIds(segments),
  };
}

/** Build the fully-normalized message the rest of the plugin operates on. */
export function normalizeMessageEvent(event: OneBotMessageEvent): NormalizedMessage {
  const segments = toSegments(event.message, event.raw_message);
  const { mentions, atAll } = extractMentions(segments);
  const isGroup = event.message_type === "group";
  const groupId = isGroup ? (event as OneBotGroupMessageEvent).group_id : undefined;
  const senderName = firstNonEmpty(event.sender?.card, event.sender?.nickname) ?? String(event.user_id);

  return {
    peerId: isGroup ? `group:${groupId}` : `private:${event.user_id}`,
    peerKind: isGroup ? "group" : "direct",
    groupId,
    senderId: event.user_id,
    senderName,
    selfId: event.self_id,
    messageId: event.message_id,
    time: event.time,
    text: extractText(segments),
    rawText: event.raw_message,
    segments,
    mentions,
    atAll,
    imageUrls: extractImageUrls(segments),
    recordUrls: extractRecordUrls(segments),
    replyToId: extractReplyToId(segments),
    forwardIds: extractForwardIds(segments),
  };
}
