import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { ChannelAgentToolFactory } from "openclaw/plugin-sdk";

import { snowLumaPlugin } from "../src/channel.js";
import { __resetActionClients, registerActionClient } from "../src/client.js";
import { resolveSnowLumaAccount } from "../src/config.js";
import setupEntryDefault from "../setup-entry.js";
import entry from "../index.js";

afterEach(() => __resetActionClients());

// ── identity & capabilities ────────────────────────────────────────────────

describe("snowLumaPlugin — identity & capabilities", () => {
  it("has the expected id, meta, capabilities, and reload config", () => {
    expect(snowLumaPlugin.id).toBe("snowluma");
    expect(snowLumaPlugin.meta.label).toBe("SnowLuma");
    expect(snowLumaPlugin.meta.selectionLabel).toBe("SnowLuma (QQ)");
    expect(snowLumaPlugin.meta.order).toBe(56);
    expect(snowLumaPlugin.capabilities).toEqual({
      chatTypes: ["direct", "group"],
      media: true,
      reactions: true,
      threads: false,
      blockStreaming: true,
    });
    expect(snowLumaPlugin.reload).toEqual({ configPrefixes: ["channels.snowluma"] });
  });
});

// ── config adapter ──────────────────────────────────────────────────────────

describe("snowLumaPlugin.config", () => {
  it("listAccountIds lists the default and every named account with a wsUrl/httpUrl", () => {
    const hostCfg = {
      channels: {
        snowluma: { wsUrl: "ws://127.0.0.1:3001/", accounts: { second: { wsUrl: "ws://127.0.0.1:3002/" } } },
      },
    };
    const ids = snowLumaPlugin.config.listAccountIds(hostCfg as any);
    expect([...ids].sort()).toEqual(["default", "second"]);
  });

  it("resolveAccount resolves the configured wsUrl", () => {
    const hostCfg = { channels: { snowluma: { wsUrl: "ws://127.0.0.1:3001/" } } };
    const account = snowLumaPlugin.config.resolveAccount(hostCfg as any, "default");
    expect(account.wsUrl).toBe("ws://127.0.0.1:3001/");
  });

  it("isConfigured is true only when wsUrl is set", () => {
    const configured = snowLumaPlugin.config.resolveAccount(
      { channels: { snowluma: { wsUrl: "ws://x/" } } } as any,
      "default",
    );
    const unconfigured = snowLumaPlugin.config.resolveAccount({} as any, "default");
    expect(snowLumaPlugin.config.isConfigured!(configured, {} as any)).toBe(true);
    expect(snowLumaPlugin.config.isConfigured!(unconfigured, {} as any)).toBe(false);
  });

  it("describeAccount returns a snapshot with accountId/name/enabled/configured", () => {
    const account = snowLumaPlugin.config.resolveAccount(
      { channels: { snowluma: { wsUrl: "ws://x/", name: "Main Bot" } } } as any,
      "default",
    );
    const snapshot = snowLumaPlugin.config.describeAccount!(account, {} as any);
    expect(snapshot).toMatchObject({ accountId: "default", name: "Main Bot", enabled: true, configured: true });
  });
});

// ── setup adapter ────────────────────────────────────────────────────────

describe("snowLumaPlugin.setup", () => {
  it("validateInput rejects when neither --token nor --use-env is given", () => {
    const result = snowLumaPlugin.setup!.validateInput!({ cfg: {} as any, accountId: "default", input: {} });
    expect(result).toMatch(/--token|--use-env/);
  });

  it("validateInput accepts --use-env with no token", () => {
    const result = snowLumaPlugin.setup!.validateInput!({
      cfg: {} as any,
      accountId: "default",
      input: { useEnv: true },
    });
    expect(result).toBeNull();
  });

  it("validateInput accepts a --token value", () => {
    const result = snowLumaPlugin.setup!.validateInput!({
      cfg: {} as any,
      accountId: "default",
      input: { token: "ws://127.0.0.1:3001/" },
    });
    expect(result).toBeNull();
  });

  it("applyAccountConfig parses wsUrl,accessToken,httpUrl,selfId and round-trips through resolveSnowLumaAccount", () => {
    const nextCfg = snowLumaPlugin.setup!.applyAccountConfig!({
      cfg: {} as any,
      accountId: "default",
      input: { token: "ws://127.0.0.1:3001/,secret-token,http://127.0.0.1:3000/,88888", name: "Bot A" },
    });

    const resolved = resolveSnowLumaAccount(nextCfg as any, "default");
    expect(resolved.wsUrl).toBe("ws://127.0.0.1:3001/");
    expect(resolved.accessToken).toBe("secret-token");
    expect(resolved.httpUrl).toBe("http://127.0.0.1:3000/");
    expect(resolved.selfId).toBe(88888);
    expect(resolved.name).toBe("Bot A");
    expect(resolved.enabled).toBe(true);
  });

  it("applyAccountConfig with --use-env alone still enables the account without overwriting a wsUrl", () => {
    const nextCfg = snowLumaPlugin.setup!.applyAccountConfig!({
      cfg: {} as any,
      accountId: "default",
      input: { useEnv: true },
    });
    const resolved = resolveSnowLumaAccount(nextCfg as any, "default");
    expect(resolved.enabled).toBe(true);
  });
});

