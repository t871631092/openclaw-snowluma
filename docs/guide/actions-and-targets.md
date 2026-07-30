# 动作与消息目标

## 消息目标格式

发送、Agent 工具调用里用到的目标字符串，统一由 `parseTarget()`（`src/outbound.ts`）解析，支持四种写法：

| 写法 | 示例 | 解析结果 |
|---|---|---|
| 带通道前缀 | `snowluma:group:20000002` | `{ kind: "group", id: 20000002 }` |
| 带通道前缀（私聊） | `snowluma:private:10000001` | `{ kind: "private", id: 10000001 }` |
| 不带通道前缀 | `group:20000002` / `private:10000001` | 同上，通道前缀是可选的 |
| 裸数字 | `10000001` | `{ kind: "private", id: 10000001 }` —— **省略 kind 一律视为私聊**，包括带了 `snowluma:` 前缀但去掉前缀后只剩一个裸数字的情形（如 `snowluma:10000001`） |

解析规则细节：

- 先按 `snowluma:` 前缀（大小写不敏感）去掉通道标识，再按 `:` 切分剩余部分。
- 切分后剩 1 段 ⇒ 私聊，该段就是 QQ 号。
- 切分后剩 2 段 ⇒ 第一段必须是字面量 `"group"` 或 `"private"`，否则直接抛错（不会静默退化）。
- 切分后剩 3 段或更多 ⇒ 抛错。
- id 部分必须是纯数字字符串（`/^\d+$/`），否则抛错——非数字 id、空字符串、带符号的数字都不合法。

`formatTarget()` 是反方向操作，把 `{kind, id}` 格式化回带前缀的规范形式 `snowluma:<kind>:<id>`，`snowluma_get_history` 工具的 `details.target` 字段用的就是这个格式。

插件在 `messaging.targetResolver` 里把 `parseTarget` 包成 `looksLikeId`（解析不抛错就认为"像"一个合法目标）暴露给宿主，`hint` 字段直接告诉用户格式规则：`group:<群号> / private:<QQ号>，裸数字视为私聊`。

## `outbound.sendText`：文本发送与分块

### 分块规则（`chunkText`）

