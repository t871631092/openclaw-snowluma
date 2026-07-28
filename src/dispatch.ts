/**
 * Wave 2 module E — inbound → agent dispatch.
 *
 * Turns one `AggregatedBatch` (a coalesced realtime burst, or a periodic
 * digest window) into a single agent turn via the host's `pluginRuntime.channel.*`
 * helpers, then delivers whatever the agent replies with back to QQ. Every
 * dependency a test needs to fake — the runtime, quote resolution, and the
 * outbound senders — is injectable through `DispatchDeps`, so exercising this
 * module never requires a running OpenClaw host.
 *
 * `formatInboundEnvelope`'s installed type (`openclaw/plugin-sdk`) takes a
 * closed set of fields with no `imageUrls` param, unlike the reference OneBot
 * plugin this was modelled on (a newer/older SDK revision, presumably). Two
 * things carry image information forward regardless: `renderSegments` already
 * turns each image segment into a `[图片]` placeholder inline in the rendered
 * text, and `finalizeInboundContext` accepts a generic `Record<string, unknown>`
 * (unlike `formatInboundEnvelope`'s closed type), so raw URLs are additionally
 * threaded through as `MediaUrl`/`MediaUrls` on the finalized context — both are
 * already-declared `MsgContext` fields the agent runner reads for attachments.
 */

import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { AggregatedBatch } from "./aggregator.js";
import { OPENCLAW_EMPTY_INPUT_NOTICE, sendMedia as defaultSendMedia, sendText as defaultSendText } from "./outbound.js";
import { markdownToText } from "./markdown-text.js";
import { formatQuoteContext, resolveQuoteContext as defaultResolveQuoteContext } from "./quote.js";
import type { QuoteDeps } from "./quote.js";
import { getSnowLumaRuntime } from "./runtime.js";
import { renderSegments, sanitizeDisplayName } from "./segments.js";
import { stripLeadingMention } from "./triggers.js";
import type { NormalizedMessage, ResolvedQuote, ResolvedSnowLumaAccount } from "./types.js";

export interface DispatchLogger {
  info?(m: string): void;
  error?(m: string): void;
  debug?(m: string): void;
}

export interface DispatchDeps {
  account: ResolvedSnowLumaAccount;
  cfg: OpenClawConfig;
  client: SnowLumaApiClient;
  log?: DispatchLogger;
  /** Defaults to `getSnowLumaRuntime()`; injectable so tests need no host. */
  runtime?: PluginRuntime;
  /** Defaults to `resolveQuoteContext` from ./quote.js. */
  resolveQuote?: (msg: NormalizedMessage, deps: QuoteDeps) => Promise<ResolvedQuote | null>;
  /** Defaults to `sendText`/`sendMedia` from ./outbound.js. */
  send?: { sendText: typeof defaultSendText; sendMedia: typeof defaultSendMedia };
}

// ── Command authorization ───────────────────────────────────────────────

/**
 * Whether the sender of this batch may run privileged text commands (`/reset`,
 * etc). Delegates to the host's access-group gate when available, falling
 * back to a plain `allowFrom` allowlist check for a runtime that doesn't
 * expose the gate (e.g. a minimal test double).
 */
export function resolveInboundCommandAuthorization(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  peerId: string;
}): boolean {
  const { runtime, cfg, allowFrom, peerId } = params;
  const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;
  const senderAllowedForCommands =
    hasAllowFrom && allowFrom.some((pattern) => pattern === "*" || pattern === peerId);

  const resolveCommandAuthorized = runtime.channel.commands?.resolveCommandAuthorizedFromAuthorizers;
  if (typeof resolveCommandAuthorized !== "function") {
    return senderAllowedForCommands;
  }

  return resolveCommandAuthorized({
    useAccessGroups: cfg.commands?.useAccessGroups !== false,
    authorizers: [{ configured: hasAllowFrom, allowed: senderAllowedForCommands }],
    modeWhenAccessGroupsOff: hasAllowFrom ? "configured" : "deny",
  });
}

// ── Body composition ────────────────────────────────────────────────────

