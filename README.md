# openclaw-snowluma

OpenClaw 的 **SnowLuma QQ 通道插件**：让 QQ 通过 [SnowLuma](https://github.com/) 成为 OpenClaw 的一等消息通道。

- npm 包名：`openclaw-snowluma`
- 插件 `id`：`openclaw-snowluma`（与包名相同）
- 通道 `id`：`snowluma`
- 包名/插件 id 与通道 id **不同**，配置时注意区分：`plugins.allow` / `plugins.entries` 用插件 id `openclaw-snowluma`，运行时账号配置写在 `channels.snowluma` 下（不是 `channels.openclaw-snowluma`）。

## 这是什么

`openclaw-snowluma` 是一个纯粹基于 [`@snowluma/sdk`](https://www.npmjs.com/package/@snowluma/sdk) 构建的 OpenClaw 通道插件。它：

- 通过 SnowLuma 的 WebSocket 长连接接收 QQ 私聊/群聊消息，通过 SnowLuma 的 action 接口（`send_group_msg`、`send_private_msg`、`get_msg`、`get_forward_msg`、`get_group_member_list`、`set_msg_emoji_like` 等）发送消息与执行操作；
- **只通过 SDK 说话**：所有与 SnowLuma 的交互都经由 `SnowLumaWebSocketClient` / `SnowLumaHttpClient` 及其 action 方法完成，插件代码里没有手写的 OneBot 协议解析、没有裸 WebSocket、没有裸 `fetch`。这是一条硬性设计原则——SnowLuma 协议细节的变化应该只需要升级 `@snowluma/sdk`，而不需要改插件逻辑。
- 提供三种可组合的接收模式（被动 @/关键词触发、定时摘要、亚秒级消息聚合）、主动的引用/合并转发消息解析，以及两个供 Agent 调用的只读工具（聊天记录、群成员列表）。

本 README 是速查手册；更完整的架构说明、分模块细节和更多配置示例见文档站点（`docs/`），本地预览：

```bash
npm run docs:dev     # 本地启动 VitePress 文档站点
npm run docs:build    # 构建静态文档站点
```

## 环境要求

- Node.js **>= 22.14**（`package.json#engines.node`）
- 一个正在运行的 **SnowLuma** 实例，并已登录目标 QQ 账号
- SnowLuma 的 OneBot WebSocket 地址（`wsUrl`）和 access token（`accessToken`）。这两项通常可以在 SnowLuma 自身的配置目录下的 `config/onebot_<uin>.json` 中找到（`<uin>` 是登录的 QQ 号），也可以在 SnowLuma 的管理界面/配置文件里确认监听端口与鉴权设置。

## 安装与启用

推荐用 OpenClaw 自带的插件管理 CLI 安装并启用——它会自动把插件写进 `openclaw.json` 的 `plugins.entries` / `plugins.allow`：

```bash
# 1. 安装（不带前缀默认从 npm 解析；npm:openclaw-snowluma 是等价的显式写法）
openclaw plugins install openclaw-snowluma
# 2. 安装不会自动启用，需要显式 enable
openclaw plugins enable openclaw-snowluma
# 3. 完整重启网关加载插件（见下方“为什么要完整重启”）
openclaw gateway restart
# 4. 确认已注册
openclaw plugins inspect openclaw-snowluma --runtime
openclaw plugins list --enabled
```

注意：`openclaw plugins install` 底层虽然走 npm，但 OpenClaw 的安装器**硬编码了 `--ignore-scripts`**，本插件的 `postinstall` 补丁在这条路径上不会执行——`0.1.4` 起改由插件加载时自动完成同样的修补，无需手动干预（见下方 [`@snowluma/sdk` ESM 兼容性说明](#snowlumasdk-esm-兼容性说明)）。其它安装源：`npm:<pkg>@<ver>`（`--pin` 锁定版本）、`git:github.com/<owner>/<repo>`、本地开发用 `--link ./`（需先 `npm run build`）；卸载用 `openclaw plugins uninstall openclaw-snowluma`，排查加载问题用 `openclaw plugins doctor`。

**为什么要完整重启**：`enable` / `install` 只是写入配置，网关需要（重新）加载插件代码才会生效，完整 `openclaw gateway restart` 最稳妥。（注意：若在 `<= 0.1.1` 上看到 `ERR_REQUIRE_ESM_RACE_CONDITION` 加载失败，那是一个已在 `0.1.2` 彻底修复的加载缺陷，完整重启也绕不开，需升级到 `0.1.2`+，详见 [`docs/guide/troubleshooting`](docs/guide/troubleshooting.md#err-require-esm-race-condition)。）

也可以退回**纯手动方式**：`npm install openclaw-snowluma`，然后在 `openclaw.json` 里自己写 `plugins.allow` / `plugins.entries`——CLI 方式只是把这两段配置的写入自动化了，`channels.snowluma` 账号配置两种方式都要自己填。手动方式下的 `openclaw.json` 结构：

```json
{
  "plugins": {
    "allow": ["openclaw-snowluma"],
    "entries": {
      "openclaw-snowluma": {
        "enabled": true
      }
    }
  },
  "channels": {
    "snowluma": {
      "enabled": true,
      "wsUrl": "ws://127.0.0.1:3001/",
      "accessToken": "your-snowluma-token"
    }
  }
}
```

说明：

- `plugins.allow` / `plugins.entries` 使用插件 id `openclaw-snowluma`
- 通道运行时配置写在 `channels.snowluma`（不是 `channels.openclaw-snowluma`）
- 也可以用环境变量代替显式配置（仅对 `default` 账号生效）：

```bash
SNOWLUMA_WS_URL=ws://127.0.0.1:3001/
SNOWLUMA_HTTP_URL=http://127.0.0.1:3001
SNOWLUMA_ACCESS_TOKEN=your-snowluma-token   # 或 SNOWLUMA_TOKEN
SNOWLUMA_SELF_ID=123456789
```

更完整的最小/全量配置示例见 [`examples/`](examples/)（`examples/openclaw.minimal.json`、`examples/openclaw.full.json`），以及其中的配置引导说明 [`examples/README.md`](examples/README.md)。

配置完成后**完整重启** gateway（同样别依赖热重载，理由见上文）：

```bash
openclaw gateway restart
```

## `@snowluma/sdk` ESM 兼容性说明

这是一个 **上游打包问题**，不是本插件引入的行为：`@snowluma/sdk`（截至 v1.12.8）在 `package.json` 里声明了 `"type": "module"`，但其编译产物中使用了不带扩展名的相对导入（例如 `export ... from './client/api-client'`）。Node 的 ESM 解析器要求相对导入必须带完整文件扩展名，因此在未打补丁的 Node 环境下 `import "@snowluma/sdk"` 会直接抛出 `ERR_MODULE_NOT_FOUND`，插件代码根本来不及运行。

修补方式（`0.1.4` 起）分两层，语义一致、都是幂等的（重复运行不产生副作用，也不会破坏已打补丁的文件）：

1. **加载期自愈（主路径）**：`src/sdk.ts` 在第一次真正使用 SDK 之前，先原地重写 `@snowluma/sdk/dist` 里的坏说明符（能解析到 `./x.js` / `./x/index.js` 的说明符补上扩展名；已带扩展名或裸包名的不动），再动态 `import("@snowluma/sdk")`。这是网关上的实际生效路径——**OpenClaw 的插件安装器带 `--ignore-scripts` 执行 npm，任何 `postinstall` 钩子都不会运行**，所以修补必须发生在加载期。
2. **`postinstall` 兜底（`scripts/patch-snowluma-sdk.mjs`）**：手动 `npm install` 时照常执行；用了 `npm ci --ignore-scripts` 或手动拷贝 `node_modules` 的场景可手动补一次：

```bash
node ./scripts/patch-snowluma-sdk.mjs
```

一旦上游发布了修复版本，加载期修补和这个脚本都应当被删除。

## 三种接收模式

三种模式定义在 `channels.snowluma.receive` 下，**默认全部独立开启/关闭状态不同**（见下方配置表），并且**可以组合使用**——同一条消息可以同时喂给 realtime 聚合引擎和 digest 摘要引擎，两者互不影响、各自维护自己的缓冲窗口。

### `mention`：被 @ 或命中关键词时直接回答

```json
{
  "receive": {
    "mention": {
      "enabled": true,
      "requireMentionInGroup": true,
      "keywords": ["机器人", "小助手"],
      "keywordMatch": "contains",
      "caseSensitive": false,
      "triggerOnReplyToSelf": true,
      "alwaysReplyInDirect": true
    }
  }
}
```

触发时机（按判定顺序）：

1. `mention.enabled === false` 时，该模式永远不会触发。
2. 私聊消息 + `alwaysReplyInDirect: true`（默认）⇒ 直接触发，`reason: "direct"`。
3. 群聊消息中 `@` 了机器人（`selfId`）⇒ 触发，`reason: "mention"`（`@全体成员` 不算命中）。
4. 群聊消息回复了机器人自己发过的消息，且 `triggerOnReplyToSelf: true`（默认）⇒ 触发，`reason: "reply-to-self"`。
5. 消息文本命中 `keywords`（按 `keywordMatch` / `caseSensitive` 规则）⇒ 触发，`reason: "keyword"`。
6. 群聊中如果 `requireMentionInGroup: true`（默认）且以上都未命中 ⇒ 不触发；如果 `requireMentionInGroup: false`，则未配置关键词时任何群消息都会触发，配置了关键词时仍按关键词门控。
7. 私聊消息且 `alwaysReplyInDirect: false`、关键词也未命中 ⇒ 不触发。

### `digest`：定时或达到消息数后自动归纳聊天内容

```json
{
  "receive": {
    "digest": {
      "enabled": true,
      "intervalMs": 300000,
      "maxMessages": 50,
      "minMessages": 3,
      "prompt": "请用简洁的中文归纳这段时间的讨论主题、结论和待办事项，没有值得汇报的内容请只回复 SKIP。",
      "scope": "group",
      "peers": ["group:20000002"],
      "maxTranscriptChars": 20000
    }
  }
}
```

`digest` 默认**关闭**（`enabled: false`）。开启后，插件会持续缓冲 `scope`（`group` / `direct` / `all`）范围内、且在 `peers` 白名单内（为空表示不限制）的**每一条**消息——无论是否命中 `mention` 触发条件。缓冲窗口按 `peerId` 独立维护，满足以下任一条件即 flush：

- 自窗口打开起过去了 `intervalMs` 毫秒；
- 缓冲消息数达到 `maxMessages`。

但如果此时缓冲的消息数不足 `minMessages`，flush 会被抑制——窗口不清空，计时器重新开始计时，继续攒消息。flush 时会把 `prompt` 与截断到 `maxTranscriptChars` 字符以内的聊天记录一起交给 Agent；如果 Agent 的最终回复裁剪后恰好等于 `SKIP`（大小写不敏感），插件不会发送任何消息。**摘要轮次永远不会被授权执行文本命令**（`/status`、`/model` 等），即使 `allowFrom` 已经把这个来源加入白名单也一样，防止群聊消息注入指令。

### `realtime`：亚秒级窗口内聚合连发消息后立刻回答

```json
{
  "receive": {
    "realtime": {
      "enabled": true,
      "windowMs": 800,
      "maxWindowMs": 3000,
      "maxMessages": 10,
      "maxChars": 8000
    }
  }
}
```

这是"连续打好几行字"的场景——用户短时间内发了三条消息，插件应该合并成一次 Agent 调用，回复一次而不是三次。窗口按 `${peerId}::${senderId}` 维度独立维护，**只有一条命中 `mention` 触发条件的消息才能打开窗口**；窗口打开后，同一 `peerId`+`senderId` 的后续消息（无论是否再次命中触发条件）都会并入这个窗口。满足以下任一条件即 flush：

- 自上一条消息起过去了 `windowMs` 毫秒的静默期（每条新消息都会重置这个计时器）；
- 自窗口打开起过去了 `maxWindowMs` 毫秒（硬上限，不会被静默期计时器无限拖延）；
- 缓冲消息数达到 `maxMessages`；
- 缓冲文本总长度超过 `maxChars`。

当 `realtime.enabled: false` 时，命中触发条件的消息会立即单独 flush（`reason: "immediate"`），不再等待聚合窗口。

## 引用消息 / 合并转发

插件在收到消息后会**主动**调用 SnowLuma 的 `get_msg`（解析引用/回复消息）和 `get_forward_msg`（展开合并转发），而不是等 Agent 去问——这样 Agent 从一开始就能看到被引用或转发的完整上下文。行为由 `channels.snowluma.quote` 控制：

```json
{
  "quote": {
    "enabled": true,
    "resolveForward": true,
    "maxDepth": 2,
    "maxNodes": 20,
    "maxChars": 4000,
    "timeoutMs": 10000
  }
}
```

| 选项 | 说明 |
|---|---|
| `enabled` | 是否主动通过 `get_msg` 拉取被引用的消息。关闭后引用消息不会被解析，Agent 只能看到"这是一条回复"而看不到被回复的内容。 |
| `resolveForward` | 是否通过 `get_forward_msg` 展开合并转发的内容。 |
| `maxDepth` | 合并转发可以嵌套多深；插件会对转发 id 做环检测，避免死循环。 |
| `maxNodes` | 单次展开渲染的转发节点数上限。 |
| `maxChars` | 注入到 Agent 可见正文中的引用/转发文本字符上限，超出会被截断并标记 `truncated`。 |
| `timeoutMs` | 每次 SnowLuma 调用的超时时间。 |

任何一次 SnowLuma 调用失败都会**降级**为占位符 `[引用消息获取失败]`，而不会让整条消息处理链路抛出异常。

## Agent 工具

插件注册了两个只读 Agent 工具（`channels.snowluma.tools.enabled` 控制是否注册，默认 `true`）。两个工具都不会抛出异常——失败时返回 `details.status === "failed"` 加错误描述，而不是让 Agent 调用中断。

### `snowluma_get_history`

获取指定 QQ 群聊或私聊的历史消息，按时间从旧到新渲染为 `[HH:mm:ss] 昵称(qq): 文本`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | string | 是 | 会话目标：`group:<群号>` / `private:<QQ号>`，裸数字视为私聊。 |
| `count` | number | 否 | 返回的消息条数，默认 20，范围 1–100（超出范围会被夹取）。 |
| `messageSeq` | number | 否 | 分页锚点（对应 SnowLuma 的 `message_id`），从该消息向更早翻页。 |
| `accountId` | string | 否 | SnowLuma 账号 id，默认使用 `default` 账号。 |

示例调用参数：

```json
{ "target": "group:20000002", "count": 30 }
```

### `snowluma_get_group_members`

获取指定 QQ 群的成员列表，渲染为 `昵称/群名片(qq) — role`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `groupId` | number \| string | 是 | 群号。 |
| `noCache` | boolean | 否 | 跳过缓存，强制向 SnowLuma 请求最新数据。 |
| `limit` | number | 否 | 返回的最大成员数，默认 100，范围 1–500（超出范围会被夹取）。 |
| `accountId` | string | 否 | SnowLuma 账号 id，默认使用 `default` 账号。 |

示例调用参数：

```json
{ "groupId": 20000002, "noCache": true, "limit": 50 }
```

## `react` 消息动作

插件实现了 OpenClaw 的 `react` channel action，底层通过 SnowLuma 的 `set_msg_emoji_like` 给一条消息加表情回应（`reactToMessage(client, messageId, emojiId)`）。除了 Agent/工具可以显式调用这个 action 之外，还可以通过账号级配置让插件对**每一条触发了 Agent 的群消息**自动加上表情回应：

```json
{
  "groupAutoReact": true,
  "groupAutoReactEmojiId": 76
}
```

`groupAutoReact` 默认 `false`；`groupAutoReactEmojiId` 默认 `1`。这是入站侧的"自动确认收到"效果，和 `react` action（出站/工具侧、按需对指定 `message_id` 加表情）是两回事，两者共享同一个 `set_msg_emoji_like` 调用路径。

## 消息目标格式

发送/工具调用中使用的目标字符串格式：

- `snowluma:group:<群号>` — 群聊消息（完整带通道前缀的形式）
- `snowluma:private:<QQ号>` — 私聊消息
- `group:<群号>` / `private:<QQ号>` — 省略通道前缀也可以识别
- `<QQ号>`（裸数字）— 自动识别为私聊

## 完整配置示例

以下示例覆盖 `SnowLumaAccountConfig` 的每一个选项（`jsonc` 仅用于加注释，实际 `openclaw.json` 不支持注释，写入前请去掉 `//` 行）：

```jsonc
{
  "plugins": {
    "allow": ["openclaw-snowluma"],
    "entries": {
      "openclaw-snowluma": { "enabled": true }
    }
  },
  "channels": {
    "snowluma": {
      "enabled": true,                 // 启用该账号，默认 true
      "name": "主账号",                 // 展示名，可选
      "wsUrl": "ws://127.0.0.1:3001/", // SnowLuma OneBot WebSocket 地址
      "httpUrl": "http://127.0.0.1:3001", // 可选：设置后 action 走 HTTP 而不是 WS
      "accessToken": "your-snowluma-token",
      "selfId": 123456789,             // 机器人自己的 QQ 号；省略则自动通过 get_login_info 检测
      "allowFrom": ["private:10000001", "group:20000002"], // 未设置=允许所有来源
      "denyFrom": ["private:99999999"],                    // 在 allowFrom 之后生效，始终优先
      "groupAutoReact": true,          // 默认 false
      "groupAutoReactEmojiId": 76,     // 默认 1
      "replyToTrigger": true,          // 默认 true：回复以 QQ 引用形式发送
      "textChunkLimit": 4500,          // 默认 4500
      "requestTimeoutMs": 30000,       // 默认 30000
      "reconnect": {
        "enabled": true,               // 默认 true
        "retries": 20,                 // 默认：省略该字段=无限重连；显式数值（含 0）按字面值生效，0 表示不重连
        "minDelayMs": 1000,            // 默认 1000
        "maxDelayMs": 30000            // 默认 30000
      },
      "receive": {
        "mention": {
          "enabled": true,                 // 默认 true
          "requireMentionInGroup": true,   // 默认 true
          "keywords": ["机器人", "小助手"], // 默认 []
          "keywordMatch": "contains",      // 默认 "contains"
          "caseSensitive": false,          // 默认 false
          "triggerOnReplyToSelf": true,    // 默认 true
          "alwaysReplyInDirect": true      // 默认 true
        },
        "digest": {
          "enabled": true,        // 默认 false
          "intervalMs": 300000,   // 默认 300000（5 分钟）
          "maxMessages": 50,      // 默认 50
          "minMessages": 3,       // 默认 3
          "prompt": "请用简洁的中文归纳这段时间的讨论主题、结论和待办事项，没有值得汇报的内容请只回复 SKIP。",
          "scope": "group",       // 默认 "group"
          "peers": ["group:20000002"], // 默认 []（不限制）
          "maxTranscriptChars": 20000  // 默认 20000
        },
        "realtime": {
          "enabled": true,     // 默认 true
          "windowMs": 800,     // 默认 800
          "maxWindowMs": 3000, // 默认 3000
          "maxMessages": 10,   // 默认 10
          "maxChars": 8000     // 默认 8000
        }
      },
      "quote": {
        "enabled": true,         // 默认 true
        "resolveForward": true,  // 默认 true
        "maxDepth": 2,           // 默认 2
        "maxNodes": 20,          // 默认 20
        "maxChars": 4000,        // 默认 4000
        "timeoutMs": 10000       // 默认 10000
      },
      "tools": { "enabled": true }, // 默认 true
      "accounts": {
        "secondary": {
          "enabled": true,
          "wsUrl": "ws://127.0.0.1:3002/",
          "accessToken": "another-token",
          "allowFrom": ["*"]
        }
      }
    }
  }
}
```

## 配置项参考

以下默认值均直接取自 `src/config.ts` 的 `RECEIVE_DEFAULTS` / `QUOTE_DEFAULTS` 与 `resolveSnowLumaAccount`。

### 账号级选项（`channels.snowluma` 或 `channels.snowluma.accounts.<id>`）

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用该账号。 |
| `name` | string | — | 展示名。 |
| `wsUrl` | string | — | SnowLuma OneBot WebSocket 地址。`default` 账号可从 `SNOWLUMA_WS_URL` 环境变量回退。 |
| `httpUrl` | string | — | 可选 HTTP API 地址；设置后 action 走 HTTP。`default` 账号可从 `SNOWLUMA_HTTP_URL` 回退。**注意**：网关启动后会把它自己的 WebSocket 连接注册为该账号的"活跃客户端"，Agent 工具与 dispatch 侧的 action 调用会优先复用这条已打开的连接，而不是新开 HTTP 请求；`httpUrl` 实际生效的场景是网关尚未启动、或调用发生在网关进程之外（没有已注册的活跃客户端）时。 |
| `accessToken` | string | — | SnowLuma access token。`default` 账号可从 `SNOWLUMA_ACCESS_TOKEN`（或 `SNOWLUMA_TOKEN`）回退。 |
| `selfId` | number \| string | — | 机器人自己的 QQ 号；省略时通过 `get_login_info` 自动探测。`default` 账号可从 `SNOWLUMA_SELF_ID` 回退。 |
| `allowFrom` | string[] | — | 来源白名单，如 `["private:123", "group:456", "*"]`；未设置表示允许所有来源。 |
| `denyFrom` | string[] | — | 来源黑名单，在 `allowFrom` 判定之后生效，始终优先。 |
| `groupAutoReact` | boolean | `false` | 是否对触发了 Agent 的入站群消息自动加表情回应。 |
| `groupAutoReactEmojiId` | number \| string | `1` | `groupAutoReact` 使用的 QQ 表情 id。 |
| `replyToTrigger` | boolean | `true` | 回复是否以 QQ 引用（quote-reply）触发消息的形式发送。 |
| `textChunkLimit` | number | `4500` | 出站文本按此字符数分块。 |
| `requestTimeoutMs` | number | `30000` | SnowLuma action 调用超时（毫秒）。 |
| `reconnect.enabled` | boolean | `true` | 是否启用 SDK 内置的 WebSocket 自动重连。 |
| `reconnect.retries` | number | 省略 = 无限重连 | 最大重连次数。省略该字段表示无限重连；显式指定的数值（**包括 `0`**）会按字面值生效——`0` 表示断线后不再自动重连。 |
| `reconnect.minDelayMs` | number | `1000` | 重连最小延迟（毫秒）。 |
| `reconnect.maxDelayMs` | number | `30000` | 重连最大延迟（毫秒）。 |
| `receive.mention.enabled` | boolean | `true` | 是否启用 mention/关键词触发。 |
| `receive.mention.requireMentionInGroup` | boolean | `true` | 群聊中是否要求 `@` 机器人才能触发（无关键词命中时）。 |
| `receive.mention.keywords` | string[] | `[]` | 无需 `@` 也能触发的关键词。 |
| `receive.mention.keywordMatch` | `"contains"\|"prefix"\|"exact"\|"regex"` | `"contains"` | 关键词匹配方式。 |
| `receive.mention.caseSensitive` | boolean | `false` | 关键词匹配是否大小写敏感。 |
| `receive.mention.triggerOnReplyToSelf` | boolean | `true` | 回复机器人自己发的消息是否算触发。 |
| `receive.mention.alwaysReplyInDirect` | boolean | `true` | 私聊消息是否无条件触发。 |
| `receive.digest.enabled` | boolean | `false` | 是否启用定时摘要模式。 |
| `receive.digest.intervalMs` | number | `300000` | 摘要窗口的最大存活时间（毫秒，5 分钟）。 |
| `receive.digest.maxMessages` | number | `50` | 达到这么多条消息即 flush。 |
| `receive.digest.minMessages` | number | `3` | 低于该消息数不会 flush（会重置计时器继续攒）。 |
| `receive.digest.prompt` | string | 内置中文摘要提示语 | flush 时拼接在聊天记录前的指令。默认值：“以下是这段时间的群聊记录。请用简洁的中文归纳讨论的主题、结论和待办事项；如果没有值得汇报的内容，只回复 SKIP。” |
| `receive.digest.scope` | `"group"\|"direct"\|"all"` | `"group"` | 摘要引擎观察哪些聊天类型。 |
| `receive.digest.peers` | string[] | `[]` | 只观察这些 peer；为空表示 `scope` 范围内全部观察。 |
| `receive.digest.maxTranscriptChars` | number | `20000` | 交给 Agent 的聊天记录字符数上限。 |
| `receive.realtime.enabled` | boolean | `true` | 是否启用亚秒级聚合。关闭后触发消息会立即单独 flush。 |
| `receive.realtime.windowMs` | number | `800` | 静默 flush 的等待时间（毫秒），每条新消息重置计时器。 |
| `receive.realtime.maxWindowMs` | number | `3000` | 窗口最长可以被撑开多久（毫秒），硬上限。 |
| `receive.realtime.maxMessages` | number | `10` | 缓冲消息数达到此值立即 flush。 |
| `receive.realtime.maxChars` | number | `8000` | 缓冲文本字符数超过此值立即 flush。 |
| `quote.enabled` | boolean | `true` | 是否主动通过 `get_msg` 解析引用消息。 |
| `quote.resolveForward` | boolean | `true` | 是否主动通过 `get_forward_msg` 展开合并转发。 |
| `quote.maxDepth` | number | `2` | 合并转发的最大展开深度。 |
| `quote.maxNodes` | number | `20` | 单次展开渲染的转发节点数上限。 |
| `quote.maxChars` | number | `4000` | 注入正文的引用/转发文本字符上限。 |
| `quote.timeoutMs` | number | `10000` | 每次 SnowLuma 调用的超时时间（毫秒）。 |
| `tools.enabled` | boolean | `true` | 是否注册 `snowluma_get_history` / `snowluma_get_group_members` 两个 Agent 工具。 |
| `accounts` | object | — | 额外账号，键为账号 id，值为同结构的账号配置（见 `openclaw.plugin.json` 里的 `$defs/account`）。 |

## 开发

```bash
npm install         # 会自动执行 postinstall 补丁脚本
npm run build       # tsc 编译
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest（watch 模式）
npm run coverage    # vitest run --coverage
npm run docs:dev    # 本地启动 VitePress 文档站点
npm run docs:build  # 构建静态文档站点
```

## 故障排查

**连接被拒绝 / 一直连不上（`ECONNREFUSED` 等）**
确认 SnowLuma 已经启动并监听 `wsUrl` 指向的地址和端口；跨主机或容器部署时检查网络可达性与防火墙规则；确认 `wsUrl` 协议、主机、端口都正确（注意 `ws://` 和 `http://` 分别对应 `wsUrl` / `httpUrl` 两个不同选项，不要混用）。

**token 被拒绝（`SnowLumaAuthError`）**
`accessToken` 必须和 SnowLuma 侧配置的 token 一致——可以在 SnowLuma 的 `config/onebot_<uin>.json` 里核对。如果 SnowLuma 开启了鉴权而插件没有配置 `accessToken`（或反过来），连接/请求会被拒绝。

**mention 从来不触发**
先确认 `receive.mention.enabled` 没有被设为 `false`。群聊 `@` 触发依赖插件知道机器人自己的 QQ 号（`selfId`）——如果既没有显式配置 `selfId`，`get_login_info` 自动探测又失败了（网络问题、token 错误等），插件无法判断一条消息是不是在 `@` 自己，`reason: "mention"` 就永远不会命中。检查网关启动日志里是否有 `selfId` 探测失败的告警，或者直接显式配置 `selfId`。

**digest 从来不触发**
确认 `receive.digest.enabled` 为 `true`；确认目标聊天在 `scope`（`group`/`direct`/`all`）与 `peers` 白名单范围内；最容易踩的坑是 `minMessages`——窗口攒的消息数如果一直没达到 `minMessages`，flush 会被持续抑制，只会不断重置计时器，看起来就像"从来不触发"。适当调低 `minMessages` 或确认聊天活跃度足够。

**`ERR_MODULE_NOT_FOUND`，报错路径指向 `@snowluma/sdk`**
加载到了未打补丁的 `@snowluma/sdk`。`0.1.4` 起插件在加载时自动自我修补（网关上看到本错误 ⇒ 版本 < 0.1.4，升级即可）；手动安装场景可执行 `node ./scripts/patch-snowluma-sdk.mjs` 后重试。详见上方 [`@snowluma/sdk` ESM 兼容性说明](#snowlumasdk-esm-兼容性说明)。

**`Cannot find module 'typebox'`**
`<= 0.1.3` 的运行时依赖问题（`0.1.3` 曾把 `typebox` 挪进 `dependencies`，但网关可能复用旧的 generation 安装目录导致依赖不齐）。`0.1.4` 起运行时不再依赖 `typebox`（schema 改为纯 JSON 字面量），彻底卸载后重装 `>= 0.1.4` 即可。

## License

MIT
