# 介绍

`openclaw-snowluma` 是一个 [OpenClaw](https://openclaw.dev) 通道插件，让 QQ 通过 [SnowLuma](https://www.npmjs.com/package/@snowluma/sdk) 成为 OpenClaw 的一等消息通道。

## 三个不同的 id

在配置这个插件之前，先弄清楚三个容易混淆的名字：

| 名字 | 值 | 用在哪里 |
|---|---|---|
| npm 包名 | `openclaw-snowluma` | `npm install openclaw-snowluma` |
| 插件 id | `openclaw-snowluma` | `plugins.allow` / `plugins.entries` |
| 通道 id | `snowluma` | `channels.snowluma`（运行时账号配置） |

插件 id 和包名恰好相同，但通道 id 是 `snowluma`，不是 `openclaw-snowluma`——账号级配置（`wsUrl`、`accessToken`、`receive`、`quote` 等）全部写在 `channels.snowluma` 下，而不是 `channels.openclaw-snowluma`。

## 架构

一条 QQ 消息从发出到 Agent 看见、再到回复送达，经过四层：

```text
┌─────────┐   OneBot 11   ┌───────────┐   @snowluma/sdk   ┌──────────────────┐   pluginRuntime.channel.*   ┌────────────────────┐
│   QQ    │ ─────────────▶│ SnowLuma  │ ─────────────────▶│  openclaw-snowluma │ ────────────────────────────▶│ OpenClaw Gateway /  │
│ (客户端) │◀───────────── │ (OneBot   │◀────────────────── │     (本插件)        │◀──────────────────────────── │ Agent Runtime        │
└─────────┘   WS/HTTP     │  实现)     │  action / event   └──────────────────┘        回复 / 工具调用          └────────────────────┘
                          └───────────┘
```

- **QQ** 是最终用户所在的客户端；QQ 协议本身对第三方不公开，SnowLuma 负责与 QQ 通信。
- **SnowLuma** 是一个 OneBot 11 兼容的实现，登录 QQ 账号后对外暴露一个 WebSocket（可选 HTTP）接口：上行推送消息事件，下行接受 `send_group_msg`、`get_msg`、`get_forward_msg`、`get_group_member_list`、`set_msg_emoji_like` 等 action 调用。
- **本插件（openclaw-snowluma）** 是 SnowLuma 与 OpenClaw 之间的适配层：接收 SnowLuma 推送的原始事件，做触发判定（`src/triggers.ts`）、聚合（`src/aggregator.ts`）、引用解析（`src/quote.ts`），再通过 OpenClaw 的 `pluginRuntime.channel.*` helper 把一次"批次"交给 Agent；Agent 的回复再通过本插件的 `outbound.ts` 发回 QQ。
- **OpenClaw Gateway / Agent Runtime** 是宿主：负责路由（`resolveAgentRoute`）、组装 Agent 上下文（`finalizeInboundContext`）、调度 Agent 回复（`dispatchReplyWithBufferedBlockDispatcher`），本插件只是它众多通道插件中的一个。

## 设计原则：只通过 SDK 说话

这是一条贯穿整个代码库的硬性设计原则，在 `src/channel.ts` 和 `src/quote.ts` 的模块注释里都有强调：

> 所有与 SnowLuma 的交互都经由 `SnowLumaWebSocketClient` / `SnowLumaHttpClient` 及其 action 方法完成，插件代码里**没有**手写的 OneBot 协议解析、**没有**裸 WebSocket、**没有**裸 `fetch`。

具体体现在：

- 建立连接、发送心跳、断线重连全部交给 `@snowluma/sdk` 的 `SnowLumaWebSocketClient`（见 `src/client.ts`、`src/gateway.ts`）——本插件从不自己开 socket，也从不自己安排重连定时器。
- 发消息使用 SDK 提供的消息构造器（`text()`、`image()`、`record()`、`reply()`），而不是手工拼装 OneBot 消息段 JSON（见 `src/outbound.ts`）。
- 解析入站消息段（`[CQ:at,...]`、数组格式、纯字符串格式）使用 SDK 的 `parseSegments`（见 `src/segments.ts`），插件自己只做「归一化到内部 `SnowLumaMessageSegment[]` 形状」这一步。
- 引用消息与合并转发通过 SDK 的 `getMessage` / `getForwardMessage` action 方法主动拉取（见 `src/quote.ts`），而不是自己拼 `get_msg` / `get_forward_msg` 的原始请求包。

这样做的直接好处：**SnowLuma 协议细节的变化应该只需要升级 `@snowluma/sdk` 依赖版本，而不需要改插件逻辑**。作为唯一的例外，ESM 补丁（加载期的 `src/sdk.ts` 自愈 + `postinstall` 兜底脚本 `scripts/patch-snowluma-sdk.mjs`）修补的是 SDK 自身的打包问题（详见[快速开始](/guide/getting-started#snowluma-sdk-esm-补丁说明)），不是协议层面的内容，也不违反这条原则——插件依然只通过 SDK 暴露的 API 说话，只是先让 Node 能把这个 API `import` 进来。

## 下一步

- 想马上跑起来：[快速开始](/guide/getting-started)
- 想搞清楚每个配置项的默认值：[配置参考](/guide/configuration)
- 想理解触发时机的精确语义：[三种接收模式](/guide/receive-modes)
