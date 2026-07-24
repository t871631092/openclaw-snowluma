# 开发指南

## 仓库结构

```text
qbot/
├── index.ts               # 插件主入口：注册 ChannelPlugin + runtime，重导出公共类型
├── setup-entry.ts          # OpenClaw 安装向导入口（defineSetupPluginEntry）
├── openclaw.plugin.json    # 插件清单：配置 JSON Schema、渠道声明、Agent 工具契约
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── scripts/
│   └── patch-snowluma-sdk.mjs   # postinstall：修补 @snowluma/sdk 的 ESM 打包缺陷
├── src/
│   ├── types.ts        # 全部配置接口 + 归一化消息/触发/引用领域类型定义
│   ├── config.ts        # RECEIVE_DEFAULTS / QUOTE_DEFAULTS、resolveSnowLumaAccount、isPeerAllowed
│   ├── env.ts           # SNOWLUMA_* 环境变量回退（仅 default 账号）
│   ├── segments.ts      # 入站消息段解析/归一化（toSegments / renderSegments / normalizeMessageEvent）
│   ├── triggers.ts      # mention 模式判定逻辑（evaluateTrigger / matchKeyword / stripLeadingMention）
│   ├── aggregator.ts    # realtime + digest 两套独立的窗口聚合引擎（createAggregator）
│   ├── quote.ts         # 主动 get_msg / get_forward_msg 引用与合并转发解析
│   ├── client.ts        # SnowLuma WS/HTTP 客户端构造 + action-client 注册表
│   ├── outbound.ts      # 目标解析、文本分块、sendText / sendMedia / reactToMessage
│   ├── dispatch.ts      # 把一个聚合批次交给 Agent，再把回复发回 QQ
│   ├── gateway.ts       # 单账号长连接主循环，串联 trigger/aggregator/dispatch
│   ├── tools.ts         # 两个 Agent 工具：snowluma_get_history / snowluma_get_group_members
│   ├── channel.ts       # ChannelPlugin 表面：config/setup/outbound/actions/agentTools/gateway/status
│   └── runtime.ts        # PluginRuntime 的 get/set/clear store
└── test/
    ├── helpers/mock-runtime.ts   # dispatch.ts 测试用的手写 PluginRuntime 替身
    └── *.test.ts                 # 10 个测试文件，223 个用例（见下表）
```

模块之间的依赖大致是一条流水线：`segments.ts` 把 SnowLuma 事件归一化 → `triggers.ts` 判定要不要触发 → `aggregator.ts` 决定何时把一批消息合并成一次 Agent 调用 → `quote.ts` 补充引用/转发上下文 → `dispatch.ts` 组装 Agent 输入并投递回复 → `gateway.ts` 把这一切串成一个长连接循环。`client.ts` 是所有模块共享的"怎么拿到一个可用的 SnowLuma 客户端"的底座，`config.ts`/`types.ts` 是贯穿全部模块的配置真相来源。`channel.ts` 是宿主 OpenClaw 唯一直接认识的入口，`index.ts`/`setup-entry.ts` 只是把它包装成宿主要求的插件清单形状。

## 测试套件

`npm test`（`vitest run`）目前运行 **10 个测试文件，223 个用例**，全部通过；`npm run coverage` 额外要求 `src/**/*.ts`（`types.ts` 排除在外，纯类型声明没有可执行分支）达到行 80% / 函数 80% / 分支 70% / 语句 80% 的覆盖率门槛（`vitest.config.ts`）。

