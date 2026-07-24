/**
 * Agent tools exposed by the SnowLuma channel plugin: read-only lookups the
 * agent can call mid-conversation (chat history, group roster) without going
 * through the normal inbound message flow.
 *
 * Both tools resolve an account, borrow an API client for the duration of the
 * call (reusing the gateway's live socket when available, otherwise a
 * short-lived one), and always release it — even when the SDK call rejects.
 * Nothing here ever throws: SDK/config failures come back as a normal
 * `{ details: { status: "failed" } }` result so the agent can react to them.
 */
import type { SnowLumaApiClient, JsonObject } from "@snowluma/sdk";
// Type-only on purpose: `typebox` must NOT be a runtime import. OpenClaw's
// installer decides which dependencies actually exist next to the installed
// plugin, so the entry graphs' only runtime bare import stays `@snowluma/sdk`
// (and even that one is dynamic — see src/sdk.ts). The schemas below are plain
// JSON Schema literals, byte-identical to what `Type.Object(...)` emitted here
// (verified against typebox 1.1.37, whose builders return plain JSON objects).
import type { TSchema } from "typebox";
import type { ChannelAgentTool, OpenClawConfig } from "openclaw/plugin-sdk";
// Local, not `openclaw/plugin-sdk/core`, on purpose: keeping these out of this
// module keeps `setup-entry.js`'s runtime graph free of any `openclaw/*` import,
// which is what avoids the loader's `ERR_REQUIRE_ESM_RACE_CONDITION`. See params.ts.
import { readNumberParam, readStringParam } from "./params.js";
import { acquireActionClient as defaultAcquireActionClient } from "./client.js";
import { resolveSnowLumaAccount } from "./config.js";
import { formatTarget, parseTarget, type SendTarget } from "./outbound.js";
import { renderSegments, toSegments } from "./segments.js";
import type { ResolvedSnowLumaAccount, SnowLumaHostConfig } from "./types.js";

/** Lets tests swap in a fake client acquisition without touching `./client.js`. */
export interface ToolDeps {
  acquireActionClient?: (
    account: ResolvedSnowLumaAccount,
  ) => Promise<{ client: SnowLumaApiClient; release: () => void }>;
}

type ToolTextResult<TDetails> = { content: [{ type: "text"; text: string }]; details: TDetails };

