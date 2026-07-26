# 接收模式

这是本插件最核心、也最容易被误解的部分。接收模式定义在 `channels.snowluma.receive` 下（`src/triggers.ts` + `src/aggregator.ts`），**默认开关状态各不相同**，并且**可以同时组合使用**——同一条消息可以既被 realtime 聚合引擎处理、又被 digest 摘要引擎累积、还被 history 回复历史缓冲区记录，三者互不影响、各自维护独立的缓冲区。

| 模式 | 默认状态 | 触发对象 | 一句话 |
|---|---|---|---|
| `mention` | 启用 | 单条消息的**判定逻辑** | 决定"要不要理这条消息" |
| `realtime` | 启用 | 被 `mention` 判定为触发的消息 | 把连发的几条消息合并成一次 Agent 调用 |
| `digest` | **关闭** | 范围内的**所有**消息，无关触发与否 | 定时/达量吐出一份聊天摘要 |
| `summary` | 启用 | 只有 `/summary` 命令那一条消息 | 有人喊一声，就现拉最近 100 条记录做一份总结 |
| `history` | 启用 | **所有**消息，无关触发与否 | 攒下近期聊天，触发回复时作为历史上下文一并带入，然后清空 |

> **`summary` 是唯一一个"截流"的模式。** 其余模式都只是观察同一条消息流；`/summary` 命令消息一旦匹配就在流程最前面被截下（见下方流程图），不再进入任何一个缓冲引擎。它的素材也不来自这些缓冲区，而是现场向 SnowLuma 拉取的历史记录。

> **`digest`（总结队列）与 `history`（回复队列）是两套分开存储的缓冲区。** `digest` 是"定时吐一份摘要"，按 `intervalMs`/`maxMessages` 到点或达量后 flush；`history` 是"回复时补一段上下文"，平时只累积、不发送，直到某条消息触发回复才把攒下的历史一次性塞进那次 Agent 调用并清空。两者各自独立累积同一批消息，互不消费对方的缓冲区。

理解这张表最重要的一点：**`mention` 不是一个独立的"模式"，而是贯穿整个入站流程的判定函数**——`evaluateTrigger()` 对每一条入站消息都会跑一次，它的结果（`TriggerDecision`）同时喂给 `realtime` 引擎（决定要不要开窗/是否立即单独 flush）和被 `digest` 引擎忽略（`digest` 完全不看这个判定结果）。

## 入站决策流程

```text
SnowLuma 事件（onMessage）
        │
        ▼
normalizeMessageEvent()  ── 归一化为 NormalizedMessage
        │
        ▼
senderId === selfId ？ ──是──▶ 丢弃（永远不处理自己发的消息）
        │否
        ▼
isPeerAllowed(allowFrom/denyFrom) ？ ──否──▶ 丢弃
        │是
        ▼
matchSummaryCommand(msg, account) ？ ──是──▶ 拉取最近 count 条历史 ⇒ dispatchBatch(kind:"summary")
        │否                                  （命令消息到此为止，不进下面任何一个引擎）
        ▼
evaluateTrigger(msg, account)  ── mention 模式的判定逻辑，产出 TriggerDecision
  { triggered: bool, reason?, keyword? }
        │
        ▼
aggregator.accept(msg, decision)  ── 同一条消息，同时喂给下面两个独立引擎
        │
        ├──────────────────────────────┬───────────────────────────────┐
        ▼                               ▼
  realtime 引擎（按 peerId::senderId 开窗）   digest 引擎（按 peerId 开窗，忽略 decision）
  · 未开窗 + decision.triggered=false      · 消息在 scope/peers 范围内 ？
    ⇒ 直接丢弃（不缓冲）                        │否 ⇒ 忽略
  · 未开窗 + decision.triggered=true           │是
    ⇒ 开新窗，记录 decision 作为该窗口的 trigger  ▼
  · 已开窗（无论 decision 如何）              加入缓冲区，按 maxTranscriptChars 裁剪
    ⇒ 加入缓冲区，重置静默计时器                  │
        │                               达到 maxMessages？──是──▶ flush("max-messages")
  达到 maxMessages/maxChars？──是──▶ flush        │否
        │否                               intervalMs 到期？──是──┐
  静默 windowMs 到期？──是──▶ flush("quiet")         │否        │
        │否                                    等待下条消息     │
  maxWindowMs 硬上限到期？──是──▶ flush("max-window")            ▼
        │否                                          messages.length >= minMessages？
  等待下一条消息 / 定时器                                   │否 ⇒ 不 flush，重置计时器继续攒
                                                          │是 ⇒ flush("interval")
        │                                                    │
        ▼                                                    ▼
  dispatchBatch(batch)  ── 组装 Agent 上下文、调用 Agent、把回复发回 QQ
```

