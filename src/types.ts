/**
 * SnowLuma channel plugin — configuration and inbound domain types.
 *
 * Everything the plugin needs from QQ arrives through `@snowluma/sdk`; we never
 * speak OneBot on the wire ourselves.
 */

// ── Receive modes ──────────────────────────────────────────────────────────

/**
 * Reply to a message the moment it is addressed at the bot: either an explicit
 * `@bot` mention or a configured keyword hit.
 */
export interface MentionModeConfig {
  /** Enable the mention/keyword trigger. Default: true. */
  enabled?: boolean;
  /** Require an `@bot` mention in group chats. Default: true. */
  requireMentionInGroup?: boolean;
  /** Keywords that trigger a reply without an `@bot` mention. */
  keywords?: string[];
  /** How `keywords` are matched against the message text. Default: "contains". */
  keywordMatch?: "contains" | "prefix" | "exact" | "regex";
  /** Case-sensitive keyword matching. Default: false. */
  caseSensitive?: boolean;
  /** Treat a reply to one of the bot's own messages as a trigger. Default: true. */
  triggerOnReplyToSelf?: boolean;
  /** Always reply in direct (private) chats, mention or not. Default: true. */
  alwaysReplyInDirect?: boolean;
}

/**
 * Periodically summarise what a chat has been talking about. Fires when either
 * `intervalMs` has elapsed since the window opened, or `maxMessages` have
 * accumulated — whichever comes first.
 */
export interface DigestModeConfig {
  /** Enable digest mode. Default: false. */
  enabled?: boolean;
  /** Flush the window after this many milliseconds. Default: 300000 (5 min). */
  intervalMs?: number;
  /** Flush the window once this many messages have accumulated. Default: 50. */
  maxMessages?: number;
  /** Never flush a window holding fewer messages than this. Default: 3. */
  minMessages?: number;
  /** Instruction prepended to the transcript when dispatching. */
  prompt?: string;
  /** Which chats to observe. Default: "group". */
  scope?: "group" | "direct" | "all";
  /** Only observe these peers (e.g. `group:123`). Empty/omitted means all in scope. */
  peers?: string[];
  /** Hard cap on transcript characters handed to the agent. Default: 20000. */
  maxTranscriptChars?: number;
}

/**
 * Coalesce a burst of messages that arrive within a sub-second window into one
 * agent turn, then answer immediately. This is the "type three lines in a row"
 * case — we want one reply, not three.
 */
export interface RealtimeModeConfig {
  /** Enable realtime coalescing. Default: true. */
  enabled?: boolean;
  /** Quiet period before flushing. Must be < 1000ms to stay "realtime". Default: 800. */
  windowMs?: number;
  /** Absolute ceiling on how long a burst may be held open. Default: 3000. */
  maxWindowMs?: number;
  /** Flush immediately once this many messages are buffered. Default: 10. */
  maxMessages?: number;
  /** Flush immediately once the buffered text reaches this many characters. Default: 8000. */
  maxChars?: number;
}

/**
 * A rolling per-peer buffer of recent messages, kept entirely separately from
 * the digest ("summary") queue. Every observed message accumulates here; when a
 * reply is triggered the whole buffer is handed to that turn as historical chat
 * context (and then drained), so the agent sees the surrounding conversation —
 * including messages that never addressed the bot — not just the triggering line.
 */
export interface HistoryModeConfig {
  /** Accumulate recent messages per peer as reply context. Default: true. */
  enabled?: boolean;
  /** Max messages of history kept per peer. Default: 20. */
  maxMessages?: number;
  /** Max total characters of history kept per peer. Default: 4000. */
  maxChars?: number;
  /**
   * Drop history messages whose QQ timestamp is older than this many ms at
   * snapshot time. `0` disables the age limit (count/chars still apply). Default: 0.
   */
  maxAgeMs?: number;
}

export interface ReceiveConfig {
  mention?: MentionModeConfig;
  digest?: DigestModeConfig;
  realtime?: RealtimeModeConfig;
  history?: HistoryModeConfig;
}

/** Fully-defaulted receive configuration. */
export interface ResolvedReceiveConfig {
  mention: Required<Omit<MentionModeConfig, "keywords">> & { keywords: string[] };
  digest: Required<Omit<DigestModeConfig, "peers" | "prompt">> & {
    peers: string[];
    prompt: string;
  };
  realtime: Required<RealtimeModeConfig>;
  history: Required<HistoryModeConfig>;
}

// ── Quote / forward resolution ─────────────────────────────────────────────

