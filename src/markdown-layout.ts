/**
 * Markdown token tree → satori element tree.
 *
 * Pure and dependency-free at runtime (`marked`'s types are `import type`, so
 * they erase): it takes the token list `marked.lexer()` produced and returns the
 * plain `{ type, props }` objects satori consumes. Keeping this separate from
 * `render.ts` means the whole layout can be unit-tested as data, with no fonts,
 * no WASM, and no dynamic imports involved.
 *
 * Two satori constraints shape everything below:
 *
 * 1. **Any element with more than one child MUST declare `display: flex`** (or
 *    `contents`/`none`) — satori throws otherwise. Every container built here
 *    therefore goes through `box()`, which always sets `display: flex`.
 * 2. **There is no inline formatting model.** satori has no `<span>` flow inside
 *    a text block, so a paragraph mixing plain text with bold/code runs is laid
 *    out as a `flexWrap: "wrap"` row whose items are the runs. Text wraps
 *    normally *inside* each run, and a run boundary is an extra wrap
 *    opportunity — which is why `pushText` merges adjacent plain strings rather
 *    than emitting one item per token.
 */

import type { Token, Tokens } from "marked";

// ── Element shape ───────────────────────────────────────────────────────

export type SatoriChild = string | SatoriNode;

export interface SatoriNode {
  type: string;
  props: { style?: Record<string, unknown>; children?: SatoriChild | SatoriChild[] };
}

// ── Theme ───────────────────────────────────────────────────────────────

export interface RenderTheme {
  background: string;
  text: string;
  heading: string;
  muted: string;
  accent: string;
  code: string;
  codeBackground: string;
  border: string;
}

export const LIGHT_THEME: RenderTheme = {
  background: "#ffffff",
  text: "#1f2328",
  heading: "#0d1117",
  muted: "#57606a",
  accent: "#0969da",
  code: "#b3355a",
  codeBackground: "#f2f4f7",
  border: "#d8dee4",
};

export const DARK_THEME: RenderTheme = {
  background: "#0d1117",
  text: "#e6edf3",
  heading: "#f0f6fc",
  muted: "#9198a1",
  accent: "#67aaf9",
  code: "#ff9492",
  codeBackground: "#1a2028",
  border: "#30363d",
};

export interface LayoutOptions {
  theme: RenderTheme;
  /** Base body font size in px; every other size is derived from it. */
  fontSize: number;
  /** The single family name registered with satori (see `render.ts`). */
  fontFamily: string;
}

/** Heading sizes as a multiple of the body size, indexed by `depth - 1`. */
const HEADING_SCALE = [1.55, 1.32, 1.16, 1.06, 1, 1];

// ── Element helpers ─────────────────────────────────────────────────────

function box(style: Record<string, unknown>, children?: SatoriChild[] | SatoriChild): SatoriNode {
  const kids = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return {
    type: "div",
    props: {
      // Always explicit — see constraint (1) in the module header.
      style: { display: "flex", ...style },
      // A single child is passed through unwrapped: satori treats a lone string
      // child as text content, which is what makes text wrapping work at all.
      children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids,
    },
  };
}

function span(style: Record<string, unknown>, text: string): SatoriNode {
  return { type: "span", props: { style, children: text } };
}

/** A wrapping row of inline runs — the closest thing satori has to a paragraph. */
function inlineRow(style: Record<string, unknown>, runs: SatoriChild[]): SatoriNode {
  return box({ flexWrap: "wrap", alignItems: "baseline", ...style }, runs);
}

// ── Inline tokens ───────────────────────────────────────────────────────

/** Collapse a token subtree to its plain text (used for runs that carry their own style). */
function plainText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) return fallback;
  let out = "";
  for (const token of tokens) {
    const t = token as { type?: string; text?: string; tokens?: Token[]; raw?: string };
    if (t.type === "br") {
      out += " ";
      continue;
    }
    if (t.type === "image") {
      out += "[图片]";
      continue;
    }
    out += t.tokens?.length ? plainText(t.tokens, t.text ?? "") : (t.text ?? "");
  }
  return out;
}

/** Strips tags from a raw HTML token so stray markup never reaches the image as literal `<div>`. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * One CJK glyph, one run of non-CJK non-space characters (a Latin word), or a
 * run of whitespace. Used to cut a text run into wrap-friendly pieces.
 */
const WRAP_CHUNK = /[⺀-鿿　-〿＀-￯]|[^\s⺀-鿿　-〿＀-￯]+|\s+/g;

/** Non-breaking space — satori trims ordinary edge whitespace off every flex item. */
const NBSP = " ";