/** Standard failure shape: never thrown, always returned. */
function failResult(text: string): ToolTextResult<{ status: "failed"; error: string }> {
  return { content: [{ type: "text", text }], details: { status: "failed", error: text } };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the account, acquire a client, run `fn`, and always release —
 * folding every failure mode (unconfigured account, acquire failure, SDK
 * rejection) into one `{ ok: false, error }` result instead of a throw.
 */
async function withAccountClient<T>(
  cfg: SnowLumaHostConfig,
  accountId: string | undefined,
  deps: ToolDeps,
  fn: (client: SnowLumaApiClient, account: ResolvedSnowLumaAccount) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const account = resolveSnowLumaAccount(cfg, accountId);
  if (!account.wsUrl && !account.httpUrl) {
    return {
      ok: false,
      error: `SnowLuma 账号「${account.accountId}」未配置 wsUrl/httpUrl，无法执行该操作。`,
    };
  }

  const acquire = deps.acquireActionClient ?? defaultAcquireActionClient;
  try {
    const { client, release } = await acquire(account);
    try {
      const value = await fn(client, account);
      return { ok: true, value };
    } finally {
      release();
    }
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function formatHHMMSS(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toTimeSeconds(entry: JsonObject): number {
  const raw = (entry as { time?: unknown }).time;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** History entries are untyped `JsonObject`s straight off the wire — read every field defensively. */
function renderHistoryLine(entry: JsonObject): string {
  const sender = (entry as { sender?: unknown }).sender;
  const senderObj = sender && typeof sender === "object" ? (sender as JsonObject) : {};
  const qq = senderObj.user_id ?? (entry as { user_id?: unknown }).user_id ?? "?";
  const nickname =
    typeof senderObj.nickname === "string" && senderObj.nickname.trim() ? senderObj.nickname : String(qq);
  const rawMessage =
    typeof (entry as { raw_message?: unknown }).raw_message === "string"
      ? ((entry as { raw_message?: unknown }).raw_message as string)
      : undefined;
  const text = renderSegments(toSegments((entry as { message?: unknown }).message, rawMessage));
  return `[${formatHHMMSS(toTimeSeconds(entry))}] ${nickname}(${qq}): ${text}`;
}

function renderMemberLine(member: JsonObject): string {
  const card = typeof member.card === "string" ? member.card.trim() : "";
  const nickname = typeof member.nickname === "string" ? member.nickname.trim() : "";
  const name = card || nickname || "?";
  const qq = member.user_id ?? "?";
  const role = typeof member.role === "string" && member.role ? member.role : "member";
  return `${name}(${qq}) — ${role}`;
}

const HistoryParams = {
  type: "object",
  required: ["target"],
  properties: {
    target: { type: "string", description: "会话目标：group:<群号> / private:<QQ号>，裸数字视为私聊。" },
    count: { type: "number", description: "返回的消息条数，默认 20，范围 1-100。" },
    messageSeq: {
      type: "number",
      description: "分页锚点（对应 SnowLuma 的 message_id），从该消息向更早翻页。",
    },
    accountId: { type: "string", description: "SnowLuma 账号 id，默认使用 default 账号。" },
  },
} as unknown as TSchema;

const GroupMembersParams = {
  type: "object",
  required: ["groupId"],
  properties: {
    groupId: {
      anyOf: [{ type: "number" }, { type: "string" }],
      description: "群号。",
    },
    noCache: { type: "boolean", description: "跳过缓存，强制向 SnowLuma 请求最新数据。" },
    limit: { type: "number", description: "返回的最大成员数，默认 100，范围 1-500。" },
    accountId: { type: "string", description: "SnowLuma 账号 id，默认使用 default 账号。" },
  },
} as unknown as TSchema;

/**
 * Builds the two SnowLuma agent tools. Matches `ChannelAgentToolFactory`'s
 * `(params: { cfg? }) => ChannelAgentTool[]` shape (the optional `deps` field
 * is additive, so this also works wherever a plain factory is expected).
 */
export function createSnowLumaAgentTools(
  params: { cfg?: OpenClawConfig; deps?: ToolDeps } = {},
): ChannelAgentTool[] {
  const deps: ToolDeps = params.deps ?? {};
  // `OpenClawConfig.channels` is a permissive index-signature bag at the host
  // level; `resolveSnowLumaAccount` only cares about the `channels.snowluma`
  // shape we control, so a structural cast is safe here.
  const hostCfg = (params.cfg ?? {}) as unknown as SnowLumaHostConfig;

  const getHistory: ChannelAgentTool = {
    name: "snowluma_get_history",
    label: "SnowLuma 聊天记录",
    description: "获取指定 QQ 群聊或私聊的历史消息（通过 SnowLuma）。按时间从旧到新渲染。",
    parameters: HistoryParams,
    async execute(_toolCallId, rawParams) {
      try {
        const p = (rawParams ?? {}) as Record<string, unknown>;
        const targetRaw = readStringParam(p, "target", { required: true });
        const accountId = readStringParam(p, "accountId");
        const count = clampInt(readNumberParam(p, "count"), 1, 100, 20);
        const messageSeq = readNumberParam(p, "messageSeq");

        let target: SendTarget;
        try {
          target = parseTarget(targetRaw);
        } catch (err) {
          return failResult(`无法解析 target "${targetRaw}"：${describeError(err)}`);
        }

        const result = await withAccountClient(hostCfg, accountId, deps, async (client) => {
          if (target.kind === "group") {
            const { messages } = await client.getGroupMessageHistory({
              group_id: target.id,
              count,
              message_id: messageSeq,
            });
            return messages ?? [];
          }
          const { messages } = await client.getFriendMessageHistory({
            user_id: target.id,
            count,
            message_id: messageSeq,
          });
          return messages ?? [];
        });

        if (!result.ok) {
          return failResult(`获取历史消息失败：${result.error}`);
        }

        const ordered = [...result.value].sort((a, b) => toTimeSeconds(a) - toTimeSeconds(b));
        const text = ordered.length > 0 ? ordered.map(renderHistoryLine).join("\n") : "（无历史消息）";
        return {
          content: [{ type: "text", text }],
          details: {
            status: "ok" as const,
            target: formatTarget(target),
            count: ordered.length,
            messages: ordered,
          },
        };
      } catch (err) {
        return failResult(`snowluma_get_history 执行失败：${describeError(err)}`);
      }
    },
  };

  const getGroupMembers: ChannelAgentTool = {
    name: "snowluma_get_group_members",
    label: "SnowLuma 群成员列表",
    description: "获取指定 QQ 群的成员列表（通过 SnowLuma）。",
    parameters: GroupMembersParams,
    async execute(_toolCallId, rawParams) {
      try {
        const p = (rawParams ?? {}) as Record<string, unknown>;
        const groupIdRaw = p.groupId;
        const groupId = typeof groupIdRaw === "number" ? groupIdRaw : Number(groupIdRaw);
        if (!Number.isFinite(groupId)) {
          return failResult(`无效的 groupId："${String(groupIdRaw)}"`);
        }
        const accountId = readStringParam(p, "accountId");
        const limit = clampInt(readNumberParam(p, "limit"), 1, 500, 100);
        const noCache = typeof p.noCache === "boolean" ? p.noCache : undefined;

        const result = await withAccountClient(hostCfg, accountId, deps, (client) =>
          client.getGroupMemberList(groupId, { noCache }),
        );

        if (!result.ok) {
          return failResult(`获取群成员失败：${result.error}`);
        }

        const members = result.value ?? [];
        const total = members.length;
        const shown = members.slice(0, limit);
        let text = shown.length > 0 ? shown.map(renderMemberLine).join("\n") : "（该群暂无成员信息）";
        if (total > limit) {
          text += `\n（仅显示前 ${limit} / 共 ${total} 名成员）`;
        }
        return {
          content: [{ type: "text", text }],
          details: { status: "ok" as const, groupId, total, shown: shown.length, members: shown },
        };
      } catch (err) {
        return failResult(`snowluma_get_group_members 执行失败：${describeError(err)}`);
      }
    },
  };

  return [getHistory, getGroupMembers];
}