`realtime.enabled: false` 时，上图中"realtime 引擎"整条路径被跳过：`decision.triggered = true` 的消息会立即单独 flush（`reason: "immediate"`），不再等待聚合；`decision.triggered = false` 的消息则直接被忽略，连临时状态都不会保留。

## `mention`：被 @ 或关键词命中时立即触发 {#mention-被-或关键词命中时立即触发}

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

### 判定顺序（`evaluateTrigger`，`src/triggers.ts`）

规则按顺序求值，**第一条命中的规则获胜**：

1. `mention.enabled === false` ⇒ **绝对覆盖**，函数直接返回不触发，后面所有规则都不会再看——即使消息是私聊、即使命中关键词。
2. 私聊消息 + `alwaysReplyInDirect: true`（默认）⇒ 触发，`reason: "direct"`。
3. 群聊消息里 `mentions` 数组包含 `String(selfId)` ⇒ 触发，`reason: "mention"`。**前提是 `selfId` 必须已知**（显式配置或 `get_login_info` 探测成功）——`selfId` 为 `undefined` 时这条规则永远不会命中，即使消息确实 `@` 了机器人。
4. 群聊消息回复了机器人自己发过的消息，且 `triggerOnReplyToSelf: true`（默认）⇒ 触发，`reason: "reply-to-self"`。
5. 消息文本命中 `keywords`（按 `keywordMatch`/`caseSensitive` 规则）⇒ 触发，`reason: "keyword"`。**这一条不区分群聊/私聊**——`alwaysReplyInDirect: false` 时，私聊消息依然可以靠关键词触发。
6. 群聊场景收尾：
   - `requireMentionInGroup: true`（默认）且以上都未命中 ⇒ 不触发。
   - `requireMentionInGroup: false` 且未配置任何关键词（`keywords.length === 0`）⇒ **任何群消息都触发**，且这次的 `TriggerDecision` **没有 `reason` 字段**（`{ triggered: true }`，不同于其他触发路径）。
   - `requireMentionInGroup: false` 但配置了关键词 ⇒ 不触发（关键词已经在第 5 步检查过、没命中）。
7. 私聊场景收尾：`alwaysReplyInDirect: false` 且没有命中关键词 ⇒ 不触发。

### 三个容易踩坑的细节

- **`@全体成员` 永远不算命中**。`extractMentions()`（`src/segments.ts`）把 `@全体成员` 解析成独立的 `atAll: true` 标记，和具体的 `mentions: string[]` 数组分开。`evaluateTrigger` 的第 3 条规则只检查 `mentions.includes(String(selfId))`，**从不读取 `atAll`**——`src/triggers.ts` 的注释原话："`@全体成员` 不是对机器人本身的提及，而且没有已知 `selfId` 就无法做提及判定（我们不会去猜"机器人"是谁）"。换句话说，哪怕群里 `@全体成员`，也绝不会被当成 `@` 了机器人。
- **`selfId` 是提及检测的硬前提**。如果既没有显式配置 `selfId`，网关启动时 `get_login_info` 自动探测又失败了，`account.selfId` 就是 `undefined`，规则 3 永远不成立——群里怎么 `@` 都不会触发 `reason: "mention"`（其他规则如私聊直答、关键词依然正常工作，不受影响）。
- **前导 `@bot` 会被剥离，不会出现在 Agent 看到的正文里**。`stripLeadingMention()`（`src/triggers.ts`）在组装 Agent 可见正文前，把消息开头的 `@名字` 或原始 `[CQ:at,qq=...]` 片段（连同后面的空白）剥掉，让 Agent 看到的是"帮我查天气"而不是"@机器人 帮我查天气"。这一步只处理**开头**的一个 mention token，且只对整个聚合批次的第一条消息生效一次（因为"@机器人"逻辑上只能出现在打开这轮对话的那句话开头）。

