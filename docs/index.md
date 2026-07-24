---
layout: home

hero:
  name: openclaw-snowluma
  text: OpenClaw 的 SnowLuma QQ 通道插件
  tagline: 纯粹基于 @snowluma/sdk 构建 —— 三种可组合的接收模式、主动的引用/合并转发解析，以及两个只读 Agent 工具。223 个测试用例覆盖。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 了解架构
      link: /guide/introduction
    - theme: alt
      text: 配置参考
      link: /guide/configuration

features:
  - icon: 🔌
    title: 只通过 SDK 说话
    details: 所有与 SnowLuma 的交互都经由 SnowLumaWebSocketClient / SnowLumaHttpClient 完成，插件代码里没有手写的 OneBot 协议解析，没有裸 WebSocket、没有裸 fetch。
  - icon: 🎛️
    title: 三种可组合的接收模式
    details: 被动 @/关键词触发（mention）、定时摘要（digest）、亚秒级消息聚合（realtime）——三者互不影响，可以同时开启，各自维护独立的缓冲窗口。
  - icon: 💬
    title: 主动的引用与合并转发解析
    details: 收到消息后主动调用 get_msg / get_forward_msg，让 Agent 从一开始就能看到被引用或转发的完整上下文，而不是等 Agent 自己去问。
  - icon: 🛠️
    title: 两个只读 Agent 工具
    details: snowluma_get_history（聊天记录）与 snowluma_get_group_members（群成员列表），失败时返回结构化错误而不是抛出异常。
  - icon: 🎯
    title: 灵活的消息目标与动作
    details: 统一的 group:<群号> / private:<QQ号> 目标格式，出站文本自动分块，支持 QQ 引用回复，以及 react 表情回应动作。
  - icon: ✅
    title: 223 个测试用例
    details: 10 个测试文件覆盖触发判定、聚合窗口、引用解析、Agent 工具、出站发送、网关生命周期与插件装配的每一处行为分支。
---
