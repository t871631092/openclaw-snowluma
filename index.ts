// `defineChannelPluginEntry` is imported from the LOCAL src/plugin-entry.js, not
// `openclaw/plugin-sdk/core`, on purpose: it keeps this file's runtime graph free
// of any `openclaw/*` import so OpenClaw's loader (which sync-`require()`s this
// entry while async-`import()`ing it) can't trip ERR_REQUIRE_ESM_RACE_CONDITION.
// See src/plugin-entry.ts and docs/guide/troubleshooting.md#err-require-esm-race-condition.
import { defineChannelPluginEntry } from "./src/plugin-entry.js";
import { snowLumaPlugin } from "./src/channel.js";
import { setSnowLumaRuntime } from "./src/runtime.js";

const entry = defineChannelPluginEntry({
  id: "openclaw-snowluma",
  name: "SnowLuma",
  description:
    "OpenClaw channel plugin connecting QQ via the SnowLuma SDK. Speaks to SnowLuma exclusively through " +
    "@snowluma/sdk (WebSocket + action client); never reimplements the OneBot protocol on the wire.",
  plugin: snowLumaPlugin,
  setRuntime: setSnowLumaRuntime,
});

export default entry;
export { snowLumaPlugin } from "./src/channel.js";
export { clearSnowLumaRuntime, getSnowLumaRuntime, setSnowLumaRuntime, tryGetSnowLumaRuntime } from "./src/runtime.js";
export * from "./src/types.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
