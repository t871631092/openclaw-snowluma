import { defineConfig } from "vitepress";

export default defineConfig({
  // GitHub Actions 部署到项目页 https://t871631092.github.io/openclaw-snowluma/，
  // 需要非根 base；本地 dev/preview 时仍用根路径。
  base: process.env.GITHUB_ACTIONS ? "/openclaw-snowluma/" : "/",

  lang: "zh-CN",
  title: "openclaw-snowluma",
  description: "OpenClaw 的 SnowLuma QQ 通道插件文档 —— 基于 @snowluma/sdk 构建，纯 SDK 驱动，不重新实现 OneBot 协议。",

  head: [["meta", { name: "theme-color", content: "#3b82f6" }]],

  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/introduction" },
      { text: "配置参考", link: "/guide/configuration" },
      { text: "接收模式", link: "/guide/receive-modes" },
      { text: "开发", link: "/guide/development" },
    ],

    sidebar: [
      {
        text: "开始",
        items: [
          { text: "介绍", link: "/guide/introduction" },
          { text: "快速开始", link: "/guide/getting-started" },
        ],
      },
      {
        text: "核心概念",
        items: [
          { text: "配置参考", link: "/guide/configuration" },
          { text: "三种接收模式", link: "/guide/receive-modes" },
          { text: "引用与合并转发", link: "/guide/quotes-and-forwards" },
        ],
      },
      {
        text: "能力",
        items: [
          { text: "Agent 工具", link: "/guide/tools" },
          { text: "动作与消息目标", link: "/guide/actions-and-targets" },
        ],
      },
      {
        text: "运维与开发",
        items: [
          { text: "故障排查", link: "/guide/troubleshooting" },
          { text: "开发指南", link: "/guide/development" },
        ],
      },
    ],

    search: {
      provider: "local",
    },

    outline: {
      label: "本页目录",
      level: [2, 3],
    },

    docFooter: {
      prev: "上一页",
      next: "下一页",
    },

    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "外观",
    lastUpdated: {
      text: "最后更新于",
    },
  },
});