// ── messaging adapter ────────────────────────────────────────────────────

describe("snowLumaPlugin.messaging", () => {
  it("normalizeTarget strips the snowluma: channel prefix", () => {
    expect(snowLumaPlugin.messaging!.normalizeTarget!("snowluma:group:1")).toBe("group:1");
    expect(snowLumaPlugin.messaging!.normalizeTarget!("group:1")).toBe("group:1");
  });

  it("targetResolver.looksLikeId accepts group:<id>, private:<id>, a bare id, and the channel-prefixed form", () => {
    const looksLikeId = snowLumaPlugin.messaging!.targetResolver!.looksLikeId!;
    expect(looksLikeId("group:1", "group:1")).toBe(true);
    expect(looksLikeId("private:2", "private:2")).toBe(true);
    expect(looksLikeId("12345", "12345")).toBe(true);
    expect(looksLikeId("snowluma:group:1", "snowluma:group:1")).toBe(true);
  });

  it("targetResolver.looksLikeId rejects malformed or empty targets", () => {
    const looksLikeId = snowLumaPlugin.messaging!.targetResolver!.looksLikeId!;
    expect(looksLikeId("", "")).toBe(false);
    expect(looksLikeId("group:abc", "group:abc")).toBe(false);
    expect(looksLikeId("channel:1", "channel:1")).toBe(false);
  });
});

// ── outbound adapter ─────────────────────────────────────────────────────

describe("snowLumaPlugin.outbound", () => {
  function makeCfg() {
    return { channels: { snowluma: { wsUrl: "ws://127.0.0.1:3001/" } } };
  }

  it("sendText acquires a client and delegates to outbound.sendText, returning {channel, messageId}", async () => {
    const sendGroupMessage = vi.fn(async () => ({ message_id: 42 }));
    const fakeClient = { sendGroupMessage, sendPrivateMessage: vi.fn() } as unknown as SnowLumaApiClient;
    registerActionClient("default", fakeClient);

    const result = await snowLumaPlugin.outbound!.sendText!({
      cfg: makeCfg() as any,
      to: "snowluma:group:888",
      text: "hello",
      accountId: "default",
    } as any);

    expect(result).toEqual({ channel: "snowluma", messageId: "42" });
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("sendMedia acquires a client and delegates to outbound.sendMedia, returning {channel, messageId}", async () => {
    const sendPrivateMessage = vi.fn(async () => ({ message_id: 77 }));
    const fakeClient = { sendGroupMessage: vi.fn(), sendPrivateMessage } as unknown as SnowLumaApiClient;
    registerActionClient("default", fakeClient);

    const result = await snowLumaPlugin.outbound!.sendMedia!({
      cfg: makeCfg() as any,
      to: "snowluma:private:2",
      text: "",
      mediaUrl: "https://example.com/photo.png",
      accountId: "default",
    } as any);

    expect(result).toEqual({ channel: "snowluma", messageId: "77" });
    expect(sendPrivateMessage).toHaveBeenCalledTimes(1);
  });

  it("sendMedia rejects when no mediaUrl is given", async () => {
    await expect(
      snowLumaPlugin.outbound!.sendMedia!({ cfg: makeCfg() as any, to: "snowluma:group:1", text: "" } as any),
    ).rejects.toThrow(/mediaUrl/);
  });
});

// ── actions adapter ──────────────────────────────────────────────────────

describe("snowLumaPlugin.actions", () => {
  it("describeMessageTool advertises react when the account is configured", () => {
    const discovery = snowLumaPlugin.actions!.describeMessageTool({
      cfg: { channels: { snowluma: { wsUrl: "ws://x/" } } } as any,
    } as any);
    expect(discovery).toEqual({ actions: ["react"] });
  });

  it("describeMessageTool returns null when the account is not configured", () => {
    const discovery = snowLumaPlugin.actions!.describeMessageTool({ cfg: {} as any } as any);
    expect(discovery).toBeNull();
  });

  it("supportsAction is true only for react", () => {
    expect(snowLumaPlugin.actions!.supportsAction!({ action: "react" } as any)).toBe(true);
    expect(snowLumaPlugin.actions!.supportsAction!({ action: "send" } as any)).toBe(false);
  });

  it("handleAction reacts successfully via acquireActionClient", async () => {
    const setMsgEmojiLike = vi.fn().mockResolvedValue(null);
    const fakeClient = { setMsgEmojiLike } as unknown as SnowLumaApiClient;
    registerActionClient("default", fakeClient);

    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "react",
      cfg: { channels: { snowluma: { wsUrl: "ws://x/" } } } as any,
      params: { message_id: 100, emoji: "128077" },
      accountId: "default",
    } as any);

    expect(result.details).toMatchObject({ ok: true, channel: "snowluma", action: "react" });
    expect(setMsgEmojiLike).toHaveBeenCalledWith(100, "128077");
  });

  it("handleAction fails cleanly when message_id/emoji are missing", async () => {
    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "react",
      cfg: {} as any,
      params: {},
    } as any);
    expect(result.details).toMatchObject({ ok: false });
  });

  it("handleAction fails cleanly for an unsupported action", async () => {
    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "send",
      cfg: {} as any,
      params: {},
    } as any);
    expect(result.details).toMatchObject({ ok: false, action: "send" });
  });

  it("handleAction surfaces a failed reaction from the SDK", async () => {
    const setMsgEmojiLike = vi.fn().mockRejectedValue(new Error("no permission"));
    const fakeClient = { setMsgEmojiLike } as unknown as SnowLumaApiClient;
    registerActionClient("default", fakeClient);

    const result = await snowLumaPlugin.actions!.handleAction!({
      action: "react",
      cfg: { channels: { snowluma: { wsUrl: "ws://x/" } } } as any,
      params: { message_id: 1, emoji: "1" },
      accountId: "default",
    } as any);

    expect(result.details).toMatchObject({ ok: false });
  });
});

