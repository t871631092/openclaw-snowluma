import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnowLumaApiClient, SnowLumaHttpClient, SnowLumaWebSocketClient } from "@snowluma/sdk";

import {
  __resetActionClients,
  acquireActionClient,
  createSnowLumaClient,
  detectSelfId,
  registerActionClient,
  tryGetActionClient,
  unregisterActionClient,
} from "../src/client.js";
import { resolveSnowLumaAccount } from "../src/config.js";
import type {
  ResolvedSnowLumaAccount,
  SnowLumaAccountConfig,
  SnowLumaHostConfig,
} from "../src/types.js";

/** Builds a fully-resolved account via the real config resolver so every field is valid. */
function makeAccount(accountConfig: SnowLumaAccountConfig = {}): ResolvedSnowLumaAccount {
  const cfg: SnowLumaHostConfig = {
    channels: {
      snowluma: {
        wsUrl: "ws://127.0.0.1:3001/",
        accessToken: "secret-token",
        requestTimeoutMs: 12345,
        ...accountConfig,
      },
    },
  };
  return resolveSnowLumaAccount(cfg);
}

describe("createSnowLumaClient", () => {
  it("maps account fields onto SnowLumaWebSocketClientOptions", () => {
    const account = makeAccount({
      reconnect: { enabled: true, retries: 7, minDelayMs: 500, maxDelayMs: 9000 },
    });

    const client = createSnowLumaClient(account);

    expect(client.url).toBe("ws://127.0.0.1:3001/");
    expect(client.accessToken).toBe("secret-token");
    expect(client.requestTimeoutMs).toBe(12345);
    expect(client.role).toBe("Universal");
    // `reconnect` is a private field at the type level but a plain JS property at
    // runtime (the SDK does not use `#`-private fields) — peek at it to confirm the
    // SDK's own `normalizeReconnect()` received the object we built.
    expect((client as unknown as { reconnect: unknown }).reconnect).toEqual({
      retries: 7,
      minDelayMs: 500,
      maxDelayMs: 9000,
    });
  });

  it("passes reconnect:false through when the account disables reconnect", () => {
    const account = makeAccount({ reconnect: { enabled: false } });

    const client = createSnowLumaClient(account);

    // SDK's normalizeReconnect(false) -> null (see websocket-utils.js).
    expect((client as unknown as { reconnect: unknown }).reconnect).toBeNull();
  });

  it("omits `retries` when the resolved account carries unlimited (Infinity) retries", () => {
    // config.ts resolves an unset `retries` to Number.POSITIVE_INFINITY.
    const account = makeAccount({ reconnect: { enabled: true } });
    expect(account.reconnect.retries).toBe(Number.POSITIVE_INFINITY);

    const client = createSnowLumaClient(account);

    const reconnect = (client as unknown as { reconnect: { retries?: number } }).reconnect;
    expect(reconnect.retries).toBeUndefined();
  });

  it("passes a finite retries value through unchanged", () => {
    const account = makeAccount({ reconnect: { enabled: true, retries: 3 } });

    const client = createSnowLumaClient(account);

    const reconnect = (client as unknown as { reconnect: { retries?: number } }).reconnect;
    expect(reconnect.retries).toBe(3);
  });
});

describe("action-client registry", () => {
  afterEach(() => __resetActionClients());

  it("registers, retrieves, and unregisters a live client", () => {
    const fake = {} as unknown as SnowLumaApiClient;

    expect(tryGetActionClient("acct")).toBeUndefined();

    registerActionClient("acct", fake);
    expect(tryGetActionClient("acct")).toBe(fake);

    unregisterActionClient("acct");
    expect(tryGetActionClient("acct")).toBeUndefined();
  });

  it("__resetActionClients clears every registered account", () => {
    registerActionClient("a", {} as unknown as SnowLumaApiClient);
    registerActionClient("b", {} as unknown as SnowLumaApiClient);

    __resetActionClients();

    expect(tryGetActionClient("a")).toBeUndefined();
    expect(tryGetActionClient("b")).toBeUndefined();
  });
});

describe("acquireActionClient", () => {
  afterEach(() => __resetActionClients());

  it("reuses a live registered client and its release() is a no-op that does not close it", async () => {
    const close = vi.fn();
    const live = { close } as unknown as SnowLumaApiClient;
    registerActionClient("default", live);

    const account = makeAccount();
    const { client, release } = await acquireActionClient(account);

    expect(client).toBe(live);
    release();
    expect(close).not.toHaveBeenCalled();
  });

  it("prefers a short-lived HTTP client when httpUrl is configured (no socket involved)", async () => {
    const account = makeAccount({ httpUrl: "http://127.0.0.1:3000/" });
    const httpInstance = {} as unknown as SnowLumaHttpClient;
    const createHttp = vi.fn((_options: unknown) => httpInstance);
    const createWs = vi.fn();

    const { client, release } = await acquireActionClient(account, { createHttp, createWs });

    expect(createHttp).toHaveBeenCalledTimes(1);
    expect(createHttp.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:3000/",
      accessToken: "secret-token",
      requestTimeoutMs: 12345,
    });
    expect(createWs).not.toHaveBeenCalled();
    expect(client).toBe(httpInstance);
    expect(() => release()).not.toThrow();
  });

  it("constructs, connects, and later closes a short-lived WS client when no httpUrl is set", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const fakeWs = { connect, close } as unknown as SnowLumaWebSocketClient;
    const createWs = vi.fn(() => fakeWs);

    const account = makeAccount();
    const { client, release } = await acquireActionClient(account, { createWs });

    expect(createWs).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client).toBe(fakeWs);

    release();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("detectSelfId", () => {
  it("resolves the bot's own QQ id on success", async () => {
    const client = {
      getLoginInfo: vi.fn().mockResolvedValue({ user_id: 42, nickname: "bot" }),
    } as unknown as SnowLumaApiClient;

    await expect(detectSelfId(client)).resolves.toBe(42);
  });

  it("swallows errors and returns undefined, logging when a logger is given", async () => {
    const client = {
      getLoginInfo: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as SnowLumaApiClient;
    const log = { error: vi.fn() };

    await expect(detectSelfId(client, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toContain("boom");
  });
});
