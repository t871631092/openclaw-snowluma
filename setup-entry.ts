import { snowLumaPlugin } from "./src/channel.js";

/**
 * The setup entry OpenClaw loads to read this plugin's setup surface.
 *
 * We deliberately do NOT `import { defineSetupPluginEntry } from
 * "openclaw/plugin-sdk/core"` here. That helper is documented to return exactly
 * `{ plugin }` (and does), so inlining it costs nothing — but it keeps this
 * file's runtime graph free of `openclaw/plugin-sdk/core`. OpenClaw's loader
 * synchronously `require()`s this file while asynchronously `import()`ing
 * `index.js`; if the sync require touched `core.js` mid-import it would trip
 * Node's `ERR_REQUIRE_ESM_RACE_CONDITION` and fail the whole plugin load. With
 * no `openclaw/*` runtime import in this graph (see also src/params.ts and
 * src/tools.ts), there is nothing for that require to race on.
 * See docs/guide/troubleshooting.md#err-require-esm-race-condition.
 */
const setupEntry = { plugin: snowLumaPlugin };

export default setupEntry;