出站文本会先按账号的 `textChunkLimit`（默认 `4500` 字符，见[配置参考](/guide/configuration#顶层账号选项)）切分成多条消息再依次发送，切分算法（`src/outbound.ts` 的 `chunkText`）遵循两条优先级：

1. **优先在换行符后切分**——在不超过 `limit` 字符的范围内，如果能找到一个换行符，就在那里切断，这样每条消息尽量是完整的自然段而不是从句子中间断开。
2. **绝不在 `[CQ:...]` 编码内部切断**，哪怕这意味着某一块的长度会超过 `limit`。一个 CQ 码（例如图片、表情的内联编码）代表一个不可分割的整体，把它从中间切开会产生两段都无法解析的垃圾数据，所以算法宁可让这一块变长，也要等到这个 CQ 码结束之后再切。

如果一整块 `limit` 范围内既没有安全的换行符、也没有任何安全的切分点（因为从头到尾都陷在一个 CQ 码里面），就会一路扩展到这个 CQ 码结束为止，作为唯一的切分点。

空字符串或纯空白文本会被切分成**空数组**——`sendText` 对这种输入不会发出任何消息。

### @提及：从文本到真正的 at 段

出站文本里的 `[CQ:at,qq=<QQ号>]` 会在发送时被转换成 SnowLuma SDK 的真正 `at` 消息段（`chain().at(qq)`），QQ 客户端里渲染成蓝色的、会触发提醒的真实 @，而不是一段普通文字。规则：

- **只转换纯数字 QQ 号**。`qq=all`（@全体成员）**故意不转换**，保持字面文本原样发出——出站文本可能原样转述群里的聊天内容，群成员在消息里打一句 `[CQ:at,qq=all]` 绝不能借机器人之口变成一次真实的全体提醒。
- qq 之后的额外参数（如 `,name=张三`）容忍并忽略——群内成员的显示名由 QQ 客户端自己解析。
- `sendText` 的 `convertAtCodes` 参数（默认 `true`）控制这层转换。`dispatch.ts` 对 **digest / summary 回复和错误通知固定传 `false`**：总结类回复会原样引用聊天转写，其中被转述的 CQ 码必须保持字面。
- 分块算法本来就不会从 CQ 码中间切断（见上文），所以每个 at 码到达转换点时一定是完整的。

在此之上，realtime **群聊**回复还会先经过一步纯文本改写（`rewriteNameMentions`，`src/outbound.ts`）：Agent 在回复里写的 `@昵称` / `@QQ号`，如果指向**本批次的参与者**（当前消息 + 回复历史缓冲里的发送者，即 Agent 在提示词里实际见过的人），就被改写成对应的 `[CQ:at,qq=N]` 码，再由上面的转换变成真实 @。改写是保守的：

- 只认识本批次参与者的净化显示名和裸 QQ 号，其他任何 `@...` 保持原样——Agent 只能 @ 它真的见过的人；
- `@` 前一个字符是邮箱风格字符（字母/数字/`._%+-`）时不改写（`foo@qq.com` 不动），中文等 CJK 字符紧贴 `@` 则正常改写（`辛苦了@张三`）；
- 名字后紧跟字母/数字/CJK 时不做部分匹配（只认识 `张三` 时 `@张三丰` 原样保留），多个候选取最长者；
- 已有 `[CQ:...]` 码内部的 `@` 永不改写；
- 私聊回复、digest / summary 回复完全跳过这步改写。

### 引用回复只挂在第一块上

调用 `sendText({ client, to, text, replyToId, chunkLimit })` 时，如果给了 `replyToId`，**只有分块后的第一条消息**会带上 SnowLuma SDK 的 `reply(replyToId)` 段（渲染成 QQ 客户端里的"引用回复"效果）；后续分块都是普通 `text()` 消息，不会重复引用同一条触发消息——避免用户在长回复里被同一条引用刷屏好几次。

### 网关自动引用触发消息

`dispatch.ts` 里，机器人回复是否自动带上"引用触发这次对话的那条消息"由账号级 `replyToTrigger`（默认 `true`）控制，并且只对 **realtime 批次**生效：

```text
replyToId = (batch.kind === "realtime" && account.replyToTrigger) ? first.messageId : undefined
```

注意这里引用的是这一批次里**第一条**消息（打开这个聚合窗口的那条），不是最后一条——即使窗口里后续又并入了好几条消息，QQ 客户端里看到的引用箭头始终指向最初触发对话的那句话。digest 批次没有单条"触发消息"的概念，永远不会带引用。

### 返回哪个 `messageId`

插件通道层的 `outbound.sendText`（`src/channel.ts`）在分块发送完成后，取**最后一块**的 `messageId` 作为整次调用的返回值（`result.messageIds[result.messageIds.length - 1]`）——如果宿主后续要基于这个 id 做进一步操作（比如再引用一次），引用到的是发出去的最后一段。

## `outbound.sendMedia`：媒体类型路由

`sendMedia({ client, to, mediaPath, caption })` 根据 `mediaPath` 的文件扩展名决定怎么发送，因为 OneBot 协议本身没有"内联发送任意文件"这种通用消息段：

| 扩展名 | 处理方式 | SnowLuma action |
|---|---|---|
| `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.heic` `.heif` | 图片消息段 | `image(fileRef)` |
| `.mp3` `.ogg` `.wav` `.m4a` `.aac` `.flac` `.amr` `.silk` `.opus` | 语音消息段 | `record(fileRef)` |
| 其他任意扩展名（含无扩展名） | 群/私聊文件上传，**不是**内联消息 | 群聊 `raw("upload_group_file", { group_id, file })`；私聊 `raw("upload_private_file", { user_id, file })` |

扩展名判定只看路径中最后一个 `.` 与最后一个路径分隔符（`/` 或 `\`）的相对位置，且会先去掉查询串/哈希片段（`?`、`#`）再判断，全部转小写后匹配上表。

### 本地路径与 URL

`mediaPath` 在发送前会经过 `toFileUri()` 归一化：`http(s)://` 和 `file://` 开头的字符串原样透传；操作系统绝对路径（`isAbsolute()` 判定）会被转换成 `file://` URI；其余情况（相对路径等）原样透传给 SDK，不做进一步处理。

### `caption` 作为独立消息发送

如果传了非空白的 `caption`，它**不会**附着在媒体消息本身上，而是在媒体发送成功后，作为一条**独立的文本消息**（走 `sendText`，不带 `replyToId`）紧跟着发出去。

### 返回哪个 `messageId`

和 `sendText` 相反，插件通道层的 `outbound.sendMedia` 取的是 `result.messageIds[0]`——也就是**媒体本身**那条消息的 id，即使后面还发了一条独立的 `caption` 文本消息。

## `react` 动作

插件实现了 OpenClaw 的 `react` 通道动作（`src/channel.ts` 的 `actions.handleAction`），底层就是 SnowLuma 的 `set_msg_emoji_like`，通过 `reactToMessage(client, messageId, emojiId)`（`src/outbound.ts`）执行，本质是对 `client.setMsgEmojiLike(Number(messageId), String(emojiId))` 的一层不抛异常包装。

### 参数别名

`handleAction` 从 `params` 里按顺序尝试多个字段名，兼容不同调用方的命名习惯：

- 消息 id：`params.message_id` → `params.messageId` → `params.message` → `toolContext?.currentMessageId`（省略参数时，退回"当前正在处理的这条消息"）
- 表情 id：`params.emoji_id` → `params.emojiId` → `params.emoji` → `params.reaction`

两者任一缺失（或表情 id 是空字符串/纯空白）都会返回错误结果，不会尝试调用 SnowLuma：

```text
SnowLuma react requires `emoji` and `message_id` (or current message context).
```

`describeMessageTool` 只有在账号 `enabled` 且配置了 `wsUrl` 时才会把 `react` 暴露给宿主的消息动作列表（`SNOWLUMA_MESSAGE_ACTIONS = ["react"]`，目前是唯一支持的动作），账号未就绪时宿主根本看不到这个动作可用。

### 与 `groupAutoReact` 的关系

`react` 动作是**按需**的——Agent 或工具主动调用，指定某条具体消息加某个表情。这和账号级配置 `groupAutoReact`（默认 `false`）是两回事：`groupAutoReact: true` 时，**每一条触发了 Agent 的群消息**都会被网关自动加上 `groupAutoReactEmojiId`（默认 `1`）指定的表情，作为"已收到、正在处理"的即时反馈，完全不经过 Agent 决策：

```json
{
  "groupAutoReact": true,
  "groupAutoReactEmojiId": 76
}
```

两条路径——手动 `react` 动作、自动 `groupAutoReact`——共享同一个 `reactToMessage` / `set_msg_emoji_like` 调用路径，行为完全一致（同样不抛异常，失败只是记日志），只是触发方式不同：一个是入站侧的自动确认，一个是出站侧/工具侧的按需调用。
