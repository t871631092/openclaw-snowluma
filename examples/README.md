# 配置示例

本目录提供两份可直接复制到 `openclaw.json` 的 `openclaw-snowluma` 配置示例。两份文件都已针对
`openclaw.plugin.json` 里的 `channelConfigs.snowluma.schema` 校验通过（结构、字段名、取值范围）。

## 从哪个文件开始

- **`openclaw.minimal.json`** —— 最小可用配置：启用插件、一个 `default` 账号、只填 `wsUrl` +
  `accessToken`。其余选项全部留空，插件会用 `src/config.ts` 里的内置默认值（三种接收模式里只有
  `mention` 和 `realtime` 默认开启，`digest` 默认关闭）。**大多数人应该从这份文件开始**，跑通连接
  之后再按需加选项。
- **`openclaw.full.json`** —— 覆盖 `SnowLumaAccountConfig` 的每一个选项，且大多数取值特意选得和默认值
  不同（用来当"这个选项改了会长什么样"的参照），同时演示了 `receive.mention` / `receive.digest` /
  `receive.realtime` 三种接收模式同时配置、`quote`、`reconnect`（包含 `retries: 0` 这个"断线后不再自动
  重连"的显式配置）、`tools`、`allowFrom`/`denyFrom`，以及 `accounts` 下的第二个具名账号
  `secondary`。**不要直接把这份文件整个拿去用**——它是选项字典，不是推荐生产配置（比如
  `replyToTrigger: false`、`alwaysReplyInDirect: false` 只是为了展示这些开关存在，未必是你想要的行为）。

两份文件都把插件配置包在完整的 `openclaw.json` 结构里（`plugins` + `channels`），可以整段合并进你自己
的 `openclaw.json`，也可以只摘 `channels.snowluma` 那一段。

## 插件是怎么启用的

```json
{
  "plugins": {
    "allow": ["openclaw-snowluma"],
    "entries": {
      "openclaw-snowluma": { "enabled": true }
    }
  }
}
```

- `plugins.allow` 和 `plugins.entries` 的键都用**插件 id** `openclaw-snowluma`（和 npm 包名相同）。
- 账号级运行时配置写在 `channels.snowluma` 下——注意键是**通道 id** `snowluma`，不是插件 id，也不是
  `channels.openclaw-snowluma`。这是两个不同的命名空间，配置时最容易在这里搞混。
- **这段 `plugins.*` 不一定要手写**：`openclaw plugins install openclaw-snowluma` + `openclaw plugins enable
  openclaw-snowluma` 会自动帮你写入（见[快速开始 · 安装](../docs/guide/getting-started.md)）。CLI 只自动化
  `plugins.*` 这一块，`channels.snowluma`（下面几节讲的账号配置）两种方式都要自己填。enable/install 后记得做
  一次**完整** `openclaw gateway restart`，别依赖热重载。

## `wsUrl` / `accessToken` 从哪里来

这两项来自 SnowLuma 自身，不是插件生成的：

1. 找到 SnowLuma 的安装/运行目录，打开其配置目录下的 `config/onebot_<uin>.json`（`<uin>` 是登录的 QQ
   号，即目标机器人的 QQ 号）。
2. 该文件里的 OneBot WebSocket 监听地址（含协议、主机、端口）对应 `wsUrl`，例如
   `ws://127.0.0.1:3001/`；如果 SnowLuma 开启了鉴权，同一份配置里的 token 就是 `accessToken`。
3. 如果 SnowLuma 同时暴露了 HTTP API，同一份配置里通常也能找到对应端口，可选填到 `httpUrl`（仅在没有
   活跃 WebSocket 连接时才会被用到，见主 `README.md` 的说明）。
4. 也可以直接在 SnowLuma 自身的管理界面/日志里确认实际监听的地址和鉴权设置，两边必须一致——`wsUrl`
   填错端口/协议，或 `accessToken` 与 SnowLuma 侧不一致，连接都会失败或被拒绝。

