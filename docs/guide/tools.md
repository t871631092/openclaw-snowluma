# Agent 工具

插件通过 `channels.snowluma.tools.enabled`（默认 `true`）注册两个**只读** Agent 工具，定义在 `src/tools.ts`。两个工具有一个共同的设计原则：**永远不会抛出异常**——账号未配置、SnowLuma 调用失败、参数不合法，任何失败都会折叠成一个 `details.status === "failed"` 的正常返回值，而不是让 Agent 的工具调用中断报错。

两个工具都接受可选的 `accountId` 参数来指定操作哪个 SnowLuma 账号，省略时使用 `"default"` 账号（见[配置参考 · 多账号](/guide/configuration#多账号)）。工具执行时会优先复用网关已经建立的长连接（如果该账号的网关正在运行），否则临时开一个连接、用完即关（见 `src/client.ts` 的 `acquireActionClient`）。

## `snowluma_get_history`

获取指定 QQ 群聊或私聊的历史消息，按时间从旧到新排序渲染。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | `string` | 是 | 会话目标：`group:<群号>` / `private:<QQ号>`，裸数字视为私聊（复用 `parseTarget`，格式规则见[动作与消息目标](/guide/actions-and-targets)）。 |
| `count` | `number` | 否 | 返回的消息条数。**默认 `20`，夹取到 `[1, 100]` 区间**——传入超出该区间的数字会被夹到边界值，而不是报错；传入非数字/非有限数会直接回退为默认值 `20`。 |
| `messageSeq` | `number` | 否 | 分页锚点，对应 SnowLuma 的 `message_id`，从该消息向更早翻页。 |
| `accountId` | `string` | 否 | SnowLuma 账号 id，默认 `"default"`。 |

`target` 解析失败（既不是 `group:<数字>`/`private:<数字>`，也不是裸数字）会直接返回失败结果，不会发起任何 SnowLuma 调用。

### 底层调用

- `target.kind === "group"` ⇒ `client.getGroupMessageHistory({ group_id, count, message_id: messageSeq })`
- `target.kind === "private"` ⇒ `client.getFriendMessageHistory({ user_id, count, message_id: messageSeq })`

拿到的消息数组会按 `time` 字段**重新排序为升序**（不依赖 SnowLuma 返回的原始顺序），再逐条渲染成一行。

### 输出格式

每条消息渲染为：

```text
[HH:mm:ss] 昵称(QQ号): 消息文本
```

昵称优先取 `sender.card`（群名片），其次 `sender.nickname`；文本部分复用 `renderSegments`——图片渲染为 `[图片]`，语音为 `[语音]`，合并转发为 `[合并转发]` 等占位符（与入站消息的渲染规则完全一致，见 `src/segments.ts` 的 `PLACEHOLDERS`）。没有任何历史消息时，文本是 `（无历史消息）`。

### 示例调用

```json
{ "target": "group:20000002", "count": 30 }
```

### 示例渲染输出

```text
[09:58:12] 张三(10001): 大家好
[09:58:40] 李四(10002): 早上好[图片]
[10:00:05] 王五(10003): 昨天开会的记录发一下 [合并转发]
```

对应的 `details` 字段（供 Agent/上游程序做结构化消费，不是渲染给用户看的文本）：

```json
{
  "status": "ok",
  "target": "snowluma:group:20000002",
  "count": 3,
  "messages": [ /* 排序后的原始消息对象数组 */ ]
}
```

失败时返回（例如账号未配置 `wsUrl`/`httpUrl`）：

```json
{ "status": "failed", "error": "SnowLuma 账号「default」未配置 wsUrl/httpUrl，无法执行该操作。" }
```

## `snowluma_get_group_members`

获取指定 QQ 群的成员列表。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `groupId` | `number \| string` | 是 | 群号；字符串会被 `Number()` 转换，转换失败（非数字字符串）直接返回失败结果。 |
| `noCache` | `boolean` | 否 | 跳过缓存，强制向 SnowLuma 请求最新数据；非布尔值一律视为未设置（透传 `undefined`）。 |
| `limit` | `number` | 否 | 返回的最大成员数。**默认 `100`，夹取到 `[1, 500]` 区间**，规则同 `count`。 |
| `accountId` | `string` | 否 | SnowLuma 账号 id，默认 `"default"`。 |

### 底层调用

`client.getGroupMemberList(groupId, { noCache })`。

### 输出格式

每个成员渲染为：

```text
昵称/群名片(QQ号) — role
```

名字优先取 `card`（群名片），其次 `nickname`，都没有则显示 `?`；`role` 直接原样输出 SnowLuma 返回的角色字符串（`owner` / `admin` / `member` 等），缺失时回退为 `member`。当群成员数量超过 `limit`，会在渲染文本末尾追加一行截断提示；`details.total`/`details.shown` 分别是群实际成员总数和本次实际返回的条数，供 Agent 判断是否需要提高 `limit` 或翻页。没有成员信息时，文本是 `（该群暂无成员信息）`。

### 示例调用

```json
{ "groupId": 20000002, "noCache": true, "limit": 50 }
```

### 示例渲染输出

```text
群主张三(10001) — owner
管理员李四(10002) — admin
王五(10003) — member
```

如果这个群实际有 120 名成员而 `limit` 是 50，输出末尾会追加：

```text
（仅显示前 50 / 共 120 名成员）
```

对应的 `details` 字段：

```json
{
  "status": "ok",
  "groupId": 20000002,
  "total": 120,
  "shown": 50,
  "members": [ /* 本次实际返回的成员对象数组 */ ]
}
```

## 失败模式一览

两个工具的失败结果结构完全一致：`{ content: [{ type: "text", text }], details: { status: "failed", error } }`，`text` 与 `details.error` 内容相同。常见失败原因：

| 场景 | 触发条件 |
|---|---|
| 账号未配置 | 指定的 `accountId` 对应账号既没有 `wsUrl` 也没有 `httpUrl` |
| 参数不合法 | `target` 无法解析成 `group:<数字>`/`private:<数字>`；`groupId` 无法转换成有限数字 |
| SnowLuma 调用失败 | 连接失败、鉴权失败、请求超时（`requestTimeoutMs`）等，错误信息来自底层异常的 `.message` |