/**
 * Split a plain text run into separate flex items so a line can be filled to
 * its full width.
 *
 * Only needed once a paragraph contains styled runs: satori lays each run out
 * as one flex item, so a long unsplit run that doesn't fit in what's left of
 * the current line jumps to the next one whole, leaving a visibly short line
 * behind. Splitting restores per-word (per-glyph, for CJK) wrapping.
 *
 * Whitespace is folded into the preceding piece as a non-breaking space,
 * because satori trims an item's leading/trailing whitespace — which is what
 * silently glued "围绕" to a following bold run. A break is still possible
 * there: it happens at the item boundary rather than inside the space.
 */
export function chunkForWrapping(text: string): string[] {
  const chunks: string[] = [];
  for (const match of text.match(WRAP_CHUNK) ?? []) {
    if (/^\s+$/.test(match)) {
      const spaces = NBSP.repeat(match.length);
      if (chunks.length === 0) chunks.push(spaces);
      else chunks[chunks.length - 1] += spaces;
      continue;
    }
    chunks.push(match);
  }
  return chunks;
}

/**
 * Flatten inline tokens into satori children. Adjacent plain text is merged
 * into one string so the renderer can wrap inside it; only genuinely styled
 * runs (bold, code, links) become separate items.
 */
export function buildInline(tokens: Token[] | undefined, opts: LayoutOptions): SatoriChild[] {
  const out: SatoriChild[] = [];
  let pending = "";

  const flush = (): void => {
    if (pending) {
      out.push(pending);
      pending = "";
    }
  };
  const pushText = (text: string): void => {
    pending += text;
  };

  for (const token of tokens ?? []) {
    const t = token as Tokens.Generic & { text?: string; tokens?: Token[]; href?: string };
    switch (t.type) {
      case "strong":
        flush();
        out.push(span({ fontWeight: 700, color: opts.theme.heading }, plainText(t.tokens, t.text ?? "")));
        break;
      case "codespan":
        flush();
        // Rendered as coloured text rather than a padded chip on purpose: a
        // chip is a rigid flex item, so a long one forces an early line break
        // and leaves a visibly short line above it.
        out.push(span({ color: opts.theme.code, fontSize: Math.round(opts.fontSize * 0.92) }, t.text ?? ""));
        break;
      case "del":
        flush();
        out.push(span({ textDecoration: "line-through", color: opts.theme.muted }, plainText(t.tokens, t.text ?? "")));
        break;
      case "link": {
        flush();
        const label = plainText(t.tokens, t.text ?? "");
        // A bare URL used as its own label is already visible; only append the
        // target when the label is different text (the href would be lost
        // otherwise, since an image has nothing to click).
        const href = typeof t.href === "string" ? t.href : "";
        out.push(span({ color: opts.theme.accent }, label));
        if (href && href !== label) out.push(span({ color: opts.theme.muted, fontSize: Math.round(opts.fontSize * 0.85) }, ` (${href})`));
        break;
      }
      case "image":
        // Remote images would need satori's `loadAdditionalAsset` plus a network
        // fetch on the gateway; a placeholder keeps rendering hermetic.
        pushText("[图片]");
        break;
      case "br":
        // satori has no <br> inside a wrapping row; a space is the closest
        // thing that keeps the surrounding text flowing.
        pushText(" ");
        break;
      case "html":
        pushText(stripTags(t.text ?? ""));
        break;
      case "em":
        // No italic face is registered (see `render.ts`), so italic would
        // silently render as regular anyway — emit it as plain text and let the
        // words carry the emphasis.
        pushText(plainText(t.tokens, t.text ?? ""));
        break;
      default:
        pushText(t.tokens?.length ? plainText(t.tokens, t.text ?? "") : (t.text ?? ""));
        break;
    }
  }

  flush();

  // A paragraph of pure text is left as a single run: satori wraps inside it
  // perfectly, and one item is far cheaper than hundreds. The moment styled
  // runs are in play, the plain text around them has to be splittable — see
  // `chunkForWrapping`.
  if (!out.some((run) => typeof run !== "string")) return out;

  return layOutMixedRuns(out);
}

/**
 * Turn a mixed run list (plain strings + styled nodes) into flex items whose
 * inter-run gaps always sit at the END of the earlier item.
 *
 * That placement is the whole point: a gap rendered at the *start* of an item
 * shows up as a stray indent whenever the line happens to wrap there, while a
 * gap at the end of an item is invisible at a line break — the same reason
 * browsers collapse trailing spaces. So a run's leading whitespace is handed
 * backwards: onto the previous span as a right margin, or onto the previous
 * string as a trailing non-breaking space.
 */