## 机器人自己的 QQ 号（`selfId`）从哪里找，不填会怎样

`selfId` 就是这个机器人账号自己登录的 QQ 号——通常就是上面 `onebot_<uin>.json` 文件名里的那个
`<uin>`；也可以在 SnowLuma 管理界面/QQ 客户端本身确认。

不显式配置时，插件会在网关启动阶段调用 SnowLuma 的 `get_login_info` 自动探测；这个探测失败（网络问题、
token 不对、SnowLuma 还没登录等）或者你没配置时会发生什么：

- **群聊里 `@` 机器人不会触发回复**——`receive.mention` 判断"是不是在 @ 我"依赖已知的 `selfId`，没有
  这个值插件无法比对 `[CQ:at,qq=...]` 里的号码是不是自己，`reason: "mention"` 永远不会命中。
- **私聊、关键词触发、digest 摘要不受影响**——这几种触发路径不需要 `selfId`。

生产环境建议显式配置 `selfId`，避免依赖网络时序（网关启动时自动探测有可能因为 SnowLuma 还没就绪而失败）。

## Setup 向导

也可以不手写 JSON，用 CLI 走 setup 向导，两种方式二选一：

### 方式一：`--token`

```bash
openclaw channels add --channel snowluma --token <wsUrl>[,<accessToken>[,<httpUrl>[,<selfId>]]]
```

`--token` 的取值是一个**逗号分隔的字符串**，字段顺序固定为：

```
wsUrl[,accessToken[,httpUrl[,selfId]]]
```

即：`wsUrl` 必填（第一段）；`accessToken`、`httpUrl`、`selfId` 都可选，但**必须按位置省略**——比如只想
填 `wsUrl` 和 `selfId`、跳过 `accessToken`/`httpUrl`，中间的逗号也要保留：
`ws://127.0.0.1:3001/,,,123456789`。这个格式和解析逻辑严格对应 `src/channel.ts` 里
`setup.applyAccountConfig` 的实现（按 `,` split，取 `parts[0]`=wsUrl、`parts[1]`=accessToken、
`parts[2]`=httpUrl、`parts[3]`=selfId，每一段都会 `trim()`，空字符串视为未提供）。

示例：

```bash
openclaw channels add --channel snowluma --token ws://127.0.0.1:3001/,your-snowluma-token
openclaw channels add --channel snowluma --token ws://127.0.0.1:3001/,your-snowluma-token,http://127.0.0.1:3001,123456789
```

### 方式二：`--use-env`

```bash
openclaw channels add --channel snowluma --use-env
```

不传 `--token`，改为从环境变量读取（先在 shell/进程环境里设置好）：

| 环境变量 | 对应字段 |
|---|---|
| `SNOWLUMA_WS_URL` | `wsUrl` |
| `SNOWLUMA_ACCESS_TOKEN`（或 `SNOWLUMA_TOKEN`，两者选其一即可，`SNOWLUMA_ACCESS_TOKEN` 优先） | `accessToken` |
| `SNOWLUMA_HTTP_URL` | `httpUrl` |
| `SNOWLUMA_SELF_ID` | `selfId` |

这组环境变量同时也是运行时的兜底：即使完全不跑 setup 向导、不在 `openclaw.json` 里写任何
`channels.snowluma` 字段，只要这些环境变量存在，`default` 账号也能正常连接（见 `src/env.ts` /
`resolveSnowLumaAccount`）——但**仅对 `default` 账号生效**，`channels.snowluma.accounts.<id>` 下的具名
账号不会读取这组环境变量,必须显式配置。

`--token` 和 `--use-env` 二选一即可，两者都不给时 `setup.validateInput` 会拒绝并提示这两种方式；两者
同时给时以 `--token` 为准（`applyAccountConfig` 只在 `input.token` 存在时解析并写入 `wsUrl` 等字段）。

配置完成后记得重启 gateway：`openclaw gateway restart`。
