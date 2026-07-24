import { describe, expect, it } from "vitest";
import { RECEIVE_DEFAULTS, resolveSnowLumaAccount } from "../src/config.js";
import type { SnowLumaHostConfig } from "../src/types.js";

function hostConfig(snowluma: Record<string, unknown>): SnowLumaHostConfig {
  return { channels: { snowluma } } as SnowLumaHostConfig;
}

// ── debug ────────────────────────────────────────────────────────────────

describe("resolveSnowLumaAccount — debug", () => {
  it("defaults debug to false", () => {
    const account = resolveSnowLumaAccount(hostConfig({ wsUrl: "ws://x/" }));
    expect(account.debug).toBe(false);
  });

  it("honours an explicit debug flag", () => {
    const account = resolveSnowLumaAccount(hostConfig({ wsUrl: "ws://x/", debug: true }));
    expect(account.debug).toBe(true);
  });

  it("ignores a non-boolean debug value and falls back to false", () => {
    const account = resolveSnowLumaAccount(hostConfig({ wsUrl: "ws://x/", debug: "yes" }));
    expect(account.debug).toBe(false);
  });
});

// ── receive.history ────────────────────────────────────────────────────────

describe("resolveSnowLumaAccount — receive.history", () => {
  it("applies the built-in history defaults when unset", () => {
    const account = resolveSnowLumaAccount(hostConfig({ wsUrl: "ws://x/" }));
    expect(account.receive.history).toEqual(RECEIVE_DEFAULTS.history);
    expect(account.receive.history.enabled).toBe(true);
  });

  it("resolves explicit history overrides", () => {
    const account = resolveSnowLumaAccount(
      hostConfig({
        wsUrl: "ws://x/",
        receive: { history: { enabled: false, maxMessages: 5, maxChars: 1000, maxAgeMs: 60000 } },
      }),
    );
    expect(account.receive.history).toEqual({ enabled: false, maxMessages: 5, maxChars: 1000, maxAgeMs: 60000 });
  });

  it("falls back to defaults for invalid history numbers, and allows maxAgeMs 0", () => {
    const account = resolveSnowLumaAccount(
      hostConfig({
        wsUrl: "ws://x/",
        receive: { history: { maxMessages: -3, maxChars: 0, maxAgeMs: 0 } },
      }),
    );
    expect(account.receive.history.maxMessages).toBe(RECEIVE_DEFAULTS.history.maxMessages);
    expect(account.receive.history.maxChars).toBe(RECEIVE_DEFAULTS.history.maxChars);
    expect(account.receive.history.maxAgeMs).toBe(0);
  });

  it("keeps the history queue independent of the digest queue in the resolved account", () => {
    const account = resolveSnowLumaAccount(
      hostConfig({
        wsUrl: "ws://x/",
        receive: { digest: { enabled: true }, history: { enabled: true } },
      }),
    );
    expect(account.receive.digest.enabled).toBe(true);
    expect(account.receive.history.enabled).toBe(true);
  });
});