function layOutMixedRuns(runs: SatoriChild[]): SatoriChild[] {
  const out: SatoriChild[] = [];

  /** Hand `width` worth of gap to whatever was emitted last; drop it at the very start. */
  const pushGapBackwards = (spaces: number): void => {
    const previous = out[out.length - 1];
    if (previous === undefined) return;
    if (typeof previous === "string") {
      out[out.length - 1] = previous + NBSP.repeat(spaces);
      return;
    }
    const style = (previous.props.style ?? {}) as Record<string, unknown>;
    style.marginRight = `${(spaces * 0.3).toFixed(2)}em`;
    previous.props.style = style;
  };

  for (const run of runs) {
    if (typeof run !== "string") {
      out.push(run);
      continue;
    }

    const leading = /^\s*/.exec(run)![0];
    if (leading) pushGapBackwards(leading.length);

    // Trailing whitespace stays inside this run (as NBSP, via chunkForWrapping),
    // which already puts it at the end of an item.
    const rest = run.slice(leading.length);
    if (rest) out.push(...chunkForWrapping(rest));
  }

  return out;
}

// ── Block tokens ────────────────────────────────────────────────────────

function heading(token: Tokens.Heading, opts: LayoutOptions): SatoriNode {
  const scale = HEADING_SCALE[Math.min(Math.max(token.depth, 1), 6) - 1] ?? 1;
  const size = Math.round(opts.fontSize * scale);
  return inlineRow(
    {
      fontSize: size,
      fontWeight: 700,
      color: opts.theme.heading,
      marginTop: Math.round(opts.fontSize * 0.6),
      marginBottom: Math.round(opts.fontSize * 0.3),
    },
    buildInline(token.tokens, opts),
  );
}

function codeBlock(token: Tokens.Code, opts: LayoutOptions): SatoriNode {
  const size = Math.round(opts.fontSize * 0.85);
  const lines = (token.text ?? "").replace(/\s+$/, "").split("\n");
  return box(
    {
      flexDirection: "column",
      backgroundColor: opts.theme.codeBackground,
      borderRadius: 10,
      padding: Math.round(opts.fontSize * 0.6),
      marginTop: Math.round(opts.fontSize * 0.2),
      marginBottom: Math.round(opts.fontSize * 0.45),
      fontSize: size,
      color: opts.theme.text,
    },
    // One row per source line so indentation and line breaks survive; the empty
    // string would collapse the row, hence the zero-width space.
    lines.map((line) => box({ lineHeight: 1.5 }, line.length > 0 ? line : "​")),
  );
}

/**
 * A task-list checkbox drawn as a bordered square rather than written with
 * `☐`/`☑`: those live in a Unicode block most CJK fonts do not cover, and
 * satori renders a missing glyph as nothing at all — the marker column just
 * came out empty. A box needs no glyph, so it looks the same under any font.
 */
function checkbox(checked: boolean, opts: LayoutOptions): SatoriNode {
  const size = Math.round(opts.fontSize * 0.62);
  return box({
    width: size,
    height: size,
    marginTop: Math.round(opts.fontSize * 0.5),
    borderRadius: 4,
    border: `2px solid ${checked ? opts.theme.accent : opts.theme.border}`,
    backgroundColor: checked ? opts.theme.accent : "transparent",
  });
}

function listMarker(
  token: Tokens.List,
  item: Tokens.ListItem,
  index: number,
  opts: LayoutOptions,
): SatoriChild {
  if (item.task) return checkbox(item.checked === true, opts);
  // "•" is U+2022 (General Punctuation) — reliably present in the CJK fonts
  // this plugin probes for, unlike the ballot-box characters above.
  if (!token.ordered) return "•";
  const start = typeof token.start === "number" && Number.isFinite(token.start) ? token.start : 1;
  return `${start + index}.`;
}

function list(token: Tokens.List, opts: LayoutOptions, depth: number): SatoriNode {
  const markerWidth = Math.round(opts.fontSize * (token.ordered ? 1.5 : 1.1));
  const rows = token.items.map((item, index) => {
    // A list item mixes inline content with nested blocks (most often a nested
    // list); the inline part becomes the first line, blocks stack under it.
    const inlineTokens: Token[] = [];
    const blockTokens: Token[] = [];
    for (const child of item.tokens ?? []) {
      if (child.type === "text" || child.type === "paragraph") inlineTokens.push(...(((child as Tokens.Text).tokens as Token[]) ?? [child]));
      else blockTokens.push(child);
    }

    const content: SatoriChild[] = [inlineRow({ flexGrow: 1 }, buildInline(inlineTokens, opts))];
    if (blockTokens.length > 0) {
      content.push(box({ flexDirection: "column", width: "100%" }, buildBlocks(blockTokens, opts, depth + 1)));
    }

    return box({ flexDirection: "row", marginBottom: Math.round(opts.fontSize * 0.18), width: "100%" }, [
      box({ width: markerWidth, flexShrink: 0, color: opts.theme.muted }, listMarker(token, item, index, opts)),
      box({ flexDirection: "column", flexGrow: 1 }, content),
    ]);
  });

  return box(
    {
      flexDirection: "column",
      marginBottom: Math.round(opts.fontSize * 0.3),
      marginLeft: depth > 0 ? Math.round(opts.fontSize * 0.5) : 0,
      width: "100%",
    },
    rows,
  );
}

