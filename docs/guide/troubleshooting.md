# 故障排查

## 连接被拒绝 / 一直连不上（`ECONNREFUSED` 等）

- 确认 SnowLuma 已经启动并正在监听 `wsUrl` 指向的地址和端口。
- 跨主机或容器部署时，检查网络可达性与防火墙规则。
- 确认 `wsUrl` 的协议、主机、端口都正确——注意 `ws://` 对应 `wsUrl`，`http://` 对应 `httpUrl`，是两个不同的配置项，不要混用（`httpUrl` 只影响 Agent 工具/一次性 action 走 HTTP 还是复用网关的 WebSocket，网关本身的长连接**始终**通过 `wsUrl` 建立，见 `src/gateway.ts` 的 `startGateway`——`httpUrl` 缺失完全不影响网关能否启动）。
- 底层连接由 `@snowluma/sdk` 的 `SnowLumaWebSocketClient` 负责建立，重连行为受 `reconnect.*` 配置调优（见[配置参考 · reconnect](/guide/configuration#reconnect-websocket-重连调优)）——如果 `reconnect.enabled: false` 或者 `reconnect.retries` 被显式设成了较小的数字，断线后可能不会无限重试，网关会停在断开状态直到手动重启。

## token 被拒绝（`SnowLumaAuthError`）

`SnowLumaAuthError` 是 `@snowluma/sdk` 自己抛出的异常类型（`SnowLumaApiError` 的子类），代表 SnowLuma 返回了鉴权/授权失败的响应。

- `accessToken` 必须和 SnowLuma 侧配置的 token 完全一致——可以在 SnowLuma 自身的 `config/onebot_<uin>.json` 里核对。
- 如果 SnowLuma 开启了鉴权、但插件没有配置 `accessToken`（或者反过来，SnowLuma 未启用鉴权但插件配置了一个 token），连接建立或后续的 action 调用都会被拒绝。
- 记得检查 `default` 账号是否误依赖了环境变量回退（`SNOWLUMA_ACCESS_TOKEN` / `SNOWLUMA_TOKEN`）却没有正确设置，或者命名账号（`channels.snowluma.accounts.<id>`）忘了配置 `accessToken`——命名账号**不会**回退到环境变量，必须显式配置。

## mention 从来不触发 {#mention-从来不触发}

按下面的顺序排查（对应 `src/triggers.ts` 的 `evaluateTrigger` 判定顺序，见[三种接收模式 · mention](/guide/receive-modes#mention-被-或关键词命中时立即触发)）：

1. **先确认 `receive.mention.enabled` 没有被设为 `false`**——这是绝对覆盖，为 `false` 时任何条件都不会触发这个模式。
2. **群聊 `@` 触发依赖插件知道机器人自己的 QQ 号（`selfId`）**。`evaluateTrigger` 的提及判定是 `msg.mentions.includes(String(account.selfId))`，如果 `account.selfId` 是 `undefined`，这条规则**永远**不成立，哪怕消息确实 `@` 了机器人。`selfId` 的来源有两个：显式配置，或者网关启动阶段调用 `get_login_info` 自动探测。检查网关启动日志：
   - 正常应该看到 `[snowluma:<accountId>] gateway ready (selfId=<数字>)`；
   - 如果看到 `could not determine the bot's own QQ id`，说明自动探测失败了（网络问题、token 错误等），此时最稳妥的做法是在配置里显式写 `selfId`（或对应的 `SNOWLUMA_SELF_ID` 环境变量，仅对 `default` 账号生效）。
3. **确认没有误用 `@全体成员`**——`atAll` 从不参与提及判定（详见[三种接收模式](/guide/receive-modes#三个容易踩坑的细节)），`@全体成员` 不等于 `@` 机器人。
4. **群聊里如果没有 `@`，检查是否命中了其他触发路径**：回复机器人自己的消息（`triggerOnReplyToSelf`）、关键词（`keywords`/`keywordMatch`/`caseSensitive`）——如果都没命中，且 `requireMentionInGroup: true`（默认），这条消息本来就不该触发，这是预期行为而不是故障。
5. **私聊消息没反应**，检查 `alwaysReplyInDirect` 是否被设为了 `false`——关掉之后私聊也需要命中关键词才会触发。

## digest 从来不触发

1. 确认 `receive.digest.enabled` 为 `true`——这是三个模式里唯一**默认关闭**的。
2. 确认目标聊天落在 `scope`（`"group"` / `"direct"` / `"all"`）与 `peers` 白名单范围内（`peers` 为空表示 `scope` 内全部观察，不是"不限制到不检查 scope"，两个条件是 AND 关系）。
3. **最容易踩的坑是 `minMessages`**：`intervalMs` 到期时，如果缓冲的消息数还没达到 `minMessages`，flush 会被持续抑制——窗口不会清空，只会不断重新排下一个 `intervalMs` 周期的计时器，行为上看起来就是"从来不触发"，但其实是在正常地"抑制-重试"（详见[三种接收模式 · digest](/guide/receive-modes#digest-定时或达到消息数后自动归纳)）。适当调低 `minMessages`，或确认这个聊天的活跃度确实能在一个 `intervalMs` 周期内产生 `minMessages` 条消息。
4. 确认这个聊天没有被 `allowFrom`/`denyFrom` 挡在门外——`isPeerAllowed` 检查发生在 `evaluateTrigger`/`aggregator.accept` **之前**，被拒绝的来源连 digest 缓冲区都进不去。
5. 如果窗口确实 flush 了，但群里什么都没收到：检查 Agent 的回复是不是恰好等于 `SKIP`（大小写不敏感，裁剪首尾空白后比较）——这种情况下插件按设计**不会**发送任何消息，属于正常路径而非故障。

## `ERR_MODULE_NOT_FOUND`，报错路径指向 `@snowluma/sdk` {#err-module-not-found}

说明加载到了**未打补丁**的 `@snowluma/sdk`（背景原理见[快速开始 · `@snowluma/sdk` ESM 补丁说明](/guide/getting-started#snowluma-sdk-esm-补丁说明)）。

**关键事实：OpenClaw 的插件安装器执行 `npm install` 时硬编码了 `--ignore-scripts`**（还在环境里设了 `NPM_CONFIG_IGNORE_SCRIPTS=true`），所以走 `openclaw plugins install` 安装时，本插件的 `postinstall` 钩子**从来不会执行**——指望安装期补丁在网关上是行不通的。

- **`0.1.4` 起插件在加载时自动自我修补**：`src/sdk.ts` 会在第一次真正使用 SDK 之前（网关启动 / 工具借用客户端时）先原地重写 `@snowluma/sdk/dist` 里的坏说明符，再动态 `import` 它。网关日志里会出现一行 `[snowluma] patched N extensionless import(s) ...`，属于正常现象。**在网关上看到本错误 ⇒ 插件版本 < 0.1.4，升级即可。**
- **手动 `npm install` 场景**（不经过 OpenClaw CLI）：`postinstall` 正常时无需干预；如果用了 `npm ci --ignore-scripts` 或手动拷贝了 `node_modules`，`0.1.4` 之前需要手动补一次：

```bash
node ./scripts/patch-snowluma-sdk.mjs
```

这个脚本是幂等的，重复运行安全无副作用；`0.1.4` 起它只是手动安装流程的锦上添花，加载期自愈不依赖它。

## `ERR_REQUIRE_ESM_RACE_CONDITION`，插件加载失败 {#err-require-esm-race-condition}

典型日志（即使**完整重启网关**也会复现）：

```text
[plugins] openclaw-snowluma failed to load ...: Error [ERR_REQUIRE_ESM_RACE_CONDITION]:
Cannot require() ES Module .../openclaw/dist/plugin-sdk/core.js because it is not yet fully loaded.
This may be caused by a race condition if the module is simultaneously dynamically import()-ed via Promise.all().
... (From .../dist/setup-entry.js in non-loader-hook thread)
```

**这是本插件 `<= 0.1.1` 的一个真实加载缺陷，已在 `0.1.2` 彻底修复。** 直接的处理方式是升级：

```bash
openclaw plugins install openclaw-snowluma@latest   # 或指定 openclaw-snowluma@0.1.2
openclaw gateway restart
```

升级后不再需要任何绕行；旧版上无论怎么重启都无法绕开（更早的文档曾建议"完整重启即可"，这是不准确的，特此更正）。

### 根因

OpenClaw 的插件加载器会**同步 `require()`** 插件的两个入口（`dist/setup-entry.js` 读 setup surface、`dist/index.js` 读 extensions），与此同时又在 loader-hook 线程上**异步 `import()`** 它们。在旧版里，入口的模块图**引用了** `openclaw/plugin-sdk/*` 运行时模块（`setup-entry → channel → tools → openclaw/plugin-sdk/core`、`→ gateway → dispatch → runtime → openclaw/plugin-sdk/runtime-store`，以及 `index → openclaw/plugin-sdk/core` 的 `defineChannelPluginEntry`）。当同步 `require()` 走到某个正被异步 `import()` 求值到一半的 `openclaw` 模块时，Node 22+ 的 `require(ESM)` 就抛出 `ERR_REQUIRE_ESM_RACE_CONDITION`，整个插件加载失败。

> `0.1.1` 只修了 `setup-entry.js` 那一条链，于是同样的竞态**转移**到了 `index.js`（报错里 `From ... dist/index.js`）。`0.1.2` 把两个入口都修掉了。

### 修复方式（`0.1.2`）

让**两个被同步 `require()` 的入口模块图都不再引用任何 `openclaw/*` 运行时模块**，同步加载便无从与异步 `import()` 竞争。为此把入口图里仅有的几处 `openclaw` 运行时导入都替换成了本地等价实现——它们对应的 SDK helper 都很薄，逐一核对过 SDK 源码：

- `setup-entry.ts` 内联 `defineSetupPluginEntry`（该 helper 本就只返回 `{ plugin }`）；
- `src/plugin-entry.ts` 本地实现 `defineChannelPluginEntry`（含其默认的 `emptyChannelConfigSchema`），`index.ts` 改用它，替掉对 `openclaw/plugin-sdk/core` 的引用；
- `src/params.ts` 本地实现 `readNumberParam` / `readStringParam`，`src/tools.ts` 改用它；
- `src/runtime.ts` 本地实现运行时 store（等价于 SDK `createPluginRuntimeStore("...")` 字符串重载的模块级闭包），替掉对 `openclaw/plugin-sdk/runtime-store` 的引用。

结果是**整个编译产物没有任何 `openclaw/*` 运行时导入**——插件只通过运行时传入的 `api` / `ctx` 对象和 `import type`（编译期擦除）与宿主交互。`test/load-graph.test.ts` 有一条结构性回归测试，会在任何人再把 `openclaw/*` 运行时导入引入 `index.js` 或 `setup-entry.js` 的模块图时失败。

## `Cannot find module 'typebox'`（或其它运行时依赖）加载失败 {#cannot-find-module}

```text
[plugins] openclaw-snowluma failed to load ...: Error: Cannot find module 'typebox'
Require stack:
- .../node_modules/openclaw-snowluma/dist/src/tools.js
```

历史脉络与最终修复：

- `<= 0.1.2`：`tools.ts` 在模块加载时用 `typebox` 的 `Type.*` 构建工具参数 schema，但 `typebox` 被误放在 `devDependencies` 里——安装插件时不会装 devDependencies，于是加载 `dist/src/tools.js` 时报本错误。
- `0.1.3`：把 `typebox` 挪进 `dependencies`。这只在网关**全新**安装依赖时有效——实践中发现 OpenClaw 可能**复用已有的 generation 安装目录**（日志里插件路径 `...__openclaw-generation__g-<hash>` 的哈希在多次重装后保持不变即是信号），旧目录里的依赖不会因为新 manifest 而补装，错误于是"反复出现"。
- **`0.1.4` 起从根上解决：插件运行时不再依赖 `typebox`。** 工具参数 schema 改为纯 JSON Schema 字面量（与 typebox 1.x `Type.Object(...)` 的产物逐字节一致，typebox 只作为类型引用保留在 devDependencies）。整个插件的运行时外部依赖只剩 `@snowluma/sdk` 一个，而它也是延迟动态加载的（见上一节）——网关怎么装依赖都不会再触发这一类错误。

升级时**务必彻底卸载后重装**，避免网关继续复用旧的 generation 目录：

```bash
openclaw plugins uninstall openclaw-snowluma
# 确认旧安装目录已清理（应无输出）：
ls -d ~/.openclaw/npm/projects/openclaw-snowluma__* 2>/dev/null
openclaw plugins install openclaw-snowluma@latest   # >= 0.1.4
openclaw plugins enable openclaw-snowluma
openclaw gateway restart
```

## 如何开启调试日志

插件本身**不提供**独立的调试开关（比如某个 `SNOWLUMA_DEBUG` 环境变量）——它接受宿主 OpenClaw Gateway 通过 `ctx.log` 注入的日志器（`info`/`error`/`debug` 三个可选方法），但通读 `src/*.ts` 会发现插件目前只调用 `log?.info?.(...)` 和 `log?.error?.(...)`，从不调用 `log?.debug?.(...)`——也就是说插件目前没有区分"调试级"和"信息级"日志，能看到的所有插件日志都会出现在 `info`/`error` 级别，调整宿主自身的日志级别设置不会让插件"吐出更多"信息。

排查时最有用的是抓取带 `[snowluma...]` 前缀的日志行——按模块划分：

| 前缀 | 来源模块 | 典型内容 |
|---|---|---|
| `[snowluma:<accountId>] starting gateway` / `socket open` / `socket closed` / `gateway ready (selfId=...)` | `src/gateway.ts` / `src/channel.ts` | 网关生命周期、连接状态、`selfId` 探测结果 |
| `[snowluma:<accountId>] message handling failed: ...` | `src/gateway.ts` | 单条入站消息处理过程中的异常（已被捕获，不会中断网关） |
| `[snowluma:<accountId>] dispatch failed: ...` / `dispatch error: ...` | `src/gateway.ts` / `src/dispatch.ts` | 一次 Agent 调用批次处理失败 |
| `[snowluma:<accountId>] quote resolution failed: ...` | `src/dispatch.ts` | 引用/转发解析失败（已降级为占位符，不影响本次回复） |
| `[snowluma:<accountId>] send failed: ...` / `media send failed: ...` | `src/dispatch.ts` | 回复发送失败 |
| `[snowluma] getMessage(...) failed: ...` / `getForwardMessage(...) failed: ...` | `src/quote.ts` | 单次 `get_msg`/`get_forward_msg` 调用失败（模块级日志，不带 `accountId`） |
| `[snowluma] realtime accept failed: ...` / `digest accept failed: ...` | `src/aggregator.ts` | 聚合引擎内部异常（同样是模块级前缀） |

这些错误日志本身就是设计上的"降级路径"证据——本插件几乎所有的失败都被有意捕获并记录成一条日志，而不是让异常向上传播中断进程，所以出问题时先看日志、而不是等进程崩溃，是最快的排查方式。
