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
runtime, delivers the reply) → `outbound.ts` (send back to QQ). One branch skips the middle: a
`/summary` command is intercepted in `gateway.ts` by `summary.ts`, which fetches its own transcript
from SnowLuma and hands `dispatch.ts` a `kind: "summary"` batch directly.

Outbound, summarisation replies (`digest` + `summary`) pass through `markdown-text.ts` first: QQ renders
no markup, so the agent's Markdown is flattened to chat-readable plain text before `outbound.ts` sends
it. Realtime replies are short and conversational and go out untouched.

`src/*.ts`, one line each:

| File | Purpose |
|---|---|
| `types.ts` | Config and inbound domain types only — no logic. |
| `config.ts` | Resolves raw `channels.snowluma` config into a `ResolvedSnowLumaAccount` with every default applied; env fallback (default account only); `isPeerAllowed`. |
| `env.ts` | The only place that reads `process.env` (`SNOWLUMA_*`). |
| `client.ts` | Builds `SnowLumaWebSocketClient`/`SnowLumaHttpClient` from a resolved account; the action-client registry the gateway publishes its live socket into. |
| `segments.ts` | Normalizes raw OneBot message payloads (array/CQ-string/plain-string) into `SnowLumaMessageSegment[]` / `NormalizedMessage`; renders segments back to display text; owns `sanitizeDisplayName`, the one flattener every agent-visible nickname passes through. |
| `triggers.ts` | Pure decision logic: `evaluateTrigger` (mention/keyword/direct/reply-to-self), no I/O. |
| `aggregator.ts` | Three independent engines sharing one `accept()` entry point: realtime coalescing, digest summarisation, and a rolling reply-history buffer (drained into a realtime batch's `history` on flush). Timers are injected. |
| `summary.ts` | The on-demand `/summary` command: `matchSummaryCommand` (pure) + `runSummaryCommand`, which fetches the peer's recent history via `get_group_msg_history`/`get_friend_msg_history` and dispatches a `kind: "summary"` batch. Bypasses the aggregator entirely. |
| `markdown-text.ts` | Pure, dependency-free Markdown → plain text for QQ (headings → 【…】, bullets → •, emphasis/backticks stripped, link targets kept). Applied to summarisation replies only. |
| `quote.ts` | Actively resolves quoted/forwarded messages via `get_msg`/`get_forward_msg`, with depth/node/char budgets. |
| `dispatch.ts` | Turns one `AggregatedBatch` into a single agent turn via `pluginRuntime.channel.*`, then delivers the reply back to QQ. |
| `gateway.ts` | Owns one long-lived connection per account; wires client events → triggers → aggregator → dispatch; tracks self-sent message ids. |
| `outbound.ts` | Target parsing (`group:<id>` / `private:<id>` / bare id), text chunking, outbound @-mentions (`[CQ:at,qq=N]` → real `at` segments; `rewriteNameMentions` for `@名字` tokens; `qq=all` never converts), `sendText`/`sendMedia`/`reactToMessage`. |
| `tools.ts` | Two read-only agent tools: `snowluma_get_history`, `snowluma_get_group_members`. Parameter schemas are plain JSON Schema literals (byte-identical to typebox 1.x `Type.Object` output; `typebox` is type-only — see hard constraints). |
| `params.ts` | Local, `openclaw`-free `readStringParam`/`readNumberParam` for `tools.ts` (keeps the entry graphs openclaw-free — see hard constraints). |
| `sdk.ts` | Self-patching lazy loader/registry for `@snowluma/sdk`: `ensureSnowLumaSdk()` (patch dist in place, then dynamic `import`) + synchronous `getSnowLumaSdk()` for post-load paths. The ONLY place the SDK is imported with value semantics — see hard constraints. |
| `plugin-entry.ts` | Local, `openclaw`-free port of `defineChannelPluginEntry` (+ `emptyChannelConfigSchema`) used by `index.ts`, so `index.js`'s graph imports no `openclaw/*` at runtime — see hard constraints. |
| `runtime.ts` | Module-level `PluginRuntime` store (`setSnowLumaRuntime`/`getSnowLumaRuntime`/...) that `dispatch.ts` reads from; hand-rolled to stay `openclaw`-free. |
| `channel.ts` | The `ChannelPlugin` surface itself — wires config/setup/outbound/actions/agentTools/gateway/status together for the OpenClaw host. |
| `config-schema.ts` | `snowLumaPlugin.configSchema` — plain JSON Schema literals mirroring `SnowLumaAccountConfig`/`SnowLumaChannelConfig`. NOTE: the control-UI config editor does NOT read this — it reads the MANIFEST (`openclaw.plugin.json` `channelConfigs.snowluma.schema`, see below); keep both in sync. `ChannelConfigSchema`/`ChannelConfigUiHint` are type-only — see hard constraints. |

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
- **Summarisation turns must never set `CommandAuthorized: true`.** A `digest`/`summary` batch feeds the
  agent a chat window, not a command from a specific user — `dispatch.ts` hard-wires
  `CommandAuthorized: false` and omits `CommandSource` entirely for every `batch.kind !== "realtime"`,
  regardless of `allowFrom`. `/summary` is no exception: the user authorized a summary, not whatever the
  fetched transcript happens to contain. Do not special-case this away.
- **Every display name that goes into an agent-visible body goes through `sanitizeDisplayName`
  (`segments.ts`), and the host must never prefix a body that already carries its own attribution.**
  Two halves of one rule about who-said-what in the prompt. (1) Nicknames/group cards are free-form
  remote text; raw, a newline in one opens a line of its own inside a transcript, a `[引用 …]` block, or
  the current-message label, which the agent then reads as a separate message from someone else.
  `renderTranscriptLine`/`renderSenderLabel` (`dispatch.ts`), `formatWho` (`quote.ts`), the `@name` in
  `renderSegments` (`segments.ts`) and both tool renderers (`tools.ts`) all flatten first — message TEXT
  stays verbatim, only names are structural. The `@name` case is the easiest to miss and the cheapest to
  exploit: a member's card reaches a transcript the moment SOMEONE ELSE @-mentions them. (2) In a group the host's
  `formatInboundEnvelope` prefixes the WHOLE body with `name (id): `, which with a history block in
  front lands on 【历史聊天记录…】. So `buildRealtimeBody` attaches that label to the current message
  itself and sets `ComposedBody.senderLabelInBody`, on which `dispatch.ts` drops `sender` from the
  envelope call (`from` stays, for the header). The flag is safe to trust because `renderSenderLabel`
  mirrors the host's `resolveSenderLabel` + `sanitizeEnvelopeHeaderPart` step for step: an empty label
  means the host would also have produced none.
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
- **The control-UI config editor reads its schema from the MANIFEST, and that schema may not use
  `$ref`.** The gateway (verified against openclaw 2026.7.1) builds its `config.schema` response for
  `channels.snowluma` from `openclaw.plugin.json` → `channelConfigs.snowluma.{schema,uiHints}` via the
  plugin-metadata/manifest registry — it never consults the loaded module's
  `snowLumaPlugin.configSchema` for this. The UI's form renderer supports only a JSON-Schema subset
  (`type` object/array/scalars, `enum`, scalar-branch `anyOf`/`oneOf`, `additionalProperties` as map
  schema) and resolves NO `$ref`/`$defs`/`allOf` — an unsupported node renders as "Unsupported schema
  node. Use Raw mode." instead of fields (history: 0.1.5's manifest used `$ref`/`$defs` and exactly
  those five object-valued fields broke; 0.1.6 inlined them). `test/manifest-schema.test.ts` ports the
  UI normalizer and enforces renderability plus the gateway's 256KB schema budget. Keep
  `src/config-schema.ts` (the module-level twin) in sync when editing the manifest schema.

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
- The "no `openclaw` runtime imports" rule is about the two ENTRY GRAPHS, not the test suite — a test may
  import openclaw for real. `dispatch.test.ts` does exactly that (`openclaw/plugin-sdk/channel-envelope`)
  for one regression: `createMockRuntime`'s `formatInboundEnvelope` returns `args.body` verbatim, so it
  cannot observe the host's own "name (id): " body prefix, and only the real formatter can prove that
  prefix no longer lands on the history block.

## Reference material

Design contracts (`CONTRACT.md`, `CONTRACT-WAVE2.md`) and research dossiers/reference-plugin checkouts
used while building this plugin lived in a session-scoped scratch directory outside this repo and are
**not guaranteed to be present in a future session**. Treat this source tree, the installed
`node_modules/@snowluma/sdk/dist/**/*.d.ts`, and the installed `openclaw/plugin-sdk` type declarations as
the authoritative references going forward.
