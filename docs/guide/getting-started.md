# 快速开始

## 前置条件

- Node.js **>= 22.14**（见 `package.json` 的 `engines.node`）
- 一个正在运行的 **SnowLuma** 实例，并已登录目标 QQ 账号
- SnowLuma 的 OneBot WebSocket 地址（`wsUrl`）和 access token（`accessToken`）。这两项通常可以在 SnowLuma 自身配置目录下的 `config/onebot_<uin>.json` 中找到（`<uin>` 是登录的 QQ 号），也可以在 SnowLuma 的管理界面/配置文件里确认监听端口与鉴权设置。

## 安装

`openclaw-snowluma` 已发布到 npm，**插件 id 与包名同为 `openclaw-snowluma`**。推荐用 OpenClaw 自带的插件管理 CLI 安装并启用——它会自动把插件写进 `openclaw.json` 的 `plugins.entries`（并在存在限制性 `plugins.allow` 白名单时把插件加进去），省去手写这部分配置。

```bash
# 1. 安装插件（不带前缀时默认从 npm 解析，npm:openclaw-snowluma 是等价的显式写法）
openclaw plugins install openclaw-snowluma

# 2. 安装不会自动启用，需要显式 enable（这一步负责写入 plugins.entries / plugins.allow）
openclaw plugins enable openclaw-snowluma

# 3. 确认插件已加载、通道/工具/action 都注册成功
openclaw plugins inspect openclaw-snowluma --runtime
openclaw plugins list --enabled
```

注意：`openclaw plugins install` 底层虽然走 npm，但 OpenClaw 的安装器**硬编码了 `--ignore-scripts`**——本插件的 `postinstall` 钩子（`scripts/patch-snowluma-sdk.mjs`，做什么、为什么需要它见下一节）在这条安装路径上**不会执行**。这不需要你做任何事：`0.1.4` 起插件会在加载时自动完成同样的修补（首次启动日志里的 `[snowluma] patched N extensionless import(s) ...` 就是它在工作）。

安装源不止 npm，按需选择：

| 命令 | 用途 |
|---|---|
| `openclaw plugins install openclaw-snowluma` | 从 npm 安装（默认源） |
| `openclaw plugins install npm:openclaw-snowluma` | 显式指定 npm 源 |
| `openclaw plugins install npm:openclaw-snowluma@0.1.0` | 锁定具体版本（可配合 `--pin` 记录已解析版本） |
| `openclaw plugins install git:github.com/<owner>/<repo>` | 从 git 仓库安装 |
| `openclaw plugins install --link ./` | 本地开发：软链到本地插件目录、不复制（需先 `npm run build` 生成 `dist/`） |

- 卸载：`openclaw plugins uninstall openclaw-snowluma`（会一并清理它写入的 `plugins.*` 配置；加 `--keep-files` 保留已安装目录）。
- 遇到加载 / 发现问题时先跑 `openclaw plugins doctor` 看诊断。

> **纯手动方式**（不走 CLI）：`npm install openclaw-snowluma`，然后自己在 `openclaw.json` 里写 `plugins.allow` / `plugins.entries`（见下一节）。CLI 方式只是把这两段配置的写入自动化了，账号运行时配置（`channels.snowluma`）两种方式都要自己填。

## `@snowluma/sdk` ESM 补丁说明 {#snowluma-sdk-esm-补丁说明}

这是一个**上游打包问题**，不是本插件引入的行为。

`@snowluma/sdk`（截至 v1.12.8）在自己的 `package.json` 里声明了 `"type": "module"`，但编译产物中使用了不带扩展名的相对导入，例如：

```js
export * from './client/api-client';
```

Node 的 ESM 解析器要求相对导入必须带完整文件扩展名（`.js`），因此在未打补丁的环境下，仅仅是 `import "@snowluma/sdk"` 就会抛出 `ERR_MODULE_NOT_FOUND`——插件代码根本来不及运行。

修补逻辑本身很简单：遍历 `node_modules/@snowluma/sdk/dist` 下的每个 `.js` / `.d.ts` 文件，把能在文件系统里解析到 `./x.js` 或 `./x/index.js` 的相对导入说明符原地重写为带扩展名的形式；已经带扩展名的说明符和裸包名导入（`from "some-package"`）不受影响。修补是**幂等的**——重复运行不会产生副作用，也不会破坏已经打过补丁的文件。

它在两个地方各跑一份（语义一致）：

