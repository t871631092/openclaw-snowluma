/**
 * SnowLuma WebSocket/HTTP client construction and the action-client registry.
 *
 * The gateway (wave 2) owns one long-lived `SnowLumaWebSocketClient` per account and
 * publishes it here via `registerActionClient` so one-off callers (agent tools, digest
 * dispatch) can reuse the open socket instead of paying for a second connection per
 * call. When no live socket is registered — gateway not started yet, or a background
 * job running outside the gateway process — `acquireActionClient` falls back to a
 * short-lived client of its own that the caller must `release()`.
 */

// SDK types only — the classes come from the lazy registry in `./sdk.js` so
// this graph carries no static `@snowluma/sdk` import (see src/sdk.ts header).
import type {
  SnowLumaApiClient,
  SnowLumaHttpClient,
  SnowLumaHttpClientOptions,
  SnowLumaWebSocketClient,
  SnowLumaWebSocketClientOptions,
} from "@snowluma/sdk";
import { ensureSnowLumaSdk, getSnowLumaSdk } from "./sdk.js";
import type { ResolvedSnowLumaAccount } from "./types.js";

export interface ClientLogger {
  info?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

export type ClientFactory = (account: ResolvedSnowLumaAccount) => SnowLumaWebSocketClient;

/** Maps a resolved account onto the SDK's WebSocket client options. */
function buildWebSocketOptions(account: ResolvedSnowLumaAccount): SnowLumaWebSocketClientOptions {
  const { reconnect } = account;
  return {
    url: account.wsUrl,
    accessToken: account.accessToken,
    requestTimeoutMs: account.requestTimeoutMs,
    role: "Universal",
    reconnect: reconnect.enabled
      ? {
          // `ReconnectOptions.retries` is typed `number`, and `Infinity` *is* a valid
          // `number` that also behaves correctly at runtime (the client's own retry
          // loop compares `attempts >= retries`, which a finite attempts counter can
          // never satisfy against Infinity). But the SDK's own JSDoc spells out the
          // idiom for "unlimited" explicitly — "Omit for unlimited retries." — so we
          // follow that instead of handing the field a non-finite number: omit it and
          // let the client's own default (also unlimited) apply.
          retries: Number.isFinite(reconnect.retries) ? reconnect.retries : undefined,
          minDelayMs: reconnect.minDelayMs,
          maxDelayMs: reconnect.maxDelayMs,
        }
      : false,
  };
}

/**
 * Builds the long-lived WebSocket client the gateway owns for one account.
 * Synchronous by contract (`ClientFactory`); callers must have awaited
 * `ensureSnowLumaSdk()` first — `startGateway` does.
 */
export function createSnowLumaClient(account: ResolvedSnowLumaAccount): SnowLumaWebSocketClient {
  const sdk = getSnowLumaSdk();
  return new sdk.SnowLumaWebSocketClient(buildWebSocketOptions(account));
}

// ── Action-client registry ──────────────────────────────────────────────────
// Module-level so every part of the plugin process shares one view of "which
// accounts currently have a live gateway socket."

const actionClients = new Map<string, SnowLumaApiClient>();

/** Live clients published by the gateway so agent tools can reuse an open socket. */
export function registerActionClient(accountId: string, client: SnowLumaApiClient): void {
  actionClients.set(accountId, client);
}

export function unregisterActionClient(accountId: string): void {
  actionClients.delete(accountId);
}

export function tryGetActionClient(accountId: string): SnowLumaApiClient | undefined {
  return actionClients.get(accountId);
}

/** Test-only: clears the registry so cases don't leak state into one another. */
export function __resetActionClients(): void {
  actionClients.clear();
}

/** Injectable client constructors so tests can avoid opening real sockets/fetching. */
export interface AcquireActionClientDeps {
  createWs?: (options: SnowLumaWebSocketClientOptions) => SnowLumaWebSocketClient;
  createHttp?: (options: SnowLumaHttpClientOptions) => SnowLumaHttpClient;
}

/**
 * Resolve a client for one-off actions: the live socket when the gateway is up,
 * otherwise a short-lived client the caller must `release()`.
 */
export async function acquireActionClient(
  account: ResolvedSnowLumaAccount,
  deps?: AcquireActionClientDeps,
): Promise<{ client: SnowLumaApiClient; release: () => void }> {
  const live = actionClients.get(account.accountId);
  if (live) {
    return { client: live, release: () => {} };
  }

  if (account.httpUrl) {
    // HTTP is cheaper for a single call: no socket to open, nothing to close after.
    const httpOptions: SnowLumaHttpClientOptions = {
      baseUrl: account.httpUrl,
      accessToken: account.accessToken,
      requestTimeoutMs: account.requestTimeoutMs,
    };
    const client = deps?.createHttp
      ? deps.createHttp(httpOptions)
      : new (await ensureSnowLumaSdk()).SnowLumaHttpClient(httpOptions);
    return { client, release: () => {} };
  }

  const wsOptions = buildWebSocketOptions(account);
  const client = deps?.createWs
    ? deps.createWs(wsOptions)
    : new (await ensureSnowLumaSdk()).SnowLumaWebSocketClient(wsOptions);
  await client.connect();
  return { client, release: () => client.close() };
}

/** Best-effort `get_login_info` to learn the bot's own QQ id; returns undefined on failure. */
export async function detectSelfId(
  client: SnowLumaApiClient,
  log?: ClientLogger,
): Promise<number | undefined> {
  try {
    const info = await client.getLoginInfo();
    return info.user_id;
  } catch (error) {
    log?.error?.(
      `SnowLuma detectSelfId failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
