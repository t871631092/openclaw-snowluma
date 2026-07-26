/**
 * Markdown → satori element tree.
 *
 * `marked` is imported statically here on purpose: the no-static-bare-import
 * rule applies to the plugin's entry graphs (see load-graph.test.ts), not to
 * tests, and lexing real Markdown is the whole point — hand-written token
 * fixtures would drift from what marked actually emits.
 */
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import {
  buildDocument,
  buildInline,
  chunkForWrapping,
  DARK_THEME,
  LIGHT_THEME,
  type LayoutOptions,
  type SatoriChild,
  type SatoriNode,
} from "../src/markdown-layout.js";

const opts: LayoutOptions = { theme: LIGHT_THEME, fontSize: 26, fontFamily: "TestFont" };

function lex(md: string) {
  return marked.lexer(md);
}

function doc(md: string): SatoriNode {
  return buildDocument(lex(md), opts);
}

function childrenOf(node: SatoriNode): SatoriChild[] {
  const kids = node.props.children;
  if (kids === undefined) return [];
  return Array.isArray(kids) ? kids : [kids];
}

function isNode(child: SatoriChild): child is SatoriNode {
  return typeof child !== "string";
}

/** Every string anywhere in the tree, in document order. */
function allText(node: SatoriChild): string {
  if (!isNode(node)) return node;
  return childrenOf(node).map(allText).join("");
}

