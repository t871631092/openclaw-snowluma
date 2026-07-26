/**
 * `channels.snowluma` config schema for the OpenClaw control-UI config editor.
 *
 * Without this, `snowLumaPlugin.configSchema` is `undefined` and the host falls
 * back to a raw/unsupported node for every section (Accounts, Quote, Receive,
 * Reconnect, Tools) instead of rendering real form fields. The shapes below are
 * plain JSON Schema literals — only `type`/`properties`/`items`/`enum`/
 * `additionalProperties`/`anyOf`-of-scalars, which is what the control-UI's
 * schema-to-form renderer understands (see
 * node_modules/openclaw/dist/control-ui/assets/index-*.js, the `cfg-field`
 * renderer). No `$ref`/`allOf`/`oneOf`-of-objects/`patternProperties` — the
 * renderer falls back to "Unsupported schema node" for those.
 *
 * Kept in sync with the shape of `SnowLumaAccountConfig`/`SnowLumaChannelConfig`
 * in `types.ts` and the defaults `config.ts` actually applies
 * (`RECEIVE_DEFAULTS`, `QUOTE_DEFAULTS`, `resolveSnowLumaAccount`).
 *
 * Type-only on purpose: `ChannelConfigSchema`/`ChannelConfigUiHint` are erased
 * at compile time, same as every other `openclaw` import in this plugin — see
 * the "no openclaw/* runtime import" hard constraint in CLAUDE.md and
 * src/plugin-entry.ts / src/tools.ts for the established pattern.
 */
import type { ChannelConfigSchema, ChannelConfigUiHint } from "openclaw/plugin-sdk";

type JsonSchemaLiteral = Record<string, unknown>;

const stringArray: JsonSchemaLiteral = { type: "array", items: { type: "string" } };

const numberOrString: JsonSchemaLiteral = { anyOf: [{ type: "number" }, { type: "string" }] };

const reconnectSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "启用自动重连" },
    retries: { type: "number", description: "重试次数上限；留空表示无限重试" },
    minDelayMs: { type: "number", default: 1000, description: "重连最小延迟（毫秒）" },
    maxDelayMs: { type: "number", default: 30000, description: "重连最大延迟（毫秒）" },
  },
};

const mentionSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "启用 提及/关键词 触发" },
    requireMentionInGroup: { type: "boolean", default: true, description: "群聊中需要 @机器人 才触发" },
    keywords: { ...stringArray, description: "无需 @ 也能触发的关键词列表" },
    keywordMatch: {
      type: "string",
      enum: ["contains", "prefix", "exact", "regex"],
      default: "contains",
      description: "关键词匹配方式",
    },
    caseSensitive: { type: "boolean", default: false, description: "关键词匹配是否区分大小写" },
    triggerOnReplyToSelf: { type: "boolean", default: true, description: "回复机器人自己的消息也触发" },
    alwaysReplyInDirect: { type: "boolean", default: true, description: "私聊无条件触发（无论是否命中关键词）" },
  },
};

const digestSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false, description: "启用摘要模式" },
    intervalMs: { type: "number", default: 300000, description: "距窗口打开达到该时长（毫秒）后刷新" },
    maxMessages: { type: "number", default: 50, description: "窗口累积消息数达到该值后刷新" },
    minMessages: { type: "number", default: 3, description: "窗口消息数达到该值前不会刷新" },
    prompt: { type: "string", description: "下发摘要时附加的提示词" },
    scope: {
      type: "string",
      enum: ["group", "direct", "all"],
      default: "group",
      description: "监听的会话范围",
    },
    peers: { ...stringArray, description: '仅监听这些会话（如 "group:123"），留空表示范围内全部监听' },
    maxTranscriptChars: { type: "number", default: 20000, description: "下发给 agent 的转录文本字符上限" },
  },
};

const summarySchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "启用 /summary 主动总结命令" },
    commands: { ...stringArray, description: '触发命令词，默认 ["/summary", "/总结"]；留空则使用默认值' },
    count: { type: "number", default: 100, description: "命令未带数字时总结最近多少条消息" },
    maxCount: { type: "number", default: 200, description: "用户通过 /summary <n> 可请求的条数上限" },
    prompt: { type: "string", description: "下发总结时附加的提示词" },
    scope: {
      type: "string",
      enum: ["group", "direct", "all"],
      default: "all",
      description: "允许使用该命令的会话范围",
    },
    peers: { ...stringArray, description: '仅这些会话可用（如 "group:123"），留空表示范围内全部可用' },
    maxTranscriptChars: { type: "number", default: 20000, description: "下发给 agent 的转录文本字符上限" },
  },
};

const realtimeSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "启用突发消息实时合并" },
    windowMs: { type: "number", default: 800, description: "静默多久（毫秒）后刷新，需小于 1000 才算「实时」" },
    maxWindowMs: { type: "number", default: 3000, description: "一次合并窗口最长可持续多久（毫秒）" },
    maxMessages: { type: "number", default: 10, description: "窗口消息数达到该值立即刷新" },
    maxChars: { type: "number", default: 8000, description: "窗口文本字符数达到该值立即刷新" },
  },
};

const historySchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "累积每个会话的近期消息，触发回复时作为历史聊天上下文一并带入（与摘要队列分开存储）" },
    maxMessages: { type: "number", default: 20, description: "每个会话保留的历史消息条数上限" },
    maxChars: { type: "number", default: 4000, description: "每个会话保留/带入的历史文本字符上限" },
    maxAgeMs: { type: "number", default: 0, description: "带入时丢弃早于该时长（毫秒）的历史消息；0 表示不按时间丢弃" },
  },
};

const receiveSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    mention: mentionSchema,
    digest: digestSchema,
    summary: summarySchema,
    realtime: realtimeSchema,
    history: historySchema,
  },
};

const quoteSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "主动解析引用消息" },
    resolveForward: { type: "boolean", default: true, description: "展开合并转发消息" },
    maxDepth: { type: "number", default: 2, description: "合并转发的最大展开深度" },
    maxNodes: { type: "number", default: 20, description: "单次展开的转发节点数上限" },
    maxChars: { type: "number", default: 4000, description: "注入正文的引用文本字符上限" },
    timeoutMs: { type: "number", default: 10000, description: "单次解析请求的超时时间（毫秒）" },
  },
};

const renderSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "把 digest / /summary 的回复渲染成图片发送（失败自动回退纯文本）" },
    width: { type: "number", default: 720, description: "图片内容宽度（CSS px，缩放前）" },
    scale: { type: "number", default: 2, description: "光栅化倍率，相当于设备像素比" },
    theme: {
      type: "string",
      enum: ["light", "dark"],
      default: "light",
      description: "配色主题",
    },
    fontSize: { type: "number", default: 26, description: "正文字号（px），标题与代码块按比例缩放" },
    fontPath: { type: "string", description: "正文字体文件路径（.ttf/.otf/.ttc）；留空则按平台自动探测" },
    boldFontPath: { type: "string", description: "粗体字体文件路径；留空自动探测，找不到时粗体按常规字重渲染" },
    maxChars: { type: "number", default: 8000, description: "回复超过该字符数时不转图片，直接发文本" },
  },
};

const toolsSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true, description: "注册本插件的 agent 工具（聊天记录 / 群成员）" },
  },
};

/** Fields shared by the default account (top level) and every named `accounts.<id>` entry. */
function accountFieldProperties(): Record<string, JsonSchemaLiteral> {
  return {
    enabled: { type: "boolean", default: true, description: "启用该账号" },
    name: { type: "string", description: "账号显示名称" },
    wsUrl: { type: "string", description: "SnowLuma OneBot WebSocket 地址，例如 ws://127.0.0.1:3001/" },
    httpUrl: { type: "string", description: "可选的 HTTP API 地址；配置后动作走 HTTP 而非 WebSocket" },
    accessToken: { type: "string", description: "SnowLuma access token" },
    selfId: { ...numberOrString, description: "机器人自己的 QQ 号；留空则通过 get_login_info 自动获取" },
    allowFrom: { ...stringArray, description: '允许的会话，如 ["private:123","group:456","*"]' },
    denyFrom: { ...stringArray, description: "拒绝的会话；在 allowFrom 之后生效" },
    groupAutoReact: { type: "boolean", default: false, description: "对触发 agent 的群消息自动回应表情" },
    groupAutoReactEmojiId: { ...numberOrString, default: 1, description: "groupAutoReact 使用的 QQ 表情 id" },
    replyToTrigger: { type: "boolean", default: true, description: "以引用回复的形式发送回复" },
    textChunkLimit: { type: "number", default: 4500, description: "出站文本按该字符数分段发送" },
    requestTimeoutMs: { type: "number", default: 30000, description: "SnowLuma 动作请求超时时间（毫秒）" },
    debug: { type: "boolean", default: false, description: "调试模式：在日志中打印每条出站消息的原始内容" },
    reconnect: reconnectSchema,
    receive: receiveSchema,
    quote: quoteSchema,
    render: renderSchema,
    tools: toolsSchema,
  };
}

const namedAccountSchema: JsonSchemaLiteral = {
  type: "object",
  properties: accountFieldProperties(),
};

const channelConfigJsonSchema: JsonSchemaLiteral = {
  type: "object",
  properties: {
    ...accountFieldProperties(),
    accounts: {
      type: "object",
      properties: {},
      additionalProperties: namedAccountSchema,
      description: "具名多账号：键为账号 id，值为该账号的独立配置（结构同默认账号）",
    },
  },
};

const uiHints: Record<string, ChannelConfigUiHint> = {
  accessToken: { sensitive: true },
};

export const snowLumaConfigSchema: ChannelConfigSchema = {
  schema: channelConfigJsonSchema as unknown as ChannelConfigSchema["schema"],
  uiHints,
};