### 时间线示例

场景：群 `20000002`，`selfId = 123456789`，`keywords: ["天气"]`，其余用默认值。

| 时刻 | 事件 | `evaluateTrigger` 结果 |
|---|---|---|
| `10:00:00` | 用户 A 发送 "今天天气怎么样"（未 @） | `{ triggered: true, reason: "keyword", keyword: "天气" }` —— 命中关键词，不需要 @ |
| `10:00:05` | 用户 B 发送 "在吗"（未 @，未命中关键词） | `{ triggered: false }` —— `requireMentionInGroup: true` 且以上规则都未命中 |
| `10:00:10` | 用户 C 发送 "@机器人 帮我算一下 1+1"（`mentions: ["123456789"]`） | `{ triggered: true, reason: "mention" }` |
| `10:00:15` | 用户 D 回复机器人刚才的回答，内容是"谢谢"（`replyToId` 指向机器人消息） | `{ triggered: true, reason: "reply-to-self" }`（前提 `triggerOnReplyToSelf: true`） |
| `10:00:20` | 用户 E 发送 "@全体成员 大家注意一下"（`atAll: true`，`mentions: []`） | `{ triggered: false }` —— `atAll` 不参与判定，且未命中关键词 |

## `digest`：定时或达到消息数后自动归纳 {#digest-定时或达到消息数后自动归纳}

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

`digest` 默认**关闭**（`enabled: false`），是三种模式里唯一默认关闭的一种。开启后，插件会持续缓冲 `scope`（`group` / `direct` / `all`）范围内、且在 `peers` 白名单内（为空表示不限制）的**每一条**消息——无论这条消息是否命中 `mention` 的触发条件，`acceptDigest()` 完全不看 `TriggerDecision`。缓冲窗口按 `peerId` 独立维护（`src/aggregator.ts` 的 `digestWindows` 以 `peerId` 为 key，不区分发送者）。

### flush 条件与 `minMessages` 抑制-重试语义

窗口满足以下**任一**条件即尝试 flush：

- 缓冲消息数达到 `maxMessages` ⇒ 立即 flush，`reason: "max-messages"`（这条路径**不检查 `minMessages`**——"够多了"本身就是理由）。
- 自窗口打开起过去了 `intervalMs` 毫秒 ⇒ 计时器触发，但这里有一道额外的门槛：**如果此时缓冲的消息数少于 `minMessages`，flush 会被抑制**——窗口不清空，什么也不发送，计时器简单地重新排一次（`scheduleDigestTimer` 递归调用自己），继续等下一个 `intervalMs` 周期，如此反复直到缓冲区攒够 `minMessages` 条消息为止。

