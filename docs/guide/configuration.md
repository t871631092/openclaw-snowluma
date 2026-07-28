# 配置参考

本页是完整的配置项参考。所有默认值都直接取自 `src/config.ts` 的 `RECEIVE_DEFAULTS`、`QUOTE_DEFAULTS` 与 `resolveSnowLumaAccount` 函数——如果这页文档和你实际观察到的行为对不上，以 `src/config.ts` 为准。

## 解析规则

在看具体的表格之前，先了解三条贯穿所有配置解析的规则（都实现在 `src/config.ts`）：

- **显式配置 > 环境变量 > 内置默认值**，且环境变量只对 `default` 账号生效（见下方[环境变量](#环境变量)）。
- **类型不匹配会静默退化为默认值**，不会抛异常。布尔项用 `typeof value === "boolean"` 判断，不是布尔就用默认值；数字项统一转换为 `Number(value)`，非有限数（`NaN`/`Infinity`）或不满足正负约束就退回默认值，否则 `Math.floor()` 取整。
- **`accounts` 之外都是 `default` 账号的字段**。写在 `channels.snowluma` 顶层的字段（`accounts` 本身除外）构成 `default` 账号；额外账号必须写在 `channels.snowluma.accounts.<id>` 下，结构与 `default` 账号完全一致（详见[多账号](#多账号)）。

## 顶层账号选项

写在 `channels.snowluma`（`default` 账号）或 `channels.snowluma.accounts.<id>`（命名账号）下的字段。

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用该账号。判定逻辑是 `!== false`，也就是说除了显式的 `false`，任何其他值（包括缺省）都视为启用。 |
| `name` | `string` | — | 展示名，可选。 |
| `wsUrl` | `string` | `""`（`default` 账号可回退到 `SNOWLUMA_WS_URL`） | SnowLuma 的 OneBot WebSocket 地址，例如 `ws://127.0.0.1:3001/`。命名账号没有环境变量回退，必须显式配置。 |
| `httpUrl` | `string` | `undefined`（`default` 账号可回退到 `SNOWLUMA_HTTP_URL`） | 可选的 HTTP API 地址。设置后，一次性 action 调用（Agent 工具、非网关进程里的发送）会优先走 HTTP 而不是新开一个 WebSocket（见 `src/client.ts` 的 `acquireActionClient`）。 |
| `accessToken` | `string` | `undefined`（`default` 账号可回退到 `SNOWLUMA_ACCESS_TOKEN`，其次 `SNOWLUMA_TOKEN`） | SnowLuma 的 access token。 |
| `selfId` | `number \| string` | `undefined`（`default` 账号可回退到 `SNOWLUMA_SELF_ID`） | 机器人自己的 QQ 号。省略时网关启动阶段会调用 `get_login_info` 自动探测；探测失败则群聊 `@` 触发永远不会命中（详见[三种接收模式](/guide/receive-modes)）。字符串会被 `Number()` 转换，转换失败则视为未设置。 |
| `allowFrom` | `string[]` | `undefined`（未设置 = 允许所有来源） | 来源白名单，元素形如 `"private:123"` / `"group:456"`，或通配符 `"*"`。 |
| `denyFrom` | `string[]` | `undefined` | 来源黑名单，在 `allowFrom` 判定**之后**生效，始终优先——即使某个 peer 同时命中 `allowFrom` 和 `denyFrom`，结果也是拒绝。 |
| `groupAutoReact` | `boolean` | `false` | 是否对触发了 Agent 的入站群消息自动加表情回应（`groupAutoReact === true` 才算启用，其余任何值都是 `false`）。 |
| `groupAutoReactEmojiId` | `number \| string` | `1` | `groupAutoReact` 使用的 QQ 表情 id。 |
| `replyToTrigger` | `boolean` | `true` | 回复是否以 QQ 引用（quote-reply）触发消息的形式发送；对 realtime 批次引用开窗那条消息，对 `/summary` 批次引用命令那条消息（digest 批次没有单条"触发消息"可引用）。 |
| `textChunkLimit` | `number` | `4500` | 出站文本按此字符数分块发送（正整数，非法值回退默认值）。 |
| `requestTimeoutMs` | `number` | `30000` | SnowLuma action 调用超时（毫秒）。 |
| `debug` | `boolean` | `false` | 调试模式：把每条出站消息的原始载荷（目标 + 渲染出的 OneBot 段）打进日志。网关回复路径经 `log.info` 输出，主机直发路径（`channel.ts`）经 `console.info` 输出。仅 `true` 才算启用。 |
| `reconnect` | `object` | 见下表 | WebSocket 重连调优，直接传给 `@snowluma/sdk` 的 `SnowLumaWebSocketClientOptions.reconnect`。 |
| `receive` | `object` | 见下方各表 | 接收模式的配置（`mention` / `digest` / `summary` / `realtime` / `history`）。 |
| `quote` | `object` | 见下表 | 引用/合并转发主动解析配置。 |
| `tools` | `object` | 见下表 | Agent 工具注册开关。 |
| `accounts` | `object` | — | 额外命名账号，仅在 `default` 账号（顶层 `channels.snowluma`）下有意义，见[多账号](#多账号)。 |

## `receive.mention` —— 被 @ 或命中关键词时触发

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用该模式。`false` 是绝对开关——为 `false` 时，无论消息内容如何，这个模式都不会触发。 |
| `requireMentionInGroup` | `boolean` | `true` | 群聊中是否要求 `@` 机器人（或命中关键词/回复自身消息）才触发。 |
| `keywords` | `string[]` | `[]` | 无需 `@` 也能触发的关键词列表。传入非数组会被归一化为 `[]`；数组元素统一 `String()` 化并去除首尾空白，空字符串被过滤掉。 |
| `keywordMatch` | `"contains" \| "prefix" \| "exact" \| "regex"` | `"contains"` | 关键词匹配方式：`contains` 包含匹配、`prefix` 前缀匹配（忽略消息前导空白）、`exact` 全字匹配（忽略消息首尾空白）、`regex` 把关键词当正则表达式（无效正则会静默跳过，不会抛异常）。传入其他值一律回退为 `contains`。 |
| `caseSensitive` | `boolean` | `false` | 关键词匹配是否大小写敏感。 |
| `triggerOnReplyToSelf` | `boolean` | `true` | 群聊中回复机器人自己发过的消息是否算触发。 |
| `alwaysReplyInDirect` | `boolean` | `true` | 私聊消息是否无条件触发（不需要关键词或其他条件）。 |

判定顺序、`atAll` 为什么不算命中、`selfId` 缺失时的行为，详见[三种接收模式 · mention](/guide/receive-modes#mention-被-或关键词命中时立即触发)。

## `receive.digest` —— 定时/达量摘要 {#receive-digest-定时达量摘要}

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `false` | 是否启用该模式（**默认关闭**，是三个模式里唯一默认关闭的）。 |
| `intervalMs` | `number` | `300000`（5 分钟） | 窗口的最大存活时间；到期后如果消息数达到 `minMessages` 就 flush，否则重置计时器继续等。正整数，非法值回退默认值。 |
| `maxMessages` | `number` | `50` | 缓冲消息数达到此值立即 flush（不受 `minMessages` 约束——这是"够多了"而不是"够久了"的判定路径）。 |
| `minMessages` | `number` | `3` | 低于该消息数时，`intervalMs` 到期也不会 flush。**内部会被夹到不超过 `maxMessages`**（`Math.min(minMessages, maxMessages)`），避免配置出一个永远无法达到、因而永远无法 flush 的窗口。 |
| `prompt` | `string` | 见下方 | flush 时拼接在聊天记录前的指令文字。传入空字符串或纯空白会回退到默认值。 |
| `scope` | `"group" \| "direct" \| "all"` | `"group"` | 摘要引擎观察哪些聊天类型。传入其他值回退为 `"group"`。 |
| `peers` | `string[]` | `[]` | 只观察这些 peer（如 `"group:123"`）；为空表示 `scope` 范围内全部观察。 |
| `maxTranscriptChars` | `number` | `20000` | 交给 Agent 的聊天记录字符数硬上限。 |

默认 `prompt`（`DEFAULT_DIGEST_PROMPT`，逐字取自 `src/config.ts`）：

> 以下是这段时间的群聊记录。请用简洁的中文归纳讨论的主题、结论和待办事项；如果没有值得汇报的内容，只回复 SKIP。

`minMessages` 的抑制-重试语义、SKIP 静默、命令注入防护，详见[三种接收模式 · digest](/guide/receive-modes#digest-定时或达到消息数后自动归纳)。

## `receive.summary` —— `/summary` 主动总结命令 {#receive-summary-summary-主动总结命令}

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用 `/summary` 命令（**默认开启**）。关掉后命令词会退回普通消息，照常走 `mention`/`realtime` 流程。 |
| `commands` | `string[]` | `["/summary", "/总结"]` | 触发命令词，匹配消息去掉前导 `@机器人` 后的开头。大小写不敏感；**传入空数组会回退到默认值**（否则就没有任何词能触发了）。 |
| `count` | `number` | `100` | 命令没带数字时，拉取并总结最近多少条消息。会被 `maxCount` 夹住。 |
| `maxCount` | `number` | `200` | 用户通过 `/summary <n>` 能请求的条数上限。 |
| `prompt` | `string` | 见下方 | 拼在聊天记录前的指令文字。传入空字符串或纯空白会回退到默认值。 |
| `scope` | `"group" \| "direct" \| "all"` | `"all"` | 哪些聊天类型可以使用该命令。传入其他值回退为 `"all"`。 |
| `peers` | `string[]` | `[]` | 只有这些 peer 可以使用（如 `"group:123"`）；为空表示 `scope` 范围内全部可用。 |
| `maxTranscriptChars` | `number` | `20000` | 交给 Agent 的聊天记录字符数硬上限。 |

默认 `prompt`（`DEFAULT_SUMMARY_PROMPT`，逐字取自 `src/config.ts`）：

> 以下是这个会话最近的聊天记录。请用简洁的中文总结其中讨论的主题、结论和待办事项，必要时按话题分点列出。这是用户主动请求的总结，请直接给出总结内容，不要回复 SKIP。

与 `digest` 的区别、消息从哪里来、失败时会回什么，详见[接收模式 · summary](/guide/receive-modes#summary-summary-主动总结命令)。

## `receive.realtime` —— 亚秒级消息聚合

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用聚合窗口。关闭后，触发消息会立即单独 flush（`reason: "immediate"`），不再等待聚合。 |
| `windowMs` | `number` | `800` | 静默期：每条新消息都会重置这个计时器，静默期满即 flush。非负整数（允许 `0`），非法值回退默认值。注释里强调这个值应保持在 1000ms 以下才能算"realtime"。 |
| `maxWindowMs` | `number` | `3000` | 窗口最长可以被撑开多久（硬上限），不受静默期计时器无限拖延。正整数。 |
| `maxMessages` | `number` | `10` | 缓冲消息数达到此值立即 flush。 |
| `maxChars` | `number` | `8000` | 缓冲文本（各消息 `text` 字段长度之和）超过此值立即 flush。 |

窗口如何按 `${peerId}::${senderId}` 维度独立维护、为什么只有触发消息才能开窗，详见[接收模式 · realtime](/guide/receive-modes#realtime-亚秒级窗口聚合连发消息)。

## `receive.history` —— 回复时带入的历史聊天上下文 {#receive-history-回复时带入的历史聊天上下文}

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否累积近期消息，并在触发回复时作为历史上下文一并带入。这个队列与 `digest`（总结队列）**分开存储**，互不消费。 |
| `maxMessages` | `number` | `20` | 每个会话保留的历史消息条数上限（超出从最旧一端裁剪）。正整数。 |
| `maxChars` | `number` | `4000` | 每个会话保留、以及带入 Agent 正文时的历史文本字符上限。正整数。 |
| `maxAgeMs` | `number` | `0` | 带入那一刻按消息的 QQ 时间戳丢弃早于该时长（毫秒）的历史消息；`0` 表示不按时间丢弃（只受条数/字符数约束）。非负整数。 |

历史如何累积、带入 `body`（而非 `rawBody`/`commandBody`）、并在带入后立即清空（drain-on-consume），详见[接收模式 · history](/guide/receive-modes#history-回复时一并带入的历史聊天上下文)。

## `quote` —— 引用与合并转发解析 {#quote-引用与合并转发解析}

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否主动通过 `get_msg` 拉取被引用（回复）的消息。 |
| `resolveForward` | `boolean` | `true` | 是否通过 `get_forward_msg` 展开合并转发的内容。 |
| `maxDepth` | `number` | `2` | 合并转发可以嵌套展开多深（`0` 表示只展开顶层，不递归）。非负整数。 |
| `maxNodes` | `number` | `20` | 单次展开渲染的转发节点数上限（跨越整棵嵌套转发树共享这个预算，不是每层各 20 个）。正整数。 |
| `maxChars` | `number` | `4000` | 注入到 Agent 可见正文中的引用/转发文本字符上限，超出会被截断并标记 `truncated`。正整数。 |
| `timeoutMs` | `number` | `10000` | 每次 `get_msg` / `get_forward_msg` 调用的超时时间（毫秒）。 |

详细的解析算法、深度/节点/字符预算如何共同作用、环检测，见[引用与合并转发](/guide/quotes-and-forwards)。

## `reconnect` —— WebSocket 重连调优 {#reconnect-websocket-重连调优}

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用 `@snowluma/sdk` 内置的 WebSocket 自动重连。为 `false` 时，`buildWebSocketOptions` 会把 `reconnect` 整个设为 `false` 传给 SDK。 |
| `retries` | `number` | 省略 ⇒ 无限重连（`Number.POSITIVE_INFINITY`） | 最大重连次数。省略该字段（或显式 `null`）表示无限重连；**任何显式数字都会被原样采纳，包括 `0`**——`0` 意味着断线后不再重连。 |
| `minDelayMs` | `number` | `1000` | 重连尝试之间的最小延迟（毫秒）。正整数。 |
| `maxDelayMs` | `number` | `30000` | 重连尝试之间的最大延迟（毫秒）。正整数。 |

::: warning 重连次数用尽后不会自恢复
`retries` 是有限值时，SDK 用尽重连次数后会停在断开状态，网关不会自行恢复，需要重启 OpenClaw。除非你确实想要"失败即停"的语义，否则建议省略该字段。
:::

## `tools` —— Agent 工具注册

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否注册 `snowluma_get_history` / `snowluma_get_group_members` 两个 Agent 工具（见 [Agent 工具](/guide/tools)）。为 `false` 时 `snowLumaPlugin.agentTools` 返回空数组。 |

## 环境变量

只对 **`default` 账号**（`channels.snowluma` 顶层字段，不含 `accounts` 下的命名账号）生效，实现在 `src/env.ts`：

| 环境变量 | 对应字段 | 说明 |
|---|---|---|
| `SNOWLUMA_WS_URL` | `wsUrl` | 仅在 `wsUrl` 未显式配置时生效。 |
| `SNOWLUMA_HTTP_URL` | `httpUrl` | 仅在 `httpUrl` 未显式配置时生效。 |
| `SNOWLUMA_ACCESS_TOKEN` | `accessToken` | 优先于 `SNOWLUMA_TOKEN`；仅在 `accessToken` 未显式配置时生效。 |
| `SNOWLUMA_TOKEN` | `accessToken` | `SNOWLUMA_ACCESS_TOKEN` 未设置时的次选。 |
| `SNOWLUMA_SELF_ID` | `selfId` | 会被 `Number()` 转换，转换失败视为未设置。仅在 `selfId` 未显式配置时生效。 |

空字符串或纯空白的环境变量值会被视为未设置（`src/env.ts` 的 `readEnv` 会 `trim()` 并在结果为空时返回 `undefined`）。

## 多账号

`listSnowLumaAccountIds`（`src/config.ts`）的判定规则：

- `channels.snowluma` 顶层（不含 `accounts`）只要设置了 `wsUrl` 或 `httpUrl` 中任意一个，就会被识别为 id 为 `"default"` 的账号。
- `channels.snowluma.accounts` 下每个 key，只要对应的值设置了 `wsUrl` 或 `httpUrl`，就会被识别为一个独立账号，账号 id 就是那个 key。

命名账号的字段结构和顶层完全一致（`reconnect`/`receive`/`quote`/`tools` 都可以独立配置），但**不会**读取环境变量回退——环境变量回退只在 `resolveSnowLumaAccount` 判定"这是 `default` 账号"时才生效。

```json
{
  "channels": {
    "snowluma": {
      "enabled": true,
      "wsUrl": "ws://127.0.0.1:3001/",
      "accessToken": "token-for-default-account",

      "accounts": {
        "secondary": {
          "enabled": true,
          "wsUrl": "ws://127.0.0.1:3002/",
          "accessToken": "token-for-secondary-account",
          "allowFrom": ["*"],
          "receive": {
            "digest": { "enabled": true, "scope": "all" }
          }
        }
      }
    }
  }
}
```

Agent 工具（`snowluma_get_history` / `snowluma_get_group_members`）和 `react` 动作都接受可选的 `accountId` 参数来指定操作哪个账号，省略时使用 `"default"`。

## 完整示例

以下示例覆盖 `SnowLumaAccountConfig` 的每一个选项（`jsonc` 仅用于加注释，实际 `openclaw.json` 不支持注释，写入前请去掉 `//` 行）：

```jsonc
{
  "channels": {
    "snowluma": {
      "enabled": true,
      "name": "主账号",
      "wsUrl": "ws://127.0.0.1:3001/",
      "httpUrl": "http://127.0.0.1:3001",
      "accessToken": "your-snowluma-token",
      "selfId": 123456789,
      "allowFrom": ["private:10000001", "group:20000002"],
      "denyFrom": ["private:99999999"],
      "groupAutoReact": true,
      "groupAutoReactEmojiId": 76,
      "replyToTrigger": true,
      "textChunkLimit": 4500,
      "requestTimeoutMs": 30000,
      "debug": false,
      "reconnect": {
        "enabled": true,
        "retries": 20,
        "minDelayMs": 1000,
        "maxDelayMs": 30000
      },
      "receive": {
        "mention": {
          "enabled": true,
          "requireMentionInGroup": true,
          "keywords": ["机器人", "小助手"],
          "keywordMatch": "contains",
          "caseSensitive": false,
          "triggerOnReplyToSelf": true,
          "alwaysReplyInDirect": true
        },
        "digest": {
          "enabled": true,
          "intervalMs": 300000,
          "maxMessages": 50,
          "minMessages": 3,
          "prompt": "请用简洁的中文归纳这段时间的讨论主题、结论和待办事项，没有值得汇报的内容请只回复 SKIP。",
          "scope": "group",
          "peers": ["group:20000002"],
          "maxTranscriptChars": 20000
        },
        "realtime": {
          "enabled": true,
          "windowMs": 800,
          "maxWindowMs": 3000,
          "maxMessages": 10,
          "maxChars": 8000
        },
        "history": {
          "enabled": true,
          "maxMessages": 20,
          "maxChars": 4000,
          "maxAgeMs": 0
        }
      },
      "quote": {
        "enabled": true,
        "resolveForward": true,
        "maxDepth": 2,
        "maxNodes": 20,
        "maxChars": 4000,
        "timeoutMs": 10000
      },
      "tools": { "enabled": true },
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
