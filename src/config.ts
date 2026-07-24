import {
  getDefaultAccessToken,
  getDefaultHttpUrl,
  getDefaultSelfId,
  getDefaultWsUrl,
} from "./env.js";
import type {
  ResolvedQuoteConfig,
  ResolvedReceiveConfig,
  ResolvedSnowLumaAccount,
  SnowLumaAccountConfig,
  SnowLumaChannelConfig,
  SnowLumaHostConfig,
} from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

export const DEFAULT_DIGEST_PROMPT =
  "以下是这段时间的群聊记录。请用简洁的中文归纳讨论的主题、结论和待办事项；" +
  "如果没有值得汇报的内容，只回复 SKIP。";

export const RECEIVE_DEFAULTS: ResolvedReceiveConfig = {
  mention: {
    enabled: true,
    requireMentionInGroup: true,
    keywords: [],
    keywordMatch: "contains",
    caseSensitive: false,
    triggerOnReplyToSelf: true,
    alwaysReplyInDirect: true,
  },
  digest: {
    enabled: false,
    intervalMs: 300_000,
    maxMessages: 50,
    minMessages: 3,
    prompt: DEFAULT_DIGEST_PROMPT,
    scope: "group",
    peers: [],
    maxTranscriptChars: 20_000,
  },
  realtime: {
    enabled: true,
    windowMs: 800,
    maxWindowMs: 3_000,
    maxMessages: 10,
    maxChars: 8_000,
  },
};

export const QUOTE_DEFAULTS: ResolvedQuoteConfig = {
  enabled: true,
  resolveForward: true,
  maxDepth: 2,
  maxNodes: 20,
  maxChars: 4_000,
  timeoutMs: 10_000,
};

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

function resolveReceive(raw: SnowLumaAccountConfig["receive"]): ResolvedReceiveConfig {
  const mention = raw?.mention ?? {};
  const digest = raw?.digest ?? {};
  const realtime = raw?.realtime ?? {};

  const keywordMatch = mention.keywordMatch;
  const scope = digest.scope;

  const digestMaxMessages = positiveInt(digest.maxMessages, RECEIVE_DEFAULTS.digest.maxMessages);

  return {
    mention: {
      enabled: bool(mention.enabled, RECEIVE_DEFAULTS.mention.enabled),
      requireMentionInGroup: bool(
        mention.requireMentionInGroup,
        RECEIVE_DEFAULTS.mention.requireMentionInGroup,
      ),
      keywords: stringList(mention.keywords),
      keywordMatch:
        keywordMatch === "prefix" || keywordMatch === "exact" || keywordMatch === "regex"
          ? keywordMatch
          : RECEIVE_DEFAULTS.mention.keywordMatch,
      caseSensitive: bool(mention.caseSensitive, RECEIVE_DEFAULTS.mention.caseSensitive),
      triggerOnReplyToSelf: bool(
        mention.triggerOnReplyToSelf,
        RECEIVE_DEFAULTS.mention.triggerOnReplyToSelf,
      ),
      alwaysReplyInDirect: bool(
        mention.alwaysReplyInDirect,
        RECEIVE_DEFAULTS.mention.alwaysReplyInDirect,
      ),
    },
    digest: {
      enabled: bool(digest.enabled, RECEIVE_DEFAULTS.digest.enabled),
      intervalMs: positiveInt(digest.intervalMs, RECEIVE_DEFAULTS.digest.intervalMs),
      maxMessages: digestMaxMessages,
      // A window that can never reach its minimum would never flush.
      minMessages: Math.min(
        positiveInt(digest.minMessages, RECEIVE_DEFAULTS.digest.minMessages),
        digestMaxMessages,
      ),
      prompt:
        typeof digest.prompt === "string" && digest.prompt.trim()
          ? digest.prompt.trim()
          : RECEIVE_DEFAULTS.digest.prompt,
      scope: scope === "direct" || scope === "all" ? scope : RECEIVE_DEFAULTS.digest.scope,
      peers: stringList(digest.peers),
      maxTranscriptChars: positiveInt(
        digest.maxTranscriptChars,
        RECEIVE_DEFAULTS.digest.maxTranscriptChars,
      ),
    },
    realtime: {
      enabled: bool(realtime.enabled, RECEIVE_DEFAULTS.realtime.enabled),
      windowMs: nonNegativeInt(realtime.windowMs, RECEIVE_DEFAULTS.realtime.windowMs),
      maxWindowMs: positiveInt(realtime.maxWindowMs, RECEIVE_DEFAULTS.realtime.maxWindowMs),
      maxMessages: positiveInt(realtime.maxMessages, RECEIVE_DEFAULTS.realtime.maxMessages),
      maxChars: positiveInt(realtime.maxChars, RECEIVE_DEFAULTS.realtime.maxChars),
    },
  };
}