// ── agent tools ──────────────────────────────────────────────────────────

describe("snowLumaPlugin.agentTools", () => {
  it("returns both tools when tools.enabled is not false", () => {
    const factory = snowLumaPlugin.agentTools as ChannelAgentToolFactory;
    const tools = factory({ cfg: { channels: { snowluma: { wsUrl: "ws://x/" } } } as any });
    expect(tools.map((t) => t.name).sort()).toEqual(["snowluma_get_group_members", "snowluma_get_history"]);
  });

  it("returns no tools when tools.enabled is false", () => {
    const factory = snowLumaPlugin.agentTools as ChannelAgentToolFactory;
    const tools = factory({
      cfg: { channels: { snowluma: { wsUrl: "ws://x/", tools: { enabled: false } } } } as any,
    });
    expect(tools).toHaveLength(0);
  });
});

// ── status adapter ───────────────────────────────────────────────────────

describe("snowLumaPlugin.status", () => {
  it("buildAccountSnapshot merges account and runtime fields", () => {
    const account = snowLumaPlugin.config.resolveAccount(
      { channels: { snowluma: { wsUrl: "ws://x/", name: "Bot" } } } as any,
      "default",
    );
    const snapshot = snowLumaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: {} as any,
      runtime: { running: true, connected: true, lastConnectedAt: 123, lastError: null } as any,
    });
    expect(snapshot).toMatchObject({
      accountId: "default",
      name: "Bot",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastConnectedAt: 123,
      lastError: null,
    });
  });

  it("defaultRuntime is a sensible not-yet-started snapshot", () => {
    expect(snowLumaPlugin.status!.defaultRuntime).toMatchObject({
      accountId: "default",
      running: false,
      connected: false,
    });
  });
});

// ── entry points (index.ts / setup-entry.ts) ──────────────────────────────

describe("plugin entry points", () => {
  it("index.ts default export exposes id/register/channelPlugin/setChannelRuntime", () => {
    expect(entry.id).toBe("openclaw-snowluma");
    expect(entry.name).toBe("SnowLuma");
    expect(typeof entry.register).toBe("function");
    expect(entry.channelPlugin).toBe(snowLumaPlugin);
    expect(typeof entry.setChannelRuntime).toBe("function");
  });

  it("setup-entry.ts default export exposes { plugin }", () => {
    expect(setupEntryDefault.plugin).toBe(snowLumaPlugin);
  });
});