function formatHHMMSS(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Renders one message the same way for both the realtime body and the digest transcript. */
function renderMessageText(msg: NormalizedMessage): string {
  return renderSegments(msg.segments) || msg.text;
}

/** A `[HH:mm:ss] name(id): text` transcript line, shared by the digest and reply-history blocks. */
function renderTranscriptLine(msg: NormalizedMessage): string {
  const name = sanitizeDisplayName(msg.senderName);
  return `[${formatHHMMSS(msg.time)}] ${name}(${msg.senderId}): ${renderMessageText(msg)}`;
}

const HISTORY_HEADER = "【历史聊天记录（仅供参考上下文，请勿直接回复其中的旧消息）】";
const HISTORY_FOOTER = "【以上为历史消息；请针对下面这条最新消息进行回复】";

/** What `buildBatchBody` hands back to the dispatcher. */
export interface ComposedBody {
  body: string;
  rawBody: string;
  commandBody: string;
  imageUrls: string[];
  /**
   * True when `body` already carries the current sender's "name (id): " label
   * itself, so the caller must NOT also pass `sender` to the host envelope
   * formatter (which would prefix the whole body a second time).
   */
  senderLabelInBody: boolean;
}

/**
 * The host's own sender label ("name (id)", or whichever half is available),
 * mirrored step for step from `resolveSenderLabel` + `sanitizeEnvelopeHeaderPart`
 * so an in-body attribution is byte-identical to the one `formatInboundEnvelope`
 * would have produced. That is deliberately NOT `renderTranscriptLine`'s
 * `name(id)` shape: this label stands in for the host's prefix, so the current
 * message has to look the same to the agent whether or not a history block
 * pushed the attribution into the body.
 */
function renderSenderLabel(name: string, id: number): string {
  const display = name.trim();
  const idPart = String(id).trim();
  const label = display && idPart && display !== idPart ? `${display} (${idPart})` : display || idPart;
  return sanitizeDisplayName(label);
}

/**
 * Render the peer's accumulated reply-history buffer into a transcript block,
 * trimmed from the oldest end to `history.maxChars`. Empty string when there is
 * no history to show.
 */
function renderHistoryReference(
  history: NormalizedMessage[] | undefined,
  account: ResolvedSnowLumaAccount,
): string {
  if (!history || history.length === 0) return "";
  const limit = account.receive.history.maxChars;
  const lines = history.map(renderTranscriptLine);
  while (lines.length > 1 && lines.join("\n").length > limit) lines.shift();
  let transcript = lines.join("\n");
  if (transcript.length > limit) transcript = transcript.slice(-limit);
  return transcript;
}

function buildRealtimeBody(
  batch: AggregatedBatch,
  account: ResolvedSnowLumaAccount,
  quoteText: string,
): ComposedBody {
  const joined = batch.messages.map(renderMessageText).join("\n");
  // "Leading" is singular and applies once, to the front of the whole batch —
  // only the message that opened the window can plausibly start with "@bot".
  const text = stripLeadingMention(joined, account.selfId);
  const currentBlock = quoteText ? `${quoteText}\n${text}` : text;
  // Accumulated chat context is prepended to `body` only — never to
  // `rawBody`/`commandBody`, so the command parser still sees just the user's
  // actual input, not the surrounding history.
  const historyText = renderHistoryReference(batch.history, account);
  const imageUrls = batch.messages.flatMap((m) => m.imageUrls);
  if (!historyText) {
    return { body: currentBlock, rawBody: text, commandBody: text, imageUrls, senderLabelInBody: false };
  }

  // In a group the host prefixes the *whole* body with "name (id): ". With a
  // history block in front, that attribution lands on the transcript header and
  // the turn reads as if the current sender said every historical line. Attach
  // the label to the current message ourselves instead, and let the caller drop
  // the host-level prefix. (Direct chats get no such prefix — nothing to move.)
  const last = batch.messages[batch.messages.length - 1]!;
  const label = batch.peerKind === "group" ? renderSenderLabel(last.senderName, last.senderId) : "";
  const attributed = label ? `${label}: ${currentBlock}` : currentBlock;
  return {
    body: `${HISTORY_HEADER}\n${historyText}\n${HISTORY_FOOTER}\n${attributed}`,
    rawBody: text,
    commandBody: text,
    imageUrls,
    senderLabelInBody: label.length > 0,
  };
}

/**
 * Body shared by the two summarisation paths — the periodic digest and the
 * on-demand `/summary` command. Both are a synthetic prompt over a rendered
 * transcript; only the prompt and the character budget differ.
 */
function buildTranscriptBody(
  batch: AggregatedBatch,
  prompt: string,
  maxTranscriptChars: number,
): ComposedBody {
  const lines = batch.messages.map(renderTranscriptLine);
  // The aggregator already trims its buffer against `maxTranscriptChars`, but
  // that budget is measured on raw message text — the rendered
  // "[HH:mm:ss] name(id): text" lines are longer, so re-trim the actual
  // transcript we are about to send from the oldest end.
  while (lines.length > 1 && lines.join("\n").length > maxTranscriptChars) {
    lines.shift();
  }
  let transcript = lines.join("\n");
  if (transcript.length > maxTranscriptChars) {
    transcript = transcript.slice(-maxTranscriptChars);
  }

  const body = `${prompt}\n\n${transcript}`;
  // A summarisation turn is a synthetic prompt, not user input — giving it an
  // empty CommandBody/RawBody means there is no text for the command parser to
  // even look at, on top of CommandAuthorized always being false. (The
  // transcript itself may well contain a line that reads like "/reset".)
  return { body, rawBody: "", commandBody: "", imageUrls: [], senderLabelInBody: false };
}

/** Compose the agent-visible text for a batch (quote context, transcript, media placeholders). */
export function buildBatchBody(
  batch: AggregatedBatch,
  account: ResolvedSnowLumaAccount,
  quoteText: string,
): ComposedBody {
  if (batch.kind === "digest") {
    const { prompt, maxTranscriptChars } = account.receive.digest;
    return buildTranscriptBody(batch, prompt, maxTranscriptChars);
  }
  if (batch.kind === "summary") {
    const { prompt, maxTranscriptChars } = account.receive.summary;
    return buildTranscriptBody(batch, prompt, maxTranscriptChars);
  }
  return buildRealtimeBody(batch, account, quoteText);
}

/** The last message (scanning backward) that carries a quote or a forward — realtime only. */
function findQuoteSource(messages: NormalizedMessage[]): NormalizedMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.replyToId || m.forwardIds.length > 0) return m;
  }
  return undefined;
}