function resolveQuote(raw: SnowLumaAccountConfig["quote"]): ResolvedQuoteConfig {
  const quote = raw ?? {};
  return {
    enabled: bool(quote.enabled, QUOTE_DEFAULTS.enabled),
    resolveForward: bool(quote.resolveForward, QUOTE_DEFAULTS.resolveForward),
    maxDepth: nonNegativeInt(quote.maxDepth, QUOTE_DEFAULTS.maxDepth),
    maxNodes: positiveInt(quote.maxNodes, QUOTE_DEFAULTS.maxNodes),
    maxChars: positiveInt(quote.maxChars, QUOTE_DEFAULTS.maxChars),
    timeoutMs: positiveInt(quote.timeoutMs, QUOTE_DEFAULTS.timeoutMs),
  };
}

function resolveSelfId(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** List every configured SnowLuma account id. */
export function listSnowLumaAccountIds(cfg: SnowLumaHostConfig): string[] {
  const ids = new Set<string>();
  const section = cfg?.channels?.snowluma;

  if (section?.wsUrl || section?.httpUrl) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  for (const [accountId, account] of Object.entries(section?.accounts ?? {})) {
    if (account?.wsUrl || account?.httpUrl) {
      ids.add(accountId);
    }
  }

  return Array.from(ids);
}

/**
 * Resolve one account: explicit config always wins, then environment fallbacks
 * (default account only), then built-in defaults.
 */
export function resolveSnowLumaAccount(
  cfg: SnowLumaHostConfig,
  accountId?: string | null,
): ResolvedSnowLumaAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const section: SnowLumaChannelConfig = cfg?.channels?.snowluma ?? {};

  let accountConfig: SnowLumaAccountConfig;
  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    const { accounts: _accounts, ...rest } = section;
    accountConfig = rest;
  } else {
    accountConfig = section.accounts?.[resolvedAccountId] ?? {};
  }

  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const wsUrl =
    accountConfig.wsUrl ?? (isDefaultAccount ? getDefaultWsUrl() : undefined) ?? "";
  const httpUrl = accountConfig.httpUrl ?? (isDefaultAccount ? getDefaultHttpUrl() : undefined);
  const accessToken =
    accountConfig.accessToken ?? (isDefaultAccount ? getDefaultAccessToken() : undefined);
  const selfId =
    resolveSelfId(accountConfig.selfId) ?? (isDefaultAccount ? getDefaultSelfId() : undefined);

  const reconnect = accountConfig.reconnect ?? {};

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    wsUrl,
    httpUrl,
    accessToken,
    selfId,
    allowFrom: accountConfig.allowFrom,
    denyFrom: accountConfig.denyFrom,
    groupAutoReact: accountConfig.groupAutoReact === true,
    groupAutoReactEmojiId: accountConfig.groupAutoReactEmojiId ?? 1,
    replyToTrigger: bool(accountConfig.replyToTrigger, true),
    textChunkLimit: positiveInt(accountConfig.textChunkLimit, 4500),
    requestTimeoutMs: positiveInt(accountConfig.requestTimeoutMs, 30_000),
    reconnect: {
      enabled: bool(reconnect.enabled, true),
      // Unset means "retry forever"; an explicit number — including 0, meaning
      // "never retry" — is honoured as written.
      retries:
        reconnect.retries == null
          ? Number.POSITIVE_INFINITY
          : nonNegativeInt(reconnect.retries, Number.POSITIVE_INFINITY),
      minDelayMs: positiveInt(reconnect.minDelayMs, 1_000),
      maxDelayMs: positiveInt(reconnect.maxDelayMs, 30_000),
    },
    receive: resolveReceive(accountConfig.receive),
    quote: resolveQuote(accountConfig.quote),
    toolsEnabled: bool(accountConfig.tools?.enabled, true),
    config: accountConfig,
  };
}

/** Write setup-wizard input back into the host config (immutably). */
export function applySnowLumaAccountConfig(
  cfg: SnowLumaHostConfig,
  accountId: string,
  input: {
    wsUrl?: string;
    httpUrl?: string;
    accessToken?: string;
    selfId?: number | string;
    name?: string;
  },
): SnowLumaHostConfig {
  const patch: SnowLumaAccountConfig = {
    enabled: true,
    ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    ...(input.selfId != null && input.selfId !== "" ? { selfId: input.selfId } : {}),
    ...(input.name ? { name: input.name } : {}),
  };

  const section: SnowLumaChannelConfig = cfg?.channels?.snowluma ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg?.channels,
        snowluma: { ...section, ...patch },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg?.channels,
      snowluma: {
        ...section,
        enabled: section.enabled !== false,
        accounts: {
          ...section.accounts,
          [accountId]: { ...section.accounts?.[accountId], ...patch },
        },
      },
    },
  };
}

/**
 * Peer authorization. `allowFrom` is an allowlist (unset ⇒ allow everyone);
 * `denyFrom` always wins.
 */
export function isPeerAllowed(
  account: Pick<ResolvedSnowLumaAccount, "allowFrom" | "denyFrom">,
  peerId: string,
): boolean {
  const matches = (patterns: string[] | undefined) =>
    Array.isArray(patterns) &&
    patterns.some((pattern) => pattern === "*" || pattern === peerId);

  if (matches(account.denyFrom)) return false;
  if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
    return matches(account.allowFrom);
  }
  return true;
}