也就是说 `minMessages` 只作用于"到点了"这条路径，从不作用于"攒够 `maxMessages` 条"这条路径。`minMessages` 在解析阶段会被夹到不超过 `maxMessages`（见[配置参考](/guide/configuration#receive-digest-定时达量摘要)），避免配置出一个永远无法满足、因而永远无法 flush 的窗口。

### flush 时发生什么

flush 时，`buildDigestBody()`（`src/dispatch.ts`）把 `prompt` 和渲染成 `[HH:mm:ss] 昵称(qq): 文本` 逐行格式的聊天记录拼在一起（进一步按 `maxTranscriptChars` 从最旧的一端裁剪），作为一次性的 Agent 调用发出去。如果 Agent 的最终回复裁剪首尾空白后**恰好等于 `SKIP`**（大小写不敏感），插件不会发送任何消息——这是"这段时间没什么好总结的"的正常路径，不是错误。

**摘要轮次永远不会被授权执行文本命令**（`/status`、`/model` 等）：`dispatchBatch` 里 `batch.kind === "digest"` 时 `CommandAuthorized` 被硬编码为 `false`，`CommandSource` 字段整个被省略（而不是设为 `false`），`CommandBody`/`RawBody` 也都是空字符串——即使触发这条消息的 peer 已经在 `allowFrom` 白名单里，摘要文本本身也不会被当作命令解析，防止群聊消息通过摘要转发实现指令注入。

### 时间线示例

场景：`intervalMs: 60000`（1 分钟，为便于举例缩短）、`maxMessages: 50`、`minMessages: 3`、`scope: "group"`。

| 时刻 | 事件 | 窗口状态 |
|---|---|---|
| `10:00:00` | 群里第一条消息到达 | 开窗，`messages.length = 1`，排一个 60s 后触发的计时器 |
| `10:00:20` | 第二条消息到达 | `messages.length = 2`（不影响已排的计时器） |
| `10:01:00` | 计时器触发 | `messages.length = 2 < minMessages(3)` ⇒ **抑制 flush**，重排下一个 60s 计时器 |
| `10:01:30` | 第三条消息到达 | `messages.length = 3` |
| `10:02:00` | 计时器再次触发 | `messages.length = 3 >= minMessages(3)` ⇒ flush，`reason: "interval"` |

## `summary`：`/summary` 主动总结命令 {#summary-summary-主动总结命令}

```json
{
  "receive": {
    "summary": {
      "enabled": true,
      "commands": ["/summary", "/总结"],
      "count": 100,
      "maxCount": 200,
      "scope": "all",
      "peers": [],
      "maxTranscriptChars": 20000
    }
  }
}
```

`digest` 是"到点了自动吐一份"，`summary` 是"有人要才做一份"。默认**启用**：群里或私聊里任何人发一句 `/summary`（或 `/总结`），插件就会**现场向 SnowLuma 拉取该会话最近 100 条消息**（`get_group_msg_history` / `get_friend_msg_history`）并总结。

这意味着它**不依赖 `digest`**：`digest.enabled: false` 时 `/summary` 照样能用，机器人刚进群、之前一条消息都没观察到时也能用——总结的素材来自 QQ 的历史记录接口，不是插件自己的缓冲区。

### 命令的写法

| 用户输入 | 效果 |
|---|---|
| `/summary` | 总结最近 `count`（默认 100）条 |
| `/summary 30` | 总结最近 30 条（超过 `maxCount` 会被夹住） |
| `/总结50` | 同上——CJK 命令词后面不需要空格 |
| `@机器人 /summary` | 前导 `@机器人` 会先被剥掉再匹配 |
| `/SUMMARY` | 命令词匹配大小写不敏感 |
| `/summary 最近聊了什么` | 参数不是数字就忽略，按默认条数总结 |
| `/summarylater` | **不匹配**——命令词后面必须是消息结尾、空白或数字 |
| `帮我 /summary 一下` | **不匹配**——命令词必须在开头 |

### 命令消息会绕开整条常规管线

匹配成功的那条命令消息**不会**进入 `aggregator.accept()`：它不开 realtime 窗口、不进 digest 缓冲区、也不留在 history 回复历史里。命令本身是给机器人的指令，不是聊天内容，所以它既不该触发一次普通回复，也不该出现在下一次摘要的聊天记录里。正在进行中的 realtime 窗口和 digest 窗口完全不受影响。

命令那条消息也会被从拉回来的历史记录里剔除（按 `messageId` 比对），所以总结里不会出现一行 `/summary`。为此插件实际请求的是 `count + 1` 条，保证剔除后仍有 `count` 条正文。

`groupAutoReact` 开启时，命令消息同样会被贴表情——相当于一个"收到，正在总结"的回执。

### 下发与回复

组装方式和 digest 完全一致：`prompt` + `[HH:mm:ss] 昵称(qq): 文本` 的逐行记录，按 `maxTranscriptChars` 从最旧一端裁剪。三点不同：

- **用的是 `summary.prompt`**，默认那段提示词里不含 SKIP 出口——用户主动要的总结，静默不回等于命令没反应。相应地，`SKIP` 静默逻辑只对 `digest` 批次生效，`summary` 批次即使回复 `SKIP` 也会照发。
- **归属到发命令的人**：`SenderId`/`SenderName`/`MessageSid` 取命令那条消息，`replyToTrigger: true` 时回复以引用命令消息的形式发出。
- **拉不到内容时会明说**：历史接口报错回 `获取最近聊天记录失败：<原因>`，一条都没有回 `最近没有可以总结的聊天记录。`——两种情况都不会调用 Agent。

### 回复默认是一张图片

digest 和 `/summary` 的回复通常是带标题、分点、代码块的长 Markdown，塞进 QQ 文本气泡会被压成一坨。所以这两类回复默认**渲染成 PNG 发送**（`render.enabled: true`，见[配置参考 · render](/guide/configuration#render-把总结渲染成图片)）：

- 渲染链路 `marked` → `satori` → `@resvg/resvg-wasm`，纯 JS/WASM，不需要浏览器、不需要原生二进制。
- 图片仍然以引用回复的形式挂在 `/summary` 命令那条消息上（`replyToTrigger: true` 时）。
- **任何一步失败都自动回退纯文本**：包没装、找不到中文字体、渲染或发送报错、内容超过 `maxChars`——都只是退回文本，不会让总结丢失。
- 普通对话回复（realtime）永远是纯文本，不受这个开关影响。

**总结轮次同样永远不会被授权执行文本命令**：`dispatchBatch` 里凡是 `batch.kind !== "realtime"` 的批次，`CommandAuthorized` 都硬编码为 `false`、`CommandSource` 整个省略、`CommandBody`/`RawBody` 都是空字符串。用户授权的是"做一份总结"，不是"执行聊天记录里碰巧长得像命令的那一行"。

## `realtime`：亚秒级窗口聚合连发消息 {#realtime-亚秒级窗口聚合连发消息}

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

这是"连续打好几行字"的场景——用户短时间内发了三条消息，插件应该合并成一次 Agent 调用，回复一次而不是三次。

### 窗口的 key 与开窗条件

窗口按 **`${peerId}::${senderId}`** 维度独立维护（`src/aggregator.ts` 的 `realtimeKey()`）——同一个群里，A 和 B 各自连发消息会开两个独立的窗口，互不干扰；同一个人在群聊和私聊里发消息也会落在两个不同的 key 上。

**只有一条 `TriggerDecision.triggered === true` 的消息才能打开新窗口**。窗口一旦打开（不论开窗原因是 `mention`、`keyword`、`direct` 还是别的 `reason`），同一 key 上后续到达的消息——**无论这些后续消息自己有没有命中触发条件**——都会被并入这个已经打开的窗口，直到窗口 flush。这就是为什么在群里 `@` 了机器人之后，紧接着补发的几句没有再 `@` 的话也会被算进同一次 Agent 调用。

### flush 条件

满足以下**任一**条件即 flush：

- 静默期：自上一条消息起过去了 `windowMs` 毫秒（**每条新消息都会重置这个计时器**）⇒ `reason: "quiet"`。
- 硬上限：自窗口**打开**起过去了 `maxWindowMs` 毫秒（这个计时器只在开窗时排一次，**不会**被静默期计时器无限拖延，也不会因新消息而重置）⇒ `reason: "max-window"`。
- 缓冲消息数达到 `maxMessages` ⇒ `reason: "max-messages"`。
- 缓冲文本总长度（各消息 `text` 字段长度之和）超过 `maxChars` ⇒ `reason: "max-chars"`。

后两条容量检查在**每次**有新消息加入窗口（包括刚开窗那一刻）后立即执行，一旦命中就立刻 flush，不会走到静默计时器那一步。

### `realtime.enabled: false` 时的行为

不维护任何窗口状态：命中触发条件的消息会立即单独 flush（`messages` 数组只有它自己一条，`reason: "immediate"`）；未命中触发条件的消息则被直接丢弃，连临时缓冲都不会有。

### 空内容触发不会把英文报错发回群里

当一次触发实际上"没有可处理的内容"时（例如只 `@` 了机器人、剥离提及后什么都不剩，或回复机器人消息但正文为空、只发了个表情等），OpenClaw 运行时会判定为"空消息"，返回一句固定的英文 `I didn't receive any text in your message. Please resend or add a caption.`。插件用两道防线避免它出现在群里：

1. **入站侧跳过**：realtime 批次组装完后如果**正文为空**且没有引用、历史、图片，`dispatchBatch` 直接跳过这次 Agent 调用、什么都不发送。
2. **出站侧拦截**：OpenClaw 是在**它自己剥离 `@机器人` 提及之后**才判定空消息的，所以有些输入（如裸 `@机器人`、表情）在插件这边看正文并不为空、入站侧拦不住——因此 `deliver` 再加一道兜底：只要 Agent 回复里包含这句英文提示，就丢弃、不发回 QQ。

两道合起来保证这句无意义的英文报错永远不会出现在聊天里；只要消息带了任何真实文字、引用、历史或图片，就照常处理和回复。

### 时间线示例

场景：`windowMs: 800`、`maxWindowMs: 3000`、群聊，用户 A 在 `10:00:00.000` 时 `@` 了机器人问了个问题，然后连续补充了两句。

| 相对时刻 | 事件 | 窗口动作 |
|---|---|---|
| `+0ms` | "@机器人 帮我查一下明天的天气" — `reason: "mention"` | 开新窗，`messages = [msg1]`，排 800ms 静默计时器 + 3000ms 硬上限计时器 |
| `+300ms` | "北京的" — 未再 @，但窗口已开 | 并入窗口，`messages = [msg1, msg2]`，静默计时器重置为 800ms 后 |
| `+700ms` | "还有明天要不要带伞" | 并入窗口，`messages = [msg1, msg2, msg3]`，静默计时器再次重置 |
| `+1500ms` | 无新消息，静默计时器到期（`700 + 800 = 1500`） | flush，`reason: "quiet"`，三条消息合并为一次 Agent 调用 |

对比：如果用户在窗口打开后持续每 500ms 补发一句，静默计时器永远不会自然到期，此时 `maxWindowMs: 3000` 会在 `+3000ms` 强制 flush，`reason: "max-window"`，防止一个说个不停的用户把窗口无限撑开。

## `history`：回复时一并带入的历史聊天上下文 {#history-回复时一并带入的历史聊天上下文}

```json
{
  "receive": {
    "history": {
      "enabled": true,
      "maxMessages": 20,
      "maxChars": 4000,
      "maxAgeMs": 0
    }
  }
}
```

`history` 默认**启用**。它解决的问题是：realtime 引擎只会把"触发那一刻的连发消息"合并进一次 Agent 调用，机器人看不到此前那些**没有 @ 它、因此没触发回复**的闲聊。开启 `history` 后，插件会把范围内的**每一条**消息（无论是否触发）追加进一个**按 `peerId` 独立维护、与 digest 完全分开**的滚动缓冲区（`src/aggregator.ts` 的 `historyBuffers`）。

### 累积、带入、清空

- **累积**：`acceptHistory()` 对每条消息都追加进该会话的缓冲区，并按 `maxMessages`（条数）和 `maxChars`（总字符数）从最旧的一端裁剪。这个引擎不看 `TriggerDecision`，也不开计时器——它只是攒着。
- **带入**：当这个会话产生一次 realtime 回复（`flushRealtimeWindow` 或 `realtime.enabled: false` 下的 `immediate` 立即 flush）时，`takeHistoryForReply()` 把缓冲区里**除本批 `messages` 之外**的历史消息快照出来，挂到 `batch.history` 上；`buildRealtimeBody()`（`src/dispatch.ts`）再把它渲染成 `[HH:mm:ss] 昵称(qq): 文本` 的转录块，夹在 `【历史聊天记录…】`／`【以上为历史消息…】` 两行提示之间，**只拼进 Agent 可见的 `body`**——`rawBody`/`commandBody` 保持只有用户本条输入，命令解析器因此永远只看到真正的输入、看不到历史。
- **清空**：快照的同一时刻缓冲区被清空（drain-on-consume）。因为攒下的内容此刻已经交给了 Agent（要么作为历史、要么作为本批消息），而 Agent 自身的会话记忆会从这里接续上下文，再留着只会在下次回复时重复发送、白白浪费 token。

`maxAgeMs` 默认 `0`（不按时间丢弃，只受条数/字符数约束）；设为正值时，带入那一刻会按消息的 QQ 时间戳丢掉早于该时长的旧消息，避免把很久以前的聊天当成"当前上下文"。`enabled: false` 时整个引擎被跳过：不累积、不带入，`batch.history` 恒为空。

### 时间线示例

场景：群 `20000002`，`selfId` 已知，`history` 默认开启，realtime 默认开启。

| 时刻 | 事件 | history 缓冲区 / 本次回复 |
|---|---|---|
| `10:00:00` | 用户 A "今晚几点集合"（未 @，未触发） | 缓冲区 `[A]`，不回复 |
| `10:00:05` | 用户 B "我八点有空"（未 @，未触发） | 缓冲区 `[A, B]`，不回复 |
| `10:00:10` | 用户 C "@机器人 帮我定个八点半的提醒"（触发） | realtime 开窗；静默到期 flush 时，`batch.messages = [C]`、`batch.history = [A, B]`，Agent 看到前两句闲聊作为上下文；随后缓冲区被清空 |
| `10:00:30` | 用户 D "顺便问下天气"（未 @，未触发） | 缓冲区重新从 `[D]` 开始攒（此前的 A/B/C 不会再重复带入） |

## 各接收模式如何组合

`aggregator.accept(msg, trigger)` 对每一条通过了 `isPeerAllowed` 检查的消息，都会**依次**（而非互斥地）调用 `acceptHistory`、`acceptRealtime` 和 `acceptDigest`：三次调用分别包在各自的 `try/catch` 里，一个引擎抛错不会影响其它引擎继续处理。`acceptHistory` 排在最前，这样一条消息即便立刻触发同步 flush（`immediate` / `max-messages` / `max-chars`），它也已经在缓冲区里、能被正确地从历史快照中排除（作为本批输入而非历史）。

一个典型的组合场景：群里同时开启了 `mention`（默认）和 `digest`（需手动开启）。用户 `@` 机器人问了个问题——这条消息**同时**：

1. 命中 `evaluateTrigger`，`triggered: true`；
2. 因为命中触发，为它在 realtime 引擎里开了一个窗口，短暂等待后合并、flush、拿到 Agent 回复并发回群里；
3. **同时**因为在 `digest.scope`/`peers` 范围内，也被追加进了这个群的 digest 缓冲区——等到 `digest.intervalMs` 到期或消息数攒够，这条消息会作为聊天记录的一部分，出现在稍后某一次摘要里。

这两条路径完全独立：realtime 那次 Agent 调用的回复不会影响 digest 的缓冲内容，digest 摘要也不会因为某条消息已经被 realtime 处理过而被排除在外。