function blockquote(token: Tokens.Blockquote, opts: LayoutOptions, depth: number): SatoriNode {
  return box(
    {
      flexDirection: "row",
      borderLeft: `5px solid ${opts.theme.border}`,
      paddingLeft: Math.round(opts.fontSize * 0.6),
      marginBottom: Math.round(opts.fontSize * 0.45),
      color: opts.theme.muted,
      width: "100%",
    },
    box({ flexDirection: "column", flexGrow: 1 }, buildBlocks(token.tokens ?? [], opts, depth + 1)),
  );
}

function table(token: Tokens.Table, opts: LayoutOptions): SatoriNode {
  const size = Math.round(opts.fontSize * 0.9);
  const cell = (text: SatoriChild[], header: boolean): SatoriNode =>
    inlineRow(
      {
        flexGrow: 1,
        flexBasis: 0,
        padding: Math.round(opts.fontSize * 0.3),
        fontWeight: header ? 700 : 400,
        color: header ? opts.theme.heading : opts.theme.text,
      },
      text,
    );

  const row = (cells: SatoriNode[], last: boolean): SatoriNode =>
    box(
      {
        flexDirection: "row",
        width: "100%",
        borderBottom: last ? "none" : `1px solid ${opts.theme.border}`,
      },
      cells,
    );

  const header = row(token.header.map((c) => cell(buildInline(c.tokens, opts), true)), token.rows.length === 0);
  const body = token.rows.map((cells, i) =>
    row(cells.map((c) => cell(buildInline(c.tokens, opts), false)), i === token.rows.length - 1),
  );

  return box(
    {
      flexDirection: "column",
      width: "100%",
      fontSize: size,
      border: `1px solid ${opts.theme.border}`,
      borderRadius: 8,
      marginBottom: Math.round(opts.fontSize * 0.45),
    },
    [header, ...body],
  );
}

/** Render a list of block-level tokens into stacked satori elements. */
export function buildBlocks(tokens: Token[], opts: LayoutOptions, depth = 0): SatoriNode[] {
  const out: SatoriNode[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out.push(heading(token as Tokens.Heading, opts));
        break;
      case "paragraph":
        out.push(
          inlineRow(
            { marginBottom: Math.round(opts.fontSize * 0.45), width: "100%" },
            buildInline((token as Tokens.Paragraph).tokens, opts),
          ),
        );
        break;
      case "code":
        out.push(codeBlock(token as Tokens.Code, opts));
        break;
      case "list":
        out.push(list(token as Tokens.List, opts, depth));
        break;
      case "blockquote":
        out.push(blockquote(token as Tokens.Blockquote, opts, depth));
        break;
      case "hr":
        out.push(
          box({
            width: "100%",
            height: 2,
            backgroundColor: opts.theme.border,
            marginTop: Math.round(opts.fontSize * 0.4),
            marginBottom: Math.round(opts.fontSize * 0.6),
          }),
        );
        break;
      case "table":
        out.push(table(token as Tokens.Table, opts));
        break;
      case "html": {
        const text = stripTags((token as Tokens.HTML).text ?? "");
        if (text) out.push(inlineRow({ marginBottom: Math.round(opts.fontSize * 0.45) }, [text]));
        break;
      }
      case "space":
        break;
      default: {
        // `text` at block level (and anything a future marked version adds)
        // still carries readable content — never drop it silently.
        const runs = buildInline(
          ((token as Tokens.Text).tokens as Token[] | undefined) ?? [token],
          opts,
        );
        if (runs.length > 0) {
          out.push(inlineRow({ marginBottom: Math.round(opts.fontSize * 0.3), width: "100%" }, runs));
        }
        break;
      }
    }
  }

  return out;
}

/**
 * Wrap the rendered blocks in the page container satori renders at `width`.
 * Height is intentionally left unset — satori grows the document to fit, which
 * is what makes a summary of any length come out as one correctly sized image.
 */
export function buildDocument(tokens: Token[], opts: LayoutOptions): SatoriNode {
  const blocks = buildBlocks(tokens, opts);
  return box(
    {
      flexDirection: "column",
      width: "100%",
      padding: Math.round(opts.fontSize * 1.4),
      backgroundColor: opts.theme.background,
      color: opts.theme.text,
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      lineHeight: 1.75,
    },
    // A completely empty document would collapse to a zero-height image.
    blocks.length > 0 ? blocks : [box({}, "​")],
  );
}
