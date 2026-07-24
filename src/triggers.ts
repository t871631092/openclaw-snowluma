/**
 * Receive-mode A: mention/keyword triggering.
 *
 * Pure decision logic — given one normalized message and a resolved account,
 * decide whether (and why) the agent should wake up. No I/O, no timers.
 */

import type {
  MentionModeConfig,
  NormalizedMessage,
  ResolvedSnowLumaAccount,
  TriggerDecision,
} from "./types.js";

/** Mirrors `MentionModeConfig["keywordMatch"]` — kept in sync via `NonNullable` rather than duplicated. */
export type MentionKeywordMatch = NonNullable<MentionModeConfig["keywordMatch"]>;

export interface EvaluateTriggerOptions {
  /** Lets the caller answer "did the bot send this message id?" without this module knowing about history storage. */
  isSelfMessageId?: (id: string) => boolean;
}

/**
 * Find the first keyword in `keywords` that matches `text` under `match` mode.
 * Returns the matched keyword (not the match position) so callers can surface
 * *why* a message triggered, or `undefined` when nothing matched.
 */
export function matchKeyword(
  text: string,
  keywords: string[],
  match: MentionKeywordMatch,
  caseSensitive: boolean,
): string | undefined {
  if (!text || keywords.length === 0) return undefined;

  for (const keyword of keywords) {
    if (!keyword) continue;

    if (match === "regex") {
      // A user-supplied pattern can be malformed; that must degrade to "no
      // match" for this one keyword, never blow up trigger evaluation.
      let re: RegExp;
      try {
        re = new RegExp(keyword, caseSensitive ? "" : "i");
      } catch {
        continue;
      }
      if (re.test(text)) return keyword;
      continue;
    }

    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? keyword : keyword.toLowerCase();

    if (match === "prefix") {
      if (haystack.trimStart().startsWith(needle)) return keyword;
    } else if (match === "exact") {
      if (haystack.trim() === needle) return keyword;
    } else {
      // "contains" — also the fallback for any unrecognised mode.
      if (haystack.includes(needle)) return keyword;
    }
  }

  return undefined;
}

const LEADING_WHITESPACE = /^\s+/;
/** A raw, unparsed `[CQ:at,qq=...]` remnant that may still be sitting at the front of a string. */
const LEADING_CQ_AT = /^\[CQ:at,qq=(\d+|all)(?:,[^\]]*)?\]/;
/** A rendered "@name" token — QQ clients display mentions by nickname, not id. */
const LEADING_AT_TOKEN = /^@\S+/;

/**
 * Strip a leading "@bot" token (rendered `@name` or a raw CQ `at` remnant)
 * plus surrounding whitespace, so the agent sees "帮我查天气" rather than
 * "@bot 帮我查天气". `selfId`, when given, restricts CQ-remnant stripping to
 * mentions of the bot itself (or `@全体成员`); a rendered `@name` token is
 * always stripped since we cannot compare a display name to a numeric id.
 */
export function stripLeadingMention(text: string, selfId?: number): string {
  let result = text;

  for (;;) {
    const trimmed = result.replace(LEADING_WHITESPACE, "");

    const cqMatch = LEADING_CQ_AT.exec(trimmed);
    if (cqMatch) {
      const qq = cqMatch[1];
      // The numeric `qq` is directly comparable to `selfId`, so only strip a
      // CQ mention that is actually the bot (or @全体成员). When `selfId` is
      // unknown we deliberately keep it — stripping unconditionally would
      // delete a leading mention of some *other* user.
      if (qq === "all" || (selfId !== undefined && Number(qq) === selfId)) {
        result = trimmed.slice(cqMatch[0].length);
        continue;
      }
      result = trimmed;
      break;
    }

    const atMatch = LEADING_AT_TOKEN.exec(trimmed);
    // `\S+` is greedy and CJK text has no ASCII whitespace, so "@bot你好"
    // (a mention with no trailing space — common in QQ) would otherwise match
    // the *entire* remaining string and wipe the whole message. Only strip
    // when a delimiter bounded the token; if it swallowed everything we can't
    // tell where the name ends, so leave the text intact.
    if (atMatch && atMatch[0].length < trimmed.length) {
      result = trimmed.slice(atMatch[0].length);
      continue;
    }

    result = trimmed;
    break;
  }

  return result.replace(LEADING_WHITESPACE, "");
}

/**
 * Decide whether `msg` should wake the agent, and why. Rules are evaluated in
 * the order documented in the module contract; the first matching rule wins.
 * `mention.enabled === false` is an absolute override — nothing else in this
 * function can trigger regardless of message content.
 */
export function evaluateTrigger(
  msg: NormalizedMessage,
  account: ResolvedSnowLumaAccount,
  opts?: EvaluateTriggerOptions,
): TriggerDecision {
  const mention = account.receive.mention;
  if (!mention.enabled) {
    return { triggered: false };
  }

  const isGroup = msg.peerKind === "group";
  const isDirect = !isGroup;

  if (isDirect && mention.alwaysReplyInDirect) {
    return { triggered: true, reason: "direct" };
  }

  // `atAll` is deliberately never consulted here — @全体成员 is not a mention
  // of the bot specifically, and mention detection cannot fire without a
  // known selfId (we will not guess who "the bot" is).
  if (isGroup && account.selfId !== undefined && msg.mentions.includes(String(account.selfId))) {
    return { triggered: true, reason: "mention" };
  }

  if (
    isGroup &&
    mention.triggerOnReplyToSelf &&
    msg.replyToId !== undefined &&
    opts?.isSelfMessageId?.(msg.replyToId)
  ) {
    return { triggered: true, reason: "reply-to-self" };
  }

  const keywordHit = matchKeyword(msg.text, mention.keywords, mention.keywordMatch, mention.caseSensitive);
  if (keywordHit !== undefined) {
    return { triggered: true, reason: "keyword", keyword: keywordHit };
  }

  if (isGroup) {
    if (mention.requireMentionInGroup) {
      return { triggered: false };
    }
    // requireMentionInGroup === false: no keywords configured means nothing
    // gates the reply; keywords configured but unmatched means the keyword
    // check above was the (failed) gate.
    if (mention.keywords.length === 0) {
      return { triggered: true };
    }
    return { triggered: false };
  }

  // Direct chat, alwaysReplyInDirect is off, and no keyword matched.
  return { triggered: false };
}