export interface QuoteConfig {
  /** Actively fetch quoted messages via `get_msg`. Default: true. */
  enabled?: boolean;
  /** Expand merged-forward payloads via `get_forward_msg`. Default: true. */
  resolveForward?: boolean;
  /** How deep to follow nested forwards. Default: 2. */
  maxDepth?: number;
  /** Cap on forwarded nodes rendered per forward. Default: 20. */
  maxNodes?: number;
  /** Cap on characters of resolved quote text injected into the body. Default: 4000. */
  maxChars?: number;
  /** Per-fetch timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
}

export type ResolvedQuoteConfig = Required<QuoteConfig>;

// ── Account configuration ──────────────────────────────────────────────────

/** Raw per-account config as written in `channels.snowluma`. */
export interface SnowLumaAccountConfig {
  enabled?: boolean;
  name?: string;
  /** SnowLuma OneBot WebSocket URL, e.g. `ws://127.0.0.1:3001/`. */
  wsUrl?: string;
  /** Optional HTTP API URL. When set, actions go over HTTP instead of the socket. */
  httpUrl?: string;
  /** SnowLuma access token. */
  accessToken?: string;
  /** Bot's own QQ number. Auto-detected via `get_login_info` when omitted. */
  selfId?: number | string;
  /** Allowed peers, e.g. `["private:123", "group:456", "*"]`. */
  allowFrom?: string[];
  /** Denied peers; evaluated after `allowFrom`. */
  denyFrom?: string[];
  /** React to inbound group messages that trigger the agent. Default: false. */
  groupAutoReact?: boolean;
  /** QQ emoji id used for `groupAutoReact`. Default: 1. */
  groupAutoReactEmojiId?: string | number;
  /** Send replies as QQ quote-replies to the triggering message. Default: true. */
  replyToTrigger?: boolean;
  /** Split outbound text into chunks of at most this many characters. Default: 4500. */
  textChunkLimit?: number;
  /** Request timeout for SnowLuma actions, in ms. Default: 30000. */
  requestTimeoutMs?: number;
  /** Debug mode: log the raw payload of every outbound message the plugin sends. Default: false. */
  debug?: boolean;
  /** Reconnect tuning handed to the SDK's WebSocket client. */
  reconnect?: {
    enabled?: boolean;
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
  };
  receive?: ReceiveConfig;
  quote?: QuoteConfig;
  /** Register the plugin's agent tools. Default: true. */
  tools?: { enabled?: boolean };
}

export interface SnowLumaChannelConfig extends SnowLumaAccountConfig {
  accounts?: Record<string, SnowLumaAccountConfig>;
}

/** An account with every default applied — what the runtime actually consumes. */
export interface ResolvedSnowLumaAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  wsUrl: string;
  httpUrl?: string;
  accessToken?: string;
  selfId?: number;
  allowFrom?: string[];
  denyFrom?: string[];
  groupAutoReact: boolean;
  groupAutoReactEmojiId: string | number;
  replyToTrigger: boolean;
  textChunkLimit: number;
  requestTimeoutMs: number;
  debug: boolean;
  reconnect: { enabled: boolean; retries: number; minDelayMs: number; maxDelayMs: number };
  receive: ResolvedReceiveConfig;
  quote: ResolvedQuoteConfig;
  toolsEnabled: boolean;
  /** The raw config this account was resolved from. */
  config: SnowLumaAccountConfig;
}

/** Minimal shape of the host config object the plugin reads. */
export interface SnowLumaHostConfig {
  channels?: {
    snowluma?: SnowLumaChannelConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Normalised inbound message ─────────────────────────────────────────────

export interface SnowLumaMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export type PeerKind = "group" | "direct";

/** A QQ message after segment parsing, before any aggregation. */
export interface NormalizedMessage {
  /** `group:<id>` or `private:<id>`. */
  peerId: string;
  peerKind: PeerKind;
  groupId?: number;
  senderId: number;
  senderName: string;
  selfId: number;
  messageId: number;
  /** Unix seconds, as reported by QQ. */
  time: number;
  /** Plain text with `at`/image/media segments stripped out. */
  text: string;
  /** `raw_message` straight from the event, CQ codes and all. */
  rawText: string;
  segments: SnowLumaMessageSegment[];
  /** QQ ids mentioned via `[CQ:at]`; `"all"` for `@全体成员`. */
  mentions: string[];
  atAll: boolean;
  imageUrls: string[];
  recordUrls: string[];
  /** Message id this message quotes, if any. */
  replyToId?: string;
  /** Merged-forward ids carried in the message. */
  forwardIds: string[];
}

/** Why the agent is being woken up. */
export type TriggerReason = "mention" | "keyword" | "direct" | "reply-to-self" | "digest";

export interface TriggerDecision {
  triggered: boolean;
  reason?: TriggerReason;
  /** The keyword that matched, when `reason === "keyword"`. */
  keyword?: string;
}

/** Quote/forward context resolved by actively querying SnowLuma. */
export interface ResolvedQuote {
  messageId: string;
  senderId?: number;
  senderName?: string;
  time?: number;
  text: string;
  /** Rendered nodes of any merged forward reachable from this quote. */
  forwardNodes: ResolvedForwardNode[];
  truncated: boolean;
}

export interface ResolvedForwardNode {
  senderId?: number;
  senderName?: string;
  time?: number;
  text: string;
  depth: number;
}
