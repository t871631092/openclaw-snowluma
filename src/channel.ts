/**
 * The `ChannelPlugin<ResolvedSnowLumaAccount>` surface the OpenClaw host binds
 * against — config resolution, setup wizard wiring, outbound sending, the
 * shared `message` tool's `react` action, agent tools, gateway lifecycle, and
 * status snapshots. Modelled closely on the OneBot reference plugin, but every
 * adapter shape here was checked against this repo's installed
 * `openclaw/plugin-sdk` `.d.ts` files rather than copied blind.
 */

import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { acquireActionClient } from "./client.js";
import {
  DEFAULT_ACCOUNT_ID,
  applySnowLumaAccountConfig,
  listSnowLumaAccountIds,
  resolveSnowLumaAccount,
} from "./config.js";
import { snowLumaConfigSchema } from "./config-schema.js";
import { startGateway } from "./gateway.js";
import {
  isOpenClawEmptyInputNotice,
  parseTarget,
  reactToMessage,
  sendMedia as outboundSendMedia,
  sendText as outboundSendText,
} from "./outbound.js";
import type { OutboundDebug } from "./outbound.js";
import { createSnowLumaAgentTools } from "./tools.js";
import type { ResolvedSnowLumaAccount, SnowLumaHostConfig } from "./types.js";

const SNOWLUMA_MESSAGE_ACTIONS = ["react"] as const;

/**
 * Debug sink for host-initiated sends. Unlike the gateway reply path (which has
 * an injected `log`), the `ChannelOutboundContext` carries no logger, so raw
 * outbound payloads go to `console` — the operator-visible sink on a gateway.
 */
function outboundDebugFor(account: ResolvedSnowLumaAccount): OutboundDebug | undefined {
  if (!account.debug) return undefined;
  return { log: (line: string) => console.info(`[snowluma:${account.accountId}] ${line}`) };
}