1. **加载期自愈（`0.1.4` 起，主路径）**：`src/sdk.ts` 在第一次真正使用 SDK 之前先修补、再动态 `import("@snowluma/sdk")`。这是网关上的实际生效路径——OpenClaw 的插件安装器带 `--ignore-scripts`，任何 `postinstall` 都不会执行，所以修补必须发生在加载期。
2. **`postinstall` 脚本（`scripts/patch-snowluma-sdk.mjs`，兜底）**：手动 `npm install` 本插件时照常执行；用了 `npm ci --ignore-scripts` 或手动拷贝 `node_modules` 时也可以手动补一次：

```bash
node ./scripts/patch-snowluma-sdk.mjs
```

如果你看到 `ERR_MODULE_NOT_FOUND` 且报错路径指向 `@snowluma/sdk`，参见[故障排查](/guide/troubleshooting#err-module-not-found)。一旦上游发布修复版本，加载期修补和这个脚本都应当被移除。

## 在 `openclaw.json` 中启用插件

插件 id 是 `openclaw-snowluma`（与包名相同），通道 id 是 `snowluma`——两者写在配置的不同位置。下面是启用后 `openclaw.json` 应有的样子：

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

**如果你用的是上面的 `openclaw plugins install` + `openclaw plugins enable`**，`plugins.allow` / `plugins.entries` 这两段是 CLI 帮你写好的，你只需要补上 `channels.snowluma` 账号配置。**如果你走的是纯手动方式**（`npm install` + 手写 JSON），这两段都要自己填。

要点：

- `plugins.allow` / `plugins.entries` 使用**插件 id** `openclaw-snowluma`。
- 账号运行时配置写在 `channels.snowluma`（**不是** `channels.openclaw-snowluma`）。
- 也可以用环境变量代替显式配置——但环境变量**仅对 `default` 账号生效**（额外命名账号必须写在 `channels.snowluma.accounts.<id>` 下，不会读取环境变量）：

```bash
SNOWLUMA_WS_URL=ws://127.0.0.1:3001/
SNOWLUMA_HTTP_URL=http://127.0.0.1:3001
SNOWLUMA_ACCESS_TOKEN=your-snowluma-token   # 或 SNOWLUMA_TOKEN
SNOWLUMA_SELF_ID=123456789
```

完整的配置项列表、每一项的默认值和多账号写法，见[配置参考](/guide/configuration)。

配置写完后**做一次完整的网关重启**让它生效：

```bash
openclaw gateway restart
```

> 如果加载时看到 `ERR_REQUIRE_ESM_RACE_CONDITION`（`... From .../index.js` 或 `.../setup-entry.js`），那是本插件 `<= 0.1.1` 的一个加载缺陷，**完整重启也绕不开**，已在 `0.1.2` 彻底修复——升级到 `0.1.2` 及以上即可。详见[故障排查 · `ERR_REQUIRE_ESM_RACE_CONDITION`](/guide/troubleshooting#err-require-esm-race-condition)。

## 首次运行验证

1. **查看网关启动日志**。正常连接成功后应能看到类似：

   ```text
   [snowluma:default] starting gateway
   [snowluma:default] socket open
   [snowluma:default] gateway ready (selfId=123456789)
   ```

   如果日志里只有 `starting gateway` 和 `socket open`，却没有 `gateway ready`，或者 `selfId` 缺失，说明 `get_login_info` 自动探测失败了——群聊 `@` 触发依赖这个 `selfId`（详见[三种接收模式](/guide/receive-modes)），此时最稳妥的做法是显式配置 `selfId`。

2. **发一条私聊消息给机器人**。默认配置下 `receive.mention.alwaysReplyInDirect` 为 `true`，任何私聊消息都会无条件触发 Agent 回复——这是验证"消息能收到、Agent 能被调用、回复能发出去"整条链路最简单的方式。

3. **在群里 `@` 机器人**。默认配置下群聊需要 `@` 机器人才会触发（`requireMentionInGroup: true`）。如果 `@` 了却没有反应，参见[故障排查 · mention 从来不触发](/guide/troubleshooting#mention-从来不触发)。

4. **（可选）确认 Agent 工具已注册**。默认 `tools.enabled: true`，Agent 应该能看到 `snowluma_get_history` 和 `snowluma_get_group_members` 两个工具（见 [Agent 工具](/guide/tools)）。

## 下一步

- [配置参考](/guide/configuration) —— 完整的配置项、默认值与环境变量列表
- [三种接收模式](/guide/receive-modes) —— 精确到判定顺序的触发逻辑
- [故障排查](/guide/troubleshooting) —— 连接失败、鉴权失败、触发不生效的排查步骤