| 测试文件 | 用例数 | 覆盖内容 |
|---|---|---|
| `triggers.test.ts` | 28 | `matchKeyword` 的四种匹配模式与非法正则容错；`stripLeadingMention` 的前导 @ 剥离；`evaluateTrigger` 全部判定分支（`enabled=false` 覆盖、direct、mention、reply-to-self、keyword、群聊/私聊收尾规则）。 |
| `aggregator.test.ts` | 19 | realtime 引擎的开窗/并入/四种 flush 触发条件；digest 引擎的 scope/peers 过滤、`minMessages` 抑制-重试、`maxTranscriptChars` 裁剪；`flushAll`/`dispose`；`onFlush` 抛错时的隔离（一个批次的错误不影响另一个批次）。 |
| `segments.test.ts` | 20 | `toSegments` 处理数组/CQ 字符串/纯字符串三种入站消息形状及其退化路径；`extractText`/`extractMentions`（含 `atAll`）/`extractImageUrls`/`extractRecordUrls`/`extractReplyToId`/`extractForwardIds`；`renderSegments` 的占位符渲染；`normalizeMessageEvent` 端到端归一化。 |
| `outbound.test.ts` | 34 | `parseTarget` 的四种写法与非法输入拒绝；`formatTarget`；`chunkText` 的换行优先切分与 CQ 码不可分割保证；`sendText` 的分块与仅首块引用；`sendMedia` 的图片/语音/文件上传三路由与 caption 独立发送；`reactToMessage` 的成功/失败包装。 |
| `client.test.ts` | 11 | `createSnowLumaClient` 的 `reconnect` 选项映射（含 `retries` 到 `Infinity` 时省略字段、有限值原样透传）；action-client 注册表的注册/查询/清理；`acquireActionClient` 复用已注册 socket vs. 现开临时客户端（WS/HTTP 两路）；`detectSelfId` 的成功/失败降级。 |
| `quote.test.ts` | 16 | `resolveQuoteContext` 的关闭开关与"无引用无转发直接返回 null"两条门禁；`get_msg` 成功解析路径；`resolveForwardNodes` 的深度/节点数/环检测展开逻辑；引用与转发整合后的字符预算截断；`formatQuoteContext` 的渲染格式（含无发送者信息、截断标记两种退化）。 |
| `gateway.test.ts` | 20 | `createSelfMessageTracker` 的 FIFO 容量淘汰；`startGateway` 的建连/`selfId` 探测/`onReady`/`onError` 回调；消息路由（自身消息过滤、`isPeerAllowed`、触发判定接入聚合器、`groupAutoReact`）；自身消息 id 追踪如何反哺 `reply-to-self` 判定；`abortSignal` 触发后的优雅关闭顺序（flush → unregister → close）。 |
| `dispatch.test.ts` | 26 | `resolveInboundCommandAuthorization` 的访问组网关与 `allowFrom` 兜底；`buildBatchBody` 对 realtime/digest 两种批次的正文组装差异；`dispatchBatch` 的 realtime 端到端流程（含引用解析接入）；digest 批次的 `CommandAuthorized` 硬编码为 `false`；`SKIP` 静默；`replyToTrigger` 引用哪条消息；媒体+文本混合投递；`dispatchBatch` 对各种子步骤异常"永不 reject"的保证。 |
| `tools.test.ts` | 20 | `createSnowLumaAgentTools` 的工具装配；`snowluma_get_history` 的参数校验/`count` 夹取/分页/排序/渲染/失败降级；`snowluma_get_group_members` 的 `groupId` 校验/`limit` 夹取/截断提示/渲染；依赖注入（`ToolDeps.acquireActionClient` 替身）。 |
| `channel.test.ts` | 29 | `snowLumaPlugin` 的身份与能力声明；`config.*`（账号解析、`isConfigured`、`describeAccount`）；`setup.*`（`--token`/`--use-env` 校验、`applyAccountConfig` 的 token 字段拆分）；`messaging.*`（`normalizeTarget`、`targetResolver`）；`outbound.*`（`sendText`/`sendMedia` 对 `acquireActionClient` 的调用与释放）；`actions.*`（`react` 的参数别名与错误路径）；`agentTools`；`status.*`；插件入口点导出形状。 |

跑单个文件：`npx vitest run test/triggers.test.ts`；watch 模式跑全部：`npm run test:watch`。

## 常用命令

```bash
npm install          # 安装依赖；postinstall 自动跑 @snowluma/sdk 的 ESM 补丁脚本
npm run build         # tsc 编译 src/ + index.ts + setup-entry.ts 到 dist/
npm run dev            # tsc --watch
npm run typecheck      # tsc --noEmit（严格模式，noImplicitAny 关闭）
npm test               # vitest run，跑 test/**/*.test.ts
npm run test:watch     # vitest（watch 模式）
npm run coverage        # vitest run --coverage（v8 provider，见上方覆盖率门槛）
npm run docs:dev        # 本地预览文档站（VitePress dev server）
npm run docs:build      # 构建静态文档站到 docs/.vitepress/dist
npm run docs:preview    # 预览已构建的文档站
```

`tsconfig.json` 的 `include` 只列了 `index.ts`、`setup-entry.ts`、`src/**/*.ts` 三项——是一个显式白名单，而不是通配全仓库，因此 `docs/`（包括 `docs/.vitepress/config.ts`）和 `test/` 都不会被 `tsc`/`tsc --noEmit` 处理，文档站的 TypeScript 配置和插件本体的类型检查互不影响。
