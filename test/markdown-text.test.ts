/**
 * Markdown → plain text for QQ.
 *
 * QQ renders no markup at all, so the contract here is "nothing that only makes
 * sense to a Markdown renderer survives, and nothing the user wrote is lost".
 */
import { describe, expect, it } from "vitest";
import { markdownToText } from "../src/markdown-text.js";

describe("markdownToText — inline markup", () => {
  it("drops emphasis markers but keeps the words", () => {
    expect(markdownToText("会议定在 **周四下午三点**")).toBe("会议定在 周四下午三点");
    expect(markdownToText("*强调* 和 _下划线_")).toBe("强调 和 _下划线_");
    expect(markdownToText("***又粗又斜***")).toBe("又粗又斜");
    expect(markdownToText("__加粗__ 与 ~~作废~~")).toBe("加粗 与 作废");
  });

  it("keeps both bold runs in one line", () => {
    expect(markdownToText("**甲** 和 **乙** 都要参加")).toBe("甲 和 乙 都要参加");
  });

  it("unwraps inline code", () => {
    expect(markdownToText("请运行 `npm test` 验证")).toBe("请运行 npm test 验证");
  });

  it("keeps a link label and puts the target in parentheses", () => {
    expect(markdownToText("详见 [发版清单](https://example.com/c)")).toBe("详见 发版清单（https://example.com/c）");
  });

  it("does not duplicate a url that is its own label", () => {
    expect(markdownToText("[https://example.com](https://example.com)")).toBe("https://example.com");
  });

  it("reduces an image to a placeholder", () => {
    expect(markdownToText("![架构图](https://example.com/a.png)")).toBe("[图片:架构图]");
    expect(markdownToText("![](https://example.com/a.png)")).toBe("[图片]");
  });

  it("leaves a bare asterisk alone", () => {
    expect(markdownToText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("markdownToText — block markup", () => {
  it("turns headings into bracketed lines with a blank line above", () => {
    expect(markdownToText("正文\n\n## 关键结论\n下一行")).toBe("正文\n\n【关键结论】\n下一行");
    expect(markdownToText("# 一级")).toBe("【一级】");
    expect(markdownToText("###### 六级")).toBe("【六级】");
  });

  it("converts bullets, and marks nesting depth", () => {
    expect(markdownToText("- 甲\n- 乙")).toBe("• 甲\n• 乙");
    expect(markdownToText("* 甲\n+ 乙")).toBe("• 甲\n• 乙");
    expect(markdownToText("- 外层\n  - 内层\n    - 更内层")).toBe("• 外层\n  ◦ 内层\n    · 更内层");
  });

  it("keeps ordered list numbering as written", () => {
    expect(markdownToText("3. 三\n4. 四")).toBe("3. 三\n4. 四");
    expect(markdownToText("1) 一")).toBe("1. 一");
  });

  it("renders task lists with checkbox symbols", () => {
    expect(markdownToText("- [x] 已完成\n- [ ] 待办")).toBe("• ✅ 已完成\n• ⬜ 待办");
  });

  it("marks blockquotes with a bar", () => {
    expect(markdownToText("> 风险提示")).toBe("｜ 风险提示");
  });

  it("replaces a horizontal rule with a divider", () => {
    expect(markdownToText("上\n\n---\n\n下")).toBe("上\n\n————————\n\n下");
  });

  it("keeps code blocks verbatim and drops the fences", () => {
    expect(markdownToText("```bash\nnpm run build\n  npm test\n```")).toBe("npm run build\n  npm test");
  });

  it("does not touch markup-looking text inside a code block", () => {
    expect(markdownToText("```\n# not a heading\n- not a bullet\n**not bold**\n```")).toBe(
      "# not a heading\n- not a bullet\n**not bold**",
    );
  });

  it("leaves table rows readable rather than mangling them", () => {
    const table = "| 负责人 | 任务 |\n|---|---|\n| 张三 | 发版 |";
    const out = markdownToText(table);
    expect(out).toContain("负责人");
    expect(out).toContain("张三");
  });
});

describe("markdownToText — whole messages", () => {
  it("flattens a realistic summary without losing content", () => {
    const md = [
      "# 群聊总结",
      "",
      "今天主要围绕 **v0.4.0 发版** 展开讨论。",
      "",
      "## 待办",
      "",
      "- [x] 确认发版窗口",
      "- [ ] 补齐迁移文档",
      "",
      "> 风险：灰度错误率超过 1% 立即回滚。",
      "",
      "详见 [清单](https://example.com/c)。",
    ].join("\n");

    expect(markdownToText(md)).toBe(
      [
        "【群聊总结】",
        "",
        "今天主要围绕 v0.4.0 发版 展开讨论。",
        "",
        "【待办】",
        "",
        "• ✅ 确认发版窗口",
        "• ⬜ 补齐迁移文档",
        "",
        "｜ 风险：灰度错误率超过 1% 立即回滚。",
        "",
        "详见 清单（https://example.com/c）。",
      ].join("\n"),
    );
  });

  it("collapses runs of blank lines and trims the message", () => {
    expect(markdownToText("\n\n甲\n\n\n\n乙\n\n")).toBe("甲\n\n乙");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(markdownToText("")).toBe("");
    expect(markdownToText("   \n\n ")).toBe("");
  });

  it("passes plain text through unchanged", () => {
    expect(markdownToText("就是一句普通的话。")).toBe("就是一句普通的话。");
  });
});
