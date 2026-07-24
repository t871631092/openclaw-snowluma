/**
 * Local, openclaw-free reimplementation of `defineChannelPluginEntry` (and the
 * `emptyChannelConfigSchema` default it relies on) from `openclaw/plugin-sdk/core`.
 *
 * WHY LOCAL — OpenClaw's loader synchronously `require()`s the plugin's
 * `extensions` entry (`index.js`) while it is also asynchronously `import()`ing
 * it on the loader-hook thread. If `index.js`'s graph imports
 * `openclaw/plugin-sdk/core` (which it did, only for `defineChannelPluginEntry`),
 * the sync require can reach `core.js` while it is still mid-evaluation from the
 * async import, and Node 22+ throws `ERR_REQUIRE_ESM_RACE_CONDITION` — failing the
 * whole plugin load. (Same failure mode that hit `setup-entry.js`; see
 * src/params.ts / src/runtime.ts / setup-entry.ts.) Keeping this local makes
 * `index.js`'s runtime graph free of every `openclaw/*` import, so there is
 * nothing for the sync require to race on.
 *
 * This is a VERBATIM port of the SDK's `defineChannelPluginEntry` /
 * `emptyChannelConfigSchema` (openclaw 2026.5.7). The register protocol it
 * targets — `api.registrationMode` ∈ {cli-metadata, tool-discovery, discovery,
 * full}, `api.registerChannel({ plugin })`, `api.runtime` — is the stable public
 * plugin API. If a future openclaw major changes that protocol, re-port from
 * `node_modules/openclaw/dist/plugin-sdk/core.js`. `test/load-graph.test.ts`
 * guards the "no openclaw runtime import in index.js's graph" invariant.
 * See docs/guide/troubleshooting.md#err-require-esm-race-condition.
 *
 * Type-only imports from `openclaw` are erased at compile time (no runtime import).
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";

/** The SDK's default entry config schema: plugin-level config (`plugins.entries.<id>`) must be empty. */
function emptyChannelConfigSchema() {
  return {
    schema: { type: "object", additionalProperties: false, properties: {} },
    runtime: {
      safeParse(value: unknown) {
        if (value === undefined) return { success: true, data: undefined };
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { success: false, issues: [{ path: [], message: "expected config object" }] };
        }
        if (Object.keys(value as object).length > 0) {
          return { success: false, issues: [{ path: [], message: "config must be empty" }] };
        }
        return { success: true, data: value };
      },
    },
  };
}

export interface DefineChannelPluginEntryOptions<TPlugin> {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: unknown | (() => unknown);
  setRuntime?: (runtime: PluginRuntime) => void;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
}

export interface DefinedChannelPluginEntry<TPlugin> {
  id: string;
  name: string;
  description: string;
  configSchema: unknown;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: TPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
}

/** Verbatim port of `openclaw/plugin-sdk/core`'s `defineChannelPluginEntry`. */
export function defineChannelPluginEntry<TPlugin>(
  options: DefineChannelPluginEntryOptions<TPlugin>,
): DefinedChannelPluginEntry<TPlugin> {
  const { id, name, description, plugin, configSchema, setRuntime, registerCliMetadata, registerFull } =
    options;
  return {
    id,
    name,
    description,
    configSchema:
      typeof configSchema === "function"
        ? (configSchema as () => unknown)()
        : (configSchema ?? emptyChannelConfigSchema()),
    register(api: OpenClawPluginApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      if (api.registrationMode === "tool-discovery") {
        registerFull?.(api);
        return;
      }
      api.registerChannel({ plugin: plugin as ChannelPlugin });
      setRuntime?.(api.runtime);
      if (api.registrationMode === "discovery") {
        registerCliMetadata?.(api);
        return;
      }
      if (api.registrationMode !== "full") return;
      registerCliMetadata?.(api);
      registerFull?.(api);
    },
    channelPlugin: plugin,
    ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
  };
}
