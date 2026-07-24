# CLAUDE.md

## What this is

`openclaw-snowluma` is an OpenClaw channel plugin that connects QQ to OpenClaw via the
[`@snowluma/sdk`](https://www.npmjs.com/package/@snowluma/sdk) OneBot 11 client. It speaks to SnowLuma
exclusively through that SDK — three configurable inbound receive modes (mention/keyword, digest,
realtime coalescing), active quote/forward-message resolution, and two read-only agent tools.

## Commands

```bash
npm run build       # tsc -> dist/
npm test            # vitest run
npm run test:watch  # vitest (watch)
npm run coverage    # vitest run --coverage (thresholds in vitest.config.ts)
npm run typecheck   # tsc --noEmit
npm run docs:dev    # VitePress docs, local preview (docs/)
npm run docs:build  # VitePress static build
```

## Architecture

Inbound pipeline: SnowLuma WS → `gateway.ts` → `segments.ts` (normalize) → `triggers.ts` (decide) →
`aggregator.ts` (window/batch) → `dispatch.ts` (resolves quotes via `quote.ts`, calls the OpenClaw
runtime, delivers the reply) → `outbound.ts` (send back to QQ).

`src/*.ts`, one line each:

| File | Purpose |
|---|---|
| `types.ts` | Config and inbound domain types only — no logic. |
| `config.ts` | Resolves raw `channels.snowluma` config into a `ResolvedSnowLumaAccount` with every default applied; env fallback (default account only); `isPeerAllowed`. |
| `env.ts` | The only place that reads `process.env` (`SNOWLUMA_*`). |
| `client.ts` | Builds `SnowLumaWebSocketClient`/`SnowLumaHttpClient` from a resolved account; the action-client registry the gateway publishes its live socket into. |
| `segments.ts` | Normalizes raw OneBot message payloads (array/CQ-string/plain-string) into `SnowLumaMessageSegment[]` / `NormalizedMessage`; renders segments back to display text. |
| `triggers.ts` | Pure decision logic: `evaluateTrigger` (mention/keyword/direct/reply-to-self), no I/O. |
| `aggregator.ts` | Two independent windowing engines (realtime coalescing, digest summarisation) sharing one `accept()` entry point; timers are injected. |
| `quote.ts` | Actively resolves quoted/forwarded messages via `get_msg`/`get_forward_msg`, with depth/node/char budgets. |
| `dispatch.ts` | Turns one `AggregatedBatch` into a single agent turn via `pluginRuntime.channel.*`, then delivers the reply back to QQ. |
| `gateway.ts` | Owns one long-lived connection per account; wires client events → triggers → aggregator → dispatch; tracks self-sent message ids. |
| `outbound.ts` | Target parsing (`group:<id>` / `private:<id>` / bare id), text chunking, `sendText`/`sendMedia`/`reactToMessage`. |
| `tools.ts` | Two read-only agent tools: `snowluma_get_history`, `snowluma_get_group_members`. Parameter schemas are plain JSON Schema literals (byte-identical to typebox 1.x `Type.Object` output; `typebox` is type-only — see hard constraints). |
| `params.ts` | Local, `openclaw`-free `readStringParam`/`readNumberParam` for `tools.ts` (keeps the entry graphs openclaw-free — see hard constraints). |
| `sdk.ts` | Self-patching lazy loader/registry for `@snowluma/sdk`: `ensureSnowLumaSdk()` (patch dist in place, then dynamic `import`) + synchronous `getSnowLumaSdk()` for post-load paths. The ONLY place the SDK is imported with value semantics — see hard constraints. |
| `plugin-entry.ts` | Local, `openclaw`-free port of `defineChannelPluginEntry` (+ `emptyChannelConfigSchema`) used by `index.ts`, so `index.js`'s graph imports no `openclaw/*` at runtime — see hard constraints. |
| `runtime.ts` | Module-level `PluginRuntime` store (`setSnowLumaRuntime`/`getSnowLumaRuntime`/...) that `dispatch.ts` reads from; hand-rolled to stay `openclaw`-free. |
| `channel.ts` | The `ChannelPlugin` surface itself — wires config/setup/outbound/actions/agentTools/gateway/status together for the OpenClaw host. |

`index.ts` and `setup-entry.ts` at the project root are the plugin's two OpenClaw entry points
(`openclaw.extensions` and `openclaw.setupEntry` in `package.json`).

## Hard constraints

- **SDK-only.** Never hand-roll the OneBot protocol, never open a raw WebSocket, never `fetch()`
  SnowLuma directly. Every interaction goes through `@snowluma/sdk` (`SnowLumaWebSocketClient` /
  `SnowLumaHttpClient` and their action methods / message builders). This is why protocol-level SnowLuma
  changes should only ever require bumping `@snowluma/sdk`, not touching plugin logic.
- **The SDK owns reconnection.** `gateway.ts` never schedules a reconnect itself — it only reacts to the
  client's `onMessage`/`on("open"|"close"|"error")` events. Reconnect tuning (`account.reconnect.*`) is
  handed to `SnowLumaWebSocketClientOptions.reconnect` in `client.ts` and the SDK's own retry loop takes
  it from there.
- **Timers are injected.** `aggregator.ts` takes `now`/`setTimeoutFn`/`clearTimeoutFn` so tests drive
  windowing deterministically instead of racing real wall-clock delays. Don't reach for a bare
  `setTimeout`/`Date.now()` inside logic that needs to stay testable this way.
- **Digest turns must never set `CommandAuthorized: true`.** A digest batch summarises a chat window, not
  a command from a specific user — `dispatch.ts` hard-wires `CommandAuthorized: false` and omits
  `CommandSource` entirely for `batch.kind === "digest"`, regardless of `allowFrom`. Do not special-case
  this away.
- **Neither entry's runtime module graph (`index.js` *and* `setup-entry.js`) may import anything from
  `openclaw/*`.** OpenClaw's loader synchronously `require()`s BOTH entries while also asynchronously
  `import()`ing them; if a sync require touches an `openclaw/plugin-sdk/*` module that the async import
  has mid-evaluation, Node throws `ERR_REQUIRE_ESM_RACE_CONDITION` and the whole plugin fails to load
  (0.1.1 fixed only `setup-entry`, so the race moved to `index.js`; 0.1.2 fixed both). That is why the
  entire compiled plugin has ZERO `openclaw` runtime imports: `index.ts` uses the local
  `src/plugin-entry.ts` (`defineChannelPluginEntry` + `emptyChannelConfigSchema`), `setup-entry.ts`
  inlines `defineSetupPluginEntry` (`{ plugin }`), `tools.ts` uses `src/params.ts` instead of
  `readNumberParam`/`readStringParam`, and `runtime.ts` hand-rolls the store instead of
  `createPluginRuntimeStore`. Every `openclaw` import in `src/**` must stay `import type` only (erased);
  the plugin reaches the host solely through the runtime `api`/`ctx` objects. `test/load-graph.test.ts`
  enforces this for both entry graphs. When bumping the `openclaw` peer range, re-verify the ported
  helpers against `node_modules/openclaw/dist/plugin-sdk/core.js`.
- **No static bare runtime imports in either entry graph except `node:*` builtins.** OpenClaw's
  installer runs `npm install --ignore-scripts` (hardcoded, plus `NPM_CONFIG_IGNORE_SCRIPTS=true`) and
  may reuse an existing generation install dir, so the plugin cannot rely on install-time scripts or on
  any dependency beyond what a bare manifest install guarantees. Concretely: `@snowluma/sdk` is loaded
  ONLY via the deferred `import("@snowluma/sdk")` inside `src/sdk.ts` (after the load-time self-patch —
  a static SDK import would make ESM linking resolve the SDK's broken internal specifiers before any
  plugin code could patch them), every other module keeps SDK imports `import type`-only and reads SDK
  values from `getSnowLumaSdk()`; and `typebox` is type-only (tools.ts ships plain JSON Schema
  literals). `test/load-graph.test.ts` enforces all of this for both entry graphs. (History:
  `Cannot find module 'typebox'` up to 0.1.3; fixed structurally in 0.1.4.)

## `@snowluma/sdk` ESM patch

`@snowluma/sdk` (through at least v1.12.8) declares `"type": "module"` but ships compiled output with
extensionless relative imports (`from './client/api-client'`), which Node's ESM resolver rejects
(`ERR_MODULE_NOT_FOUND`) before any plugin code runs. The rewrite (add `.js` / `/index.js` to relative
specifiers that resolve on disk; idempotent) exists in two synchronized copies:

- **`src/sdk.ts` (`patchSnowLumaSdkDist`) — the path that matters in production.** Runs at plugin load
  time, immediately before the first dynamic `import("@snowluma/sdk")`, because OpenClaw installs
  plugins with `--ignore-scripts` and `postinstall` therefore never runs on a gateway.
- **`scripts/patch-snowluma-sdk.mjs` — `postinstall` fallback** for manual `npm install` flows and dev
  checkouts. Re-run by hand after anything that replaces `node_modules/@snowluma/sdk` without scripts
  (`npm ci --ignore-scripts`, restoring `node_modules`): `node ./scripts/patch-snowluma-sdk.mjs`.

When editing the rewrite semantics, change BOTH copies. **Delete both once upstream ships a fixed
build** — this is a workaround for a bug in `@snowluma/sdk`, not a permanent part of the design.

## Testing conventions

- `test/*.test.ts`, run with vitest (`vitest.config.ts`: node environment, coverage thresholds
  lines/functions/statements 80%, branches 70%).
- No real sockets and no real OpenClaw host: every module takes its collaborators as injectable
  dependencies (`ToolDeps`, `DispatchDeps`, `AggregatorOptions.setTimeoutFn`, `GatewayContext.clientFactory`,
  etc.) and tests pass hand-written fakes, not mocks of the real SDK/host classes.
- `test/helpers/mock-runtime.ts` (`createMockRuntime`) is the hand-written `PluginRuntime` double used by
  `dispatch.test.ts` — it implements exactly the `pluginRuntime.channel.{activity,routing,reply,commands}`
  surface `dispatch.ts` calls, and exposes `state.last*Args` for assertions.

## Reference material

Design contracts (`CONTRACT.md`, `CONTRACT-WAVE2.md`) and research dossiers/reference-plugin checkouts
used while building this plugin lived in a session-scoped scratch directory outside this repo and are
**not guaranteed to be present in a future session**. Treat this source tree, the installed
`node_modules/@snowluma/sdk/dist/**/*.d.ts`, and the installed `openclaw/plugin-sdk` type declarations as
the authoritative references going forward.