function walk(node: SatoriChild, visit: (n: SatoriNode) => void): void {
  if (!isNode(node)) return;
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

/** Find the first node whose style matches a predicate. */
function findNode(root: SatoriNode, match: (n: SatoriNode) => boolean): SatoriNode | undefined {
  let found: SatoriNode | undefined;
  walk(root, (n) => {
    if (!found && match(n)) found = n;
  });
  return found;
}

const styleOf = (n: SatoriNode): Record<string, unknown> => (n.props.style ?? {}) as Record<string, unknown>;

// ── The satori invariant ────────────────────────────────────────────────

describe("satori structural invariant", () => {
  const SAMPLE = [
    "# 标题一",
    "",
    "普通段落，带 **加粗**、`代码` 和 [链接](https://example.com)。",
    "",
    "- 列表项一",
    "- 列表项二",
    "  - 嵌套项",
    "",
    "1. 有序一",
    "2. 有序二",
    "",
    "- [ ] 待办",
    "- [x] 已完成",
    "",
    "> 引用内容",
    "",
    "```js",
    "const a = 1;",
    "",
    "console.log(a);",
    "```",
    "",
    "| 列 A | 列 B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "---",
    "",
    "结尾段落。",
  ].join("\n");

  it("gives every multi-child element an explicit display (satori throws otherwise)", () => {
    const allowed = new Set(["flex", "contents", "none"]);
    const offenders: string[] = [];

    walk(doc(SAMPLE), (node) => {
      if (childrenOf(node).length > 1 && !allowed.has(String(styleOf(node).display))) {
        offenders.push(`${node.type} display=${String(styleOf(node).display)}`);
      }
    });

    expect(offenders).toEqual([]);
  });

  it("never emits an element type satori cannot lay out", () => {
    const types = new Set<string>();
    walk(doc(SAMPLE), (n) => types.add(n.type));
    expect([...types].sort()).toEqual(["div", "span"]);
  });

  it("keeps every piece of source text somewhere in the tree", () => {
    const text = allText(doc(SAMPLE));
    for (const fragment of ["标题一", "加粗", "代码", "列表项一", "嵌套项", "有序二", "引用内容", "console.log(a);", "列 A", "结尾段落"]) {
      expect(text, `missing ${fragment}`).toContain(fragment);
    }
  });
});

// ── Inline runs ─────────────────────────────────────────────────────────

describe("buildInline", () => {
  const inlineOf = (md: string): SatoriChild[] => {
    const token = lex(md)[0] as { tokens?: never };
    return buildInline(token.tokens, opts);
  };

  it("merges adjacent plain text into one run so wrapping is not fragmented", () => {
    const runs = inlineOf("一段没有任何标记的中文文字，应该只产生一个字符串。");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe("一段没有任何标记的中文文字，应该只产生一个字符串。");
  });

  it("emits bold as a 700-weight span", () => {
    const runs = inlineOf("前面 **重点** 后面");
    const bold = runs.find((r) => isNode(r) && styleOf(r).fontWeight === 700);
    expect(bold && allText(bold)).toBe("重点");
    // Text either side survives (now split into wrap-friendly pieces).
    expect(runs.map(allText).join("")).toContain("前面");
    expect(runs.map(allText).join("")).toContain("后面");
  });

  it("colours inline code instead of boxing it", () => {
    const runs = inlineOf("运行 `npm test` 即可");
    const code = runs.find((r) => isNode(r) && styleOf(r).color === LIGHT_THEME.code);
    expect(code && allText(code)).toBe("npm test");
    // A padded chip would be a rigid flex item that breaks the line early.
    expect(code && styleOf(code as SatoriNode).padding).toBeUndefined();
  });

  it("renders a link label in the accent colour and appends a differing href", () => {
    const runs = inlineOf("见 [文档](https://example.com/doc)");
    expect(allText({ type: "div", props: { children: runs } })).toContain("文档");
    expect(allText({ type: "div", props: { children: runs } })).toContain("https://example.com/doc");
  });

  it("does not repeat the href when the label already is the url", () => {
    const text = allText({ type: "div", props: { children: inlineOf("<https://example.com>") } });
    expect(text.match(/https:\/\/example\.com/g)).toHaveLength(1);
  });

  it("renders strikethrough with a line-through decoration", () => {
    const runs = inlineOf("~~作废~~");
    const del = runs.find((r) => isNode(r) && styleOf(r).textDecoration === "line-through");
    expect(del && allText(del)).toBe("作废");
  });

  it("replaces an image with a placeholder rather than fetching it", () => {
    const text = allText({ type: "div", props: { children: inlineOf("![图](https://example.com/a.png)") } });
    expect(text).toContain("[图片]");
    expect(text).not.toContain("https://example.com/a.png");
  });

  it("flattens italics to plain text (no italic face is registered)", () => {
    const runs = inlineOf("*斜体* 文本");
    expect(runs.every((r) => typeof r === "string")).toBe(true);
    expect(runs.join("")).toBe("斜体 文本");
  });

  it("strips raw html tags", () => {
    const runs = inlineOf("前 <b>中</b> 后");
    expect(runs.join("")).not.toContain("<b>");
    expect(runs.join("")).toContain("中");
  });
});

// ── Wrapping and inter-run gaps ─────────────────────────────────────────
//
// satori lays every run out as a flex item and trims each item's edge
// whitespace, which caused two visible defects before this logic existed:
// spaces vanished around bold/code runs ("围绕v0.3.0"), and a long unsplit run
// jumped to the next line whole, leaving a short line behind.

describe("chunkForWrapping", () => {
  it("splits CJK per glyph and keeps Latin words intact", () => {
    expect(chunkForWrapping("中文abc def")).toEqual(["中", "文", "abc ", "def"]);
  });

  it("folds whitespace into the preceding chunk as a non-breaking space", () => {
    // A plain space would be trimmed off the flex item and disappear.
    expect(chunkForWrapping("a b")).toEqual(["a ", "b"]);
    expect(chunkForWrapping("尾部 ")).toEqual(["尾", "部 "]);
  });

  it("keeps every character of the input", () => {
    const text = "会议定在 周四 下午three点。";
    expect(chunkForWrapping(text).join("").replace(/ /g, " ")).toBe(text);
  });
});

describe("inline gaps", () => {
  const inlineOf = (md: string): SatoriChild[] => {
    const token = lex(md)[0] as { tokens?: never };
    return buildInline(token.tokens, opts);
  };

  it("preserves the space between text and a following bold run", () => {
    const runs = inlineOf("今天围绕 **发版** 展开讨论");
    // The gap before the bold run survives as a trailing NBSP on the text.
    const beforeBold = runs.slice(0, runs.findIndex((r) => isNode(r)));
    expect((beforeBold.at(-1) as string).endsWith(" ")).toBe(true);
  });

  it("puts the gap after a styled run on the span itself, never on the next item", () => {
    const runs = inlineOf("围绕 **发版** 展开讨论");
    const bold = runs.find((r) => isNode(r) && styleOf(r).fontWeight === 700) as SatoriNode;
    // A gap rendered at the START of the following item shows up as a stray
    // indent whenever the line wraps there; as a right margin it is invisible.
    expect(styleOf(bold).marginRight).toBeDefined();
    const afterBold = runs[runs.indexOf(bold) + 1] as string;
    expect(afterBold.startsWith(" ")).toBe(false);
  });

  it("drops a leading gap when there is nothing to hang it on", () => {
    const runs = inlineOf("**开头加粗** 后续");
    expect(typeof runs[0]).not.toBe("string");
  });

  it("leaves a markup-free paragraph as a single unsplit run", () => {
    // Cheaper, and satori's own wrapping inside one item is already optimal.
    expect(inlineOf("完全没有标记的一段中文文字")).toHaveLength(1);
  });
});

// ── Blocks ──────────────────────────────────────────────────────────────

describe("block layout", () => {
  it("scales headings by depth and makes them bold", () => {
    const h1 = findNode(doc("# 一级"), (n) => styleOf(n).fontWeight === 700 && typeof styleOf(n).fontSize === "number");
    const h3 = findNode(doc("### 三级"), (n) => styleOf(n).fontWeight === 700 && typeof styleOf(n).fontSize === "number");
    expect(Number(styleOf(h1!).fontSize)).toBeGreaterThan(opts.fontSize);
    expect(Number(styleOf(h1!).fontSize)).toBeGreaterThan(Number(styleOf(h3!).fontSize));
  });

  it("renders a code block as one row per source line, blank lines included", () => {
    const block = findNode(doc("```\na\n\nb\n```"), (n) => styleOf(n).backgroundColor === LIGHT_THEME.codeBackground);
    expect(block).toBeDefined();
    expect(childrenOf(block!)).toHaveLength(3);
    expect(allText(childrenOf(block!)[0]!)).toBe("a");
    expect(allText(childrenOf(block!)[2]!)).toBe("b");
  });

  it("numbers an ordered list from its start value", () => {
    const text = allText(doc("3. 三\n4. 四"));
    expect(text).toContain("3.");
    expect(text).toContain("4.");
  });

  it("uses a bullet for unordered lists", () => {
    expect(allText(doc("- 项"))).toContain("•");
  });

  it("draws task-list checkboxes as bordered boxes, not as glyphs", () => {
    // ☐/☑ (U+2610/2611) are absent from most CJK fonts, and satori renders a
    // missing glyph as nothing at all — so the marker must not be a character.
    const todo = doc("- [ ] 待办");
    const done = doc("- [x] 完成");

    expect(allText(todo)).not.toMatch(/[☐☑]/);
    expect(allText(done)).not.toMatch(/[☐☑]/);

    const todoBox = findNode(todo, (n) => typeof styleOf(n).border === "string" && styleOf(n).height !== undefined);
    const doneBox = findNode(done, (n) => typeof styleOf(n).border === "string" && styleOf(n).height !== undefined);
    expect(todoBox).toBeDefined();
    expect(doneBox).toBeDefined();
    // Checked reads as filled, unchecked as an outline.
    expect(styleOf(todoBox!).backgroundColor).toBe("transparent");
    expect(styleOf(doneBox!).backgroundColor).toBe(LIGHT_THEME.accent);
  });

  it("indents a nested list", () => {
    const nested = findNode(doc("- 外层\n  - 内层"), (n) => Number(styleOf(n).marginLeft) > 0);
    expect(nested).toBeDefined();
    expect(allText(nested!)).toContain("内层");
  });

  it("gives a blockquote a left border in the theme colour", () => {
    const quote = findNode(doc("> 引用"), (n) => String(styleOf(n).borderLeft).includes(LIGHT_THEME.border));
    expect(quote).toBeDefined();
    expect(allText(quote!)).toContain("引用");
  });

  it("renders a table with a bold header row", () => {
    const table = doc("| A | B |\n|---|---|\n| 1 | 2 |");
    const header = findNode(table, (n) => styleOf(n).fontWeight === 700);
    expect(header).toBeDefined();
    expect(allText(table)).toContain("1");
    expect(allText(table)).toContain("2");
  });

  it("renders a horizontal rule as a filled bar", () => {
    const hr = findNode(doc("---"), (n) => styleOf(n).height === 2);
    expect(hr).toBeDefined();
  });

  it("does not collapse to a zero-height document when there is nothing to render", () => {
    const empty = buildDocument([], opts);
    expect(childrenOf(empty).length).toBeGreaterThan(0);
  });
});

// ── Document container ──────────────────────────────────────────────────

describe("buildDocument", () => {
  it("applies the requested font family, size and light theme colours", () => {
    const style = styleOf(doc("正文"));
    expect(style.fontFamily).toBe("TestFont");
    expect(style.fontSize).toBe(26);
    expect(style.backgroundColor).toBe(LIGHT_THEME.background);
    expect(style.color).toBe(LIGHT_THEME.text);
    expect(style.flexDirection).toBe("column");
  });

  it("applies dark-theme colours when asked", () => {
    const style = styleOf(buildDocument(lex("正文"), { ...opts, theme: DARK_THEME }));
    expect(style.backgroundColor).toBe(DARK_THEME.background);
    expect(style.color).toBe(DARK_THEME.text);
  });

  it("leaves height unset so satori grows the image to fit the content", () => {
    expect(styleOf(doc("很长的总结内容")).height).toBeUndefined();
  });
});
