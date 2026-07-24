import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

/**
 * Module-local store for the resolved `PluginRuntime`, set once at gateway
 * registration and read by `dispatch.ts` on every agent turn.
 *
 * This is a hand-rolled equivalent of the SDK's
 * `createPluginRuntimeStore("<message>")` STRING overload. Verified against the
 * SDK source: the string form is exactly this — a single module-local `runtime`
 * slot with set/clear/tryGet/get. (Only the `{ pluginId }` overload touches the
 * global `Symbol.for("openclaw.plugin-sdk.runtime-store-registry")` map; the
 * string form never does.) ESM caches modules by resolved URL and dedupes
 * `require()`/`import()`, so this single `./runtime.js` instance is shared across
 * both plugin entry graphs identically to the SDK store.
 *
 * WHY LOCAL — importing `createPluginRuntimeStore` from
 * `openclaw/plugin-sdk/runtime-store` would place an `openclaw/*` runtime import
 * in this module, and this module sits inside `setup-entry.js`'s synchronously
 * `require()`d graph (setup-entry → channel → gateway → dispatch → runtime).
 * Keeping it local guarantees that graph imports nothing from `openclaw/*` at
 * runtime, which is what prevents the loader's `ERR_REQUIRE_ESM_RACE_CONDITION`.
 * See docs/guide/troubleshooting.md#err-require-esm-race-condition and src/params.ts.
 */
const RUNTIME_NOT_INITIALIZED = "SnowLuma runtime not initialized";

let runtime: PluginRuntime | null = null;

export const setSnowLumaRuntime = (next: PluginRuntime): void => {
  runtime = next;
};

export const clearSnowLumaRuntime = (): void => {
  runtime = null;
};

export const tryGetSnowLumaRuntime = (): PluginRuntime | null => runtime ?? null;

export const getSnowLumaRuntime = (): PluginRuntime => {
  if (runtime === null) throw new Error(RUNTIME_NOT_INITIALIZED);
  return runtime;
};