function createActionResult<TDetails>(text: string, details: TDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/** Every place this plugin receives an `OpenClawConfig`, `channels.snowluma` is our narrower `SnowLumaHostConfig` shape. */
function asHostConfig(cfg: unknown): SnowLumaHostConfig {
  return (cfg ?? {}) as SnowLumaHostConfig;
}

export const snowLumaPlugin: ChannelPlugin<ResolvedSnowLumaAccount> = {
  id: "snowluma",
  meta: {
    id: "snowluma",
    label: "SnowLuma",
    selectionLabel: "SnowLuma (QQ)",
    docsPath: "/docs/channels/snowluma",
    blurb: "Connect to QQ via the SnowLuma SDK (OneBot 11 under the hood)",
    order: 56,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.snowluma"] },
  configSchema: snowLumaConfigSchema,
  messaging: {
    normalizeTarget: (target) => target.replace(/^snowluma:/i, ""),
    targetResolver: {
      looksLikeId: (id) => {
        try {
          parseTarget(id);
          return true;
        } catch {
          return false;
        }
      },
      hint: "group:<群号> / private:<QQ号>，裸数字视为私聊",
    },
  },
  config: {
    listAccountIds: (cfg) => listSnowLumaAccountIds(asHostConfig(cfg)),
    resolveAccount: (cfg, accountId) => resolveSnowLumaAccount(asHostConfig(cfg), accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account?.wsUrl),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl),
    }),
  },
  setup: {
    validateInput: ({ input, accountId }) => {
      if (!input.token && !input.useEnv) {
        return "SnowLuma requires --token (format: wsUrl[,accessToken[,httpUrl[,selfId]]]) or --use-env (SNOWLUMA_WS_URL, SNOWLUMA_ACCESS_TOKEN, SNOWLUMA_HTTP_URL, SNOWLUMA_SELF_ID)";
      }
      // Env fallback is default-account-only (see `resolveSnowLumaAccount`), so
      // `--use-env` against a named account would write an `{enabled:true}` entry
      // with no wsUrl — a silently non-functional, unlisted account. Reject it
      // up front instead of reporting a misleading success.
      if (input.useEnv && !input.token && accountId !== DEFAULT_ACCOUNT_ID) {
        return `--use-env only configures the default account; pass --token for account "${accountId}".`;
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let wsUrl: string | undefined;
      let accessToken: string | undefined;
      let httpUrl: string | undefined;
      let selfId: string | undefined;

      if (input.token) {
        const parts = input.token.split(",");
        wsUrl = parts[0]?.trim() || undefined;
        accessToken = parts[1]?.trim() || undefined;
        httpUrl = parts[2]?.trim() || undefined;
        selfId = parts[3]?.trim() || undefined;
      }

      const nextHostCfg = applySnowLumaAccountConfig(asHostConfig(cfg), accountId, {
        wsUrl,
        httpUrl,
        accessToken,
        selfId,
        name: input.name,
      });
      return nextHostCfg as unknown as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4500,
    sendText: async (ctx) => {
      // Same suppression as the gateway reply path, for host-initiated sends:
      // never relay OpenClaw's canned empty-inbound notice. Return benignly
      // (nothing sent) rather than letting the empty-messageId guard below throw.
      if (isOpenClawEmptyInputNotice(ctx.text)) {
        return { channel: "snowluma", messageId: "" };
      }
      const account = resolveSnowLumaAccount(asHostConfig(ctx.cfg), ctx.accountId);
      const { client, release } = await acquireActionClient(account);
      try {
        const result = await outboundSendText({
          client,
          to: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId ?? undefined,
          chunkLimit: account.textChunkLimit,
          debug: outboundDebugFor(account),
        });
        const messageId = result.messageIds[result.messageIds.length - 1];
        if (!messageId) {
          throw new Error("SnowLuma sendText did not return a messageId");
        }
        return { channel: "snowluma", messageId };
      } finally {
        release();
      }
    },
    sendMedia: async (ctx) => {
      if (!ctx.mediaUrl) {
        throw new Error("SnowLuma sendMedia requires mediaUrl");
      }
      const account = resolveSnowLumaAccount(asHostConfig(ctx.cfg), ctx.accountId);
      const { client, release } = await acquireActionClient(account);
      try {
        const result = await outboundSendMedia({
          client,
          to: ctx.to,
          mediaPath: ctx.mediaUrl,
          caption: ctx.text,
          debug: outboundDebugFor(account),
        });
        const messageId = result.messageIds[0];
        if (!messageId) {
          throw new Error("SnowLuma sendMedia did not return a messageId");
        }
        return { channel: "snowluma", messageId };
      } finally {
        release();
      }
    },
  },
  actions: {
    describeMessageTool: ({ cfg, accountId }) => {
      // Scope discovery to the account actually being asked about, so a
      // configured named account isn't judged by the (possibly empty) default
      // account's wsUrl and vice versa.
      const account = resolveSnowLumaAccount(asHostConfig(cfg), accountId);
      if (!account.enabled || !account.wsUrl) {
        return null;
      }
      return {
        actions: [...SNOWLUMA_MESSAGE_ACTIONS],
      };
    },
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, cfg, params, accountId, toolContext }) => {
      if (action !== "react") {
        return createActionResult(`Unsupported SnowLuma action: ${action}`, {
          ok: false,
          channel: "snowluma",
          action,
          error: `Unsupported SnowLuma action: ${action}`,
        });
      }

      const messageId = params.message_id ?? params.messageId ?? params.message ?? toolContext?.currentMessageId;
      const emojiId = params.emoji_id ?? params.emojiId ?? params.emoji ?? params.reaction;

      // Guard `messageId` for blank-after-trim too — otherwise `""` slips past
      // `== null` and `reactToMessage` reacts to `Number("") === 0`.
      if (
        messageId == null ||
        String(messageId).trim() === "" ||
        emojiId == null ||
        String(emojiId).trim() === ""
      ) {
        const error = "SnowLuma react requires `emoji` and `message_id` (or current message context).";
        return createActionResult(error, { ok: false, channel: "snowluma", action, error });
      }

      const account = resolveSnowLumaAccount(asHostConfig(cfg), accountId);
      // Acquire inside the try so a connect/HTTP failure becomes the same
      // structured `{ok:false}` result as every other error here, rather than
      // escaping as an unhandled rejection.
      let client: SnowLumaApiClient;
      let release: () => void;
      try {
        ({ client, release } = await acquireActionClient(account));
      } catch (err) {
        const error = `SnowLuma react could not reach account "${account.accountId}": ${
          err instanceof Error ? err.message : String(err)
        }`;
        return createActionResult(error, { ok: false, channel: "snowluma", action, error });
      }

      try {
        const result = await reactToMessage(client, messageId as string | number, emojiId as string | number);

        if (!result.ok) {
          return createActionResult(result.error ?? "SnowLuma reaction failed", {
            ok: false,
            channel: "snowluma",
            action,
            error: result.error ?? "SnowLuma reaction failed",
            data: result,
          });
        }

        return createActionResult(`Reacted with ${String(emojiId)} to message ${String(messageId)}.`, {
          ok: true,
          channel: "snowluma",
          action,
          data: result,
        });
      } finally {
        release();
      }
    },
  },
  agentTools: ({ cfg }) => {
    const account = resolveSnowLumaAccount(asHostConfig(cfg));
    return account.toolsEnabled ? createSnowLumaAgentTools({ cfg }) : [];
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info?.(`[snowluma:${account.accountId}] starting gateway`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: ({ selfId }) => {
          log?.info?.(
            `[snowluma:${account.accountId}] gateway ready${selfId !== undefined ? ` (selfId=${selfId})` : ""}`,
          );
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error?.(`[snowluma:${account.accountId}] gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