/**
 * Does a digest reply mean "nothing worth reporting"? The prompt asks for a
 * bare `SKIP`, but a model that dresses it up (`**SKIP**`, `## SKIP`,
 * `- skip`) means exactly the same thing. Emphasis is already gone by the time
 * this runs — the reply has been flattened — so all that is left to peel off is
 * the decoration `markdown-text.ts` itself adds for headings and list items.
 */
function isDigestSkip(text: string): boolean {
  const bare = text
    .trim()
    .replace(/^[•◦·｜]\s*/, "")
    .replace(/^【([\s\S]*)】$/, "$1")
    .trim();
  return bare.toUpperCase() === "SKIP";
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Hand one aggregated batch to the agent and stream its reply back to QQ.
 * Never rejects: every failure mode (quote resolution, the dispatch call
 * itself, a send) is caught and logged rather than thrown, so a bad batch
 * can never take the gateway's event loop down with it.
 */
export async function dispatchBatch(batch: AggregatedBatch, deps: DispatchDeps): Promise<void> {
  const { account, cfg, client, log } = deps;

  try {
    if (batch.messages.length === 0) return;

    const runtime = deps.runtime ?? getSnowLumaRuntime();
    const resolveQuote = deps.resolveQuote ?? defaultResolveQuoteContext;
    const send = deps.send ?? { sendText: defaultSendText, sendMedia: defaultSendMedia };

    // In debug mode, every outbound send records its raw payload. Emitted at
    // `info` level so it is actually visible when the operator flips the flag on.
    const outboundDebug = account.debug
      ? { log: (line: string) => log?.info?.(`[snowluma:${account.accountId}] ${line}`) }
      : undefined;

    const first = batch.messages[0]!;
    const last = batch.messages[batch.messages.length - 1]!;
    // Who the turn is attributed to. For a `/summary` batch that is the member
    // who typed the command — the transcript's own last speaker is incidental.
    const origin = batch.commandMessage ?? last;
    const address = `snowluma:${batch.peerId}`;

    runtime.channel.activity.record({ channel: "snowluma", accountId: account.accountId, direction: "inbound" });

    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: "snowluma",
      accountId: account.accountId,
      peer: { kind: batch.peerKind, id: batch.peerId },
    });

    let quoteText = "";
    if (batch.kind === "realtime") {
      const quoteSource = findQuoteSource(batch.messages);
      if (quoteSource) {
        try {
          const resolved = await resolveQuote(quoteSource, { client, quote: account.quote, log });
          quoteText = formatQuoteContext(resolved);
        } catch (err) {
          log?.error?.(`[snowluma:${account.accountId}] quote resolution failed: ${String(err)}`);
        }
      }
    }

    const composed = buildBatchBody(batch, account, quoteText);

    // A realtime turn that composed to nothing actionable — no text (e.g. a bare
    // `@bot` whose only content was the mention we stripped, or a reply-to-self
    // with an empty body), no quote, no history, and no image — would reach the
    // OpenClaw runtime as an empty inbound turn. The runtime answers that with a
    // canned "I didn't receive any text in your message. Please resend or add a
    // caption." which then gets posted back to QQ. Skip the dispatch entirely so
    // nothing is sent. (Digest turns always carry their prompt, so this never
    // fires for them.)
    if (batch.kind === "realtime" && composed.body.trim().length === 0 && composed.imageUrls.length === 0) {
      log?.debug?.(
        `[snowluma:${account.accountId}] skipping empty realtime turn for ${batch.peerId} (no text/quote/history/media)`,
      );
      return;
    }

    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    // In a group the host prefixes the body with "name (id): " and puts `from`
    // in the envelope header — correct for a realtime turn, wrong for a
    // summarisation one: a digest/summary body is our own prompt, not something
    // the last speaker said, and attributing it to them makes the agent read the
    // instruction as that user's message. Those turns therefore carry no sender
    // attribution at all.
    const isSummarisation = batch.kind !== "realtime";
    const envelopeBody = runtime.channel.reply.formatInboundEnvelope({
      channel: "SnowLuma",
      // `from` is required by the host's signature, so pass "" — it is
      // normalized away and the header part is dropped entirely.
      ...(isSummarisation
        ? { from: "" }
        : {
            from: last.senderName,
            // `composed.body` already carries the label when a history block
            // pushed it away from the front (see `buildRealtimeBody`); passing
            // `sender` too would re-prefix the whole body, transcript included.
            ...(composed.senderLabelInBody
              ? {}
              : { sender: { id: String(last.senderId), name: last.senderName } }),
          }),
      timestamp: origin.time * 1000,
      body: composed.body,
      chatType: batch.peerKind,
      envelope: envelopeOptions,
    });

    // A summarisation turn feeds the agent a chat window, not a command from a
    // specific user — it must never be able to run a privileged text command, so
    // CommandAuthorized is hard-wired false and CommandSource is omitted
    // entirely (rather than merely false) for those paths. `/summary` is no
    // exception: the user authorized a summary, not whatever the transcript
    // happens to contain.
    const commandAuthorized = isSummarisation
      ? false
      : resolveInboundCommandAuthorization({ runtime, cfg, allowFrom: account.allowFrom, peerId: batch.peerId });

    const mediaFields: Record<string, unknown> =
      composed.imageUrls.length > 0
        ? { MediaUrl: composed.imageUrls[0], MediaUrls: composed.imageUrls }
        : {};

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: envelopeBody,
      // `BodyForAgent` is what the runtime feeds the model as the turn's prompt.
      // We set it explicitly (rather than letting the host derive it) for two
      // reasons: (1) a digest turn passes empty-string RawBody/CommandBody, and
      // the host's `BodyForAgent ?? CommandBody ?? RawBody ?? Body` fallback stops
      // at the empty *string* (`??` only skips null/undefined) — which poisoned
      // BodyForAgent → BodyStripped → the whole turn to "", so the digest never
      // summarised and the host returned its canned "empty inbound" notice;
      // (2) it guarantees the agent sees the full composed body (reply-history +
      // quote context + transcript), not just the current line. Command routing
      // still reads the (empty, for digest) CommandBody, so digest stays inert.
      BodyForAgent: envelopeBody,
      RawBody: composed.rawBody,
      CommandBody: composed.commandBody,
      From: address,
      To: address,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: batch.peerKind,
      SenderId: String(origin.senderId),
      SenderName: origin.senderName,
      Provider: "snowluma",
      Surface: "snowluma",
      MessageSid: String(origin.messageId),
      Timestamp: origin.time * 1000,
      CommandAuthorized: commandAuthorized,
      ...(batch.kind === "realtime" ? { CommandSource: "text" as const } : {}),
      OriginatingChannel: "snowluma",
      OriginatingTo: address,
      ...mediaFields,
    });

    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

    const sendErrorNotice = async (errorText: string) => {
      try {
        await send.sendText({ client, to: address, text: errorText, chunkLimit: account.textChunkLimit, debug: outboundDebug });
      } catch (sendErr) {
        log?.error?.(`[snowluma:${account.accountId}] failed to send error notice: ${String(sendErr)}`);
      }
    };

    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (payload, _info) => {
          const trimmed = (payload.text ?? "").trim();

          // Never relay OpenClaw's canned "empty inbound" notice back to QQ. It
          // is produced by the runtime (not the agent) for turns it deems empty,
          // which we can't always detect upstream — drop it here as the reliable
          // backstop. Nothing else in such a payload is worth sending.
          if (trimmed.includes(OPENCLAW_EMPTY_INPUT_NOTICE)) {
            log?.info?.(`[snowluma:${account.accountId}] suppressed OpenClaw empty-input notice — nothing sent`);
            return;
          }

          const replyText = payload.text ?? "";
          // A summarisation reply is long structured Markdown, and QQ renders
          // none of it — `## 今日总结` / `**周四**` would arrive with the syntax
          // showing. Flatten it to chat-readable text first. Realtime replies
          // are short and conversational, so they go out untouched.
          const outgoingText = isSummarisation ? markdownToText(replyText) : replyText;

          // Checked on the FLATTENED text, before anything is sent: a model that
          // decorates its refusal (`**SKIP**`) would slip past a raw comparison
          // and then flatten right back to "SKIP" on the way out — i.e. the
          // digest that meant "nothing to report" posts the word to the group.
          if (batch.kind === "digest" && isDigestSkip(outgoingText)) {
            log?.info?.(`[snowluma:${account.accountId}] digest reply was SKIP — nothing sent`);
            return;
          }

          const mediaPaths: string[] = [];
          if (payload.mediaUrls?.length) mediaPaths.push(...payload.mediaUrls);
          if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl)) mediaPaths.push(payload.mediaUrl);

          for (const mediaPath of mediaPaths) {
            try {
              await send.sendMedia({ client, to: address, mediaPath, debug: outboundDebug });
            } catch (err) {
              log?.error?.(`[snowluma:${account.accountId}] media send failed: ${String(err)}`);
            }
          }

          // A media-only payload is legitimate — the images went out above.
          if (!replyText.trim()) return;
          if (!outgoingText.trim()) {
            log?.info?.(`[snowluma:${account.accountId}] reply was empty after markdown flattening — nothing sent`);
            return;
          }

          // A digest has nothing to quote-reply to; a realtime turn quotes the
          // message that opened the window, and a `/summary` turn quotes the
          // command itself.
          const replyToId = account.replyToTrigger
            ? batch.kind === "realtime"
              ? first.messageId
              : batch.commandMessage?.messageId
            : undefined;

          try {
            await send.sendText({
              client,
              to: address,
              text: outgoingText,
              replyToId,
              chunkLimit: account.textChunkLimit,
              debug: outboundDebug,
            });
            runtime.channel.activity.record({
              channel: "snowluma",
              accountId: account.accountId,
              direction: "outbound",
            });
          } catch (err) {
            log?.error?.(`[snowluma:${account.accountId}] send failed: ${String(err)}`);
          }
        },
        onError: async (err) => {
          log?.error?.(`[snowluma:${account.accountId}] dispatch error: ${String(err)}`);
          await sendErrorNotice(`[OpenClaw] Error: ${String(err).slice(0, 500)}`);
        },
      },
      replyOptions: {},
    });
  } catch (err) {
    deps.log?.error?.(`[snowluma:${deps.account.accountId}] dispatchBatch failed: ${String(err)}`);
  }
}
