/**
 * Markdown → plain text for QQ.
 *
 * QQ renders nothing: a reply goes out as literal characters, so an agent's
 * `## 今日总结` / `**周四**` / `- 待办` arrives with all its syntax showing. This
 * module flattens that markup into text that reads correctly in a chat bubble —
 * headings become bracketed lines, bullets become `•`, emphasis markers are
 * dropped while their words stay, and link targets are kept in parentheses
 * because a QQ message has nothing to click.
 *
 * Deliberately hand-rolled and dependency-free: it runs inside the plugin entry
 * graphs, where a bare runtime import is forbidden (see CLAUDE.md), and the
 * subset of Markdown an agent actually emits is small enough that a parser
 * would be more risk than help. Every rule is line-oriented and total — unknown
 * or malformed markup falls through as its own text rather than being dropped.
 */

/** Inline markers stripped in place, leaving the words they wrapped. */
function stripInline(text: string): string {
  return (
    text
      // Links/images: keep the label, keep the target only when it adds
      // something (a bare URL used as its own label would be duplicated).
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
        label.trim() ? `[图片:${label.trim()}]` : "[图片]",
      )
      .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
        const text = label.trim();
        if (!text) return url;
        return text === url ? text : `${text}（${url}）`;
      })
      // Emphasis. Bold before italic so `***x***` degrades cleanly, and the
      // inner group is non-greedy so `**a** 和 **b**` keeps its middle text.
      .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1$2")
      .replace(/___(.+?)___/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
      // Inline code: the backticks carry no meaning once the font is fixed.
      .replace(/`([^`]+)`/g, "$1")
  );
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*(?:[-*_]\s*){3,}$/;
const FENCE = /^\s*(?:```|~~~)(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** Collapses 3+ blank lines to one, and trims the whole message. */
function tidy(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Flatten a Markdown reply into chat-readable plain text.
 *
 * Never throws and never drops content: anything it does not recognise is
 * passed through verbatim.
 */
export function markdownToText(markdown: string): string {
  if (!markdown.trim()) return "";

  const out: string[] = [];
  let inFence = false;

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fence = FENCE.exec(raw);
    if (fence) {
      // Fence lines themselves vanish; the code between them is emitted as-is,
      // since indentation and symbols are the point of a code block.
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    if (HR.test(raw)) {
      out.push("————————");
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      const text = stripInline(heading[2]!).trim();
      if (text) {
        // A blank line above every heading keeps sections apart in one bubble.
        if (out.length > 0 && out[out.length - 1] !== "") out.push("");
        out.push(`【${text}】`);
      }
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      const text = stripInline(quote[1]!).trim();
      out.push(text ? `｜ ${text}` : "｜");
      continue;
    }

    const ordered = ORDERED.exec(raw);
    if (ordered) {
      const indent = " ".repeat(Math.floor(ordered[1]!.length / 2) * 2);
      out.push(`${indent}${ordered[2]}. ${renderItem(ordered[3]!)}`);
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      // Nested levels keep their relative indent but switch marker so the
      // depth is still visible without any renderer.
      const depth = Math.floor(bullet[1]!.length / 2);
      const marker = depth === 0 ? "•" : depth === 1 ? "◦" : "·";
      out.push(`${"  ".repeat(depth)}${marker} ${renderItem(bullet[2]!)}`);
      continue;
    }

    out.push(stripInline(raw));
  }

  return tidy(out);
}

/** A list item's own text, with a task-list checkbox turned into a symbol. */
function renderItem(text: string): string {
  const task = TASK.exec(text.trim());
  if (task) {
    const done = task[1]!.toLowerCase() === "x";
    return `${done ? "✅" : "⬜"} ${stripInline(task[2]!).trim()}`;
  }
  return stripInline(text).trim();
}
