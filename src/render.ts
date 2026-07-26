/**
 * Markdown → PNG rendering for summarisation replies.
 *
 * The pipeline is `marked.lexer()` → `markdown-layout.ts` → satori (→ SVG) →
 * `@resvg/resvg-wasm` (→ PNG). All three packages are **dynamically imported**,
 * exactly like `@snowluma/sdk` in `sdk.ts`, because neither plugin entry graph
 * may carry a static bare import (see the hard constraints in CLAUDE.md and
 * `test/load-graph.test.ts`). They were picked precisely because they survive
 * OpenClaw's `npm install --ignore-scripts`: all three are pure JS/WASM with no
 * install hooks and no native binaries to download.
 *
 * satori renders glyphs as `<path>` outlines (`embedFont` defaults to true), so
 * the rasterizer needs no fonts at all — only satori itself does, and it gets a
 * font buffer this module resolves from config or from a per-platform probe.
 * That is what makes the output byte-identical on a Windows dev box and a
 * font-less Linux container: if a usable font is found the image renders, and
 * if none is, `renderMarkdownToPng` returns null and the caller sends text.
 *
 * NOTHING here throws: every failure mode (packages absent, no font, malformed
 * markdown, rasterizer error) comes back as `null`.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildDocument, DARK_THEME, LIGHT_THEME } from "./markdown-layout.js";
import type { ResolvedRenderConfig } from "./types.js";

export interface RenderLogger {
  info?(m: string): void;
  error?(m: string): void;
  debug?(m: string): void;
}

/** The family name registered with satori; `markdown-layout` refers to it by this name. */
const FONT_FAMILY = "SnowLumaCJK";

// ── Font discovery ──────────────────────────────────────────────────────
//
// A summary is Chinese text, so a Latin-only font is worse than useless — it
// renders every glyph as tofu. These are the fonts that actually ship with each
// platform (or with the fonts-noto-cjk / wqy packages a Chinese-locale
// container usually installs); the first one that satori can parse wins.

interface FontCandidates {
  regular: string[];
  bold: string[];
}

const FONT_CANDIDATES: Record<string, FontCandidates> = {
  win32: {
    regular: [
      "C:/Windows/Fonts/Deng.ttf",
      "C:/Windows/Fonts/simhei.ttf",
      "C:/Windows/Fonts/msyh.ttc",
      "C:/Windows/Fonts/simsun.ttc",
    ],
    bold: ["C:/Windows/Fonts/Dengb.ttf", "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf"],
  },
  linux: {
    regular: [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
      "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
      "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
      "/usr/share/fonts/truetype/arphic/uming.ttc",
    ],
    bold: [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansSC-Bold.otf",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    ],
  },
  darwin: {
    regular: [
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/STHeiti Light.ttc",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      "/Library/Fonts/Arial Unicode.ttf",
    ],
    bold: ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"],
  },
};

function candidatesFor(platform: string): FontCandidates {
  return FONT_CANDIDATES[platform] ?? { regular: [], bold: [] };
}

// ── Lazy module + font cache ────────────────────────────────────────────

interface RenderModules {
  satori: (element: unknown, options: unknown) => Promise<string>;
  Resvg: new (svg: string, options?: unknown) => { render(): { asPng(): Uint8Array } };
  lex: (markdown: string) => unknown[];
}

interface LoadedFonts {
  regular: Uint8Array;
  bold?: Uint8Array;
  /** Where `regular` came from — logged once so operators can see which font is in use. */
  source: string;
}

/** Injectable seams; tests replace these instead of installing fonts or touching the real packages. */
export interface RenderDeps {
  loadModules?: () => Promise<RenderModules>;
  readFontFile?: (path: string) => Promise<Uint8Array>;
  platform?: string;
}

let modulesPromise: Promise<RenderModules> | null = null;
let fontsCache: { key: string; fonts: LoadedFonts | null } | null = null;
let loadWarned = false;

/** Test hook: drop every cached module/font so the next render re-resolves from scratch. */
export function __resetRenderCache(): void {
  modulesPromise = null;
  fontsCache = null;
  loadWarned = false;
}

/** `index_bg.wasm` is an explicit export of the package, with a path fallback for older layouts. */
function resolveWasmPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@resvg/resvg-wasm/index_bg.wasm");
  } catch {
    return join(dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm");
  }
}

async function defaultLoadModules(): Promise<RenderModules> {
  const [satoriMod, resvgMod, markedMod] = await Promise.all([
    import("satori"),
    import("@resvg/resvg-wasm"),
    import("marked"),
  ]);

  // `initWasm` rejects if called twice, so it happens exactly once here — inside
  // the memoised `modulesPromise` — rather than per render.
  await resvgMod.initWasm(await readFile(resolveWasmPath()));

  const satoriFn = (satoriMod as { default?: unknown }).default ?? satoriMod;
  return {
    satori: satoriFn as RenderModules["satori"],
    Resvg: resvgMod.Resvg as unknown as RenderModules["Resvg"],
    lex: (markdown: string) => markedMod.marked.lexer(markdown) as unknown[],
  };
}

function loadModules(deps: RenderDeps): Promise<RenderModules> {
  const load = deps.loadModules ?? defaultLoadModules;
  if (!modulesPromise) {
    modulesPromise = load().catch((err: unknown) => {
      // Reset so a later attempt can retry (a missing package will simply fail
      // again; a transient error — EMFILE, a slow mount — will not be sticky).
      modulesPromise = null;
      throw err;
    });
  }
  return modulesPromise;
}

/**
 * Load the first candidate font satori can actually parse. `.ttc` collections
 * are hit and miss depending on the font, so a candidate is only accepted after
 * a real (tiny) probe render succeeds — a font that would blow up on the first
 * summary is rejected here instead.
 */
async function resolveFonts(
  modules: RenderModules,
  cfg: ResolvedRenderConfig,
  deps: RenderDeps,
  log?: RenderLogger,
): Promise<LoadedFonts | null> {
  const key = `${cfg.fontPath}|${cfg.boldFontPath}|${deps.platform ?? process.platform}`;
  if (fontsCache && fontsCache.key === key) return fontsCache.fonts;

  const readFontFile = deps.readFontFile ?? ((path: string) => readFile(path));
  const platform = deps.platform ?? process.platform;
  const candidates = candidatesFor(platform);

  // An explicit fontPath is a promise from the operator, not a suggestion: it is
  // tried first, and a failure is logged loudly rather than silently skipped.
  const regularPaths = cfg.fontPath ? [cfg.fontPath, ...candidates.regular] : candidates.regular;

  let fonts: LoadedFonts | null = null;
  for (const path of regularPaths) {
    let data: Uint8Array;
    try {
      data = await readFontFile(path);
    } catch {
      if (path === cfg.fontPath) log?.error?.(`[snowluma:render] configured fontPath is unreadable: ${path}`);
      continue;
    }
    try {
      await modules.satori({ type: "div", props: { style: { display: "flex" }, children: "测A" } }, {
        width: 32,
        fonts: [{ name: FONT_FAMILY, data, weight: 400, style: "normal" }],
      });
    } catch (err) {
      log?.debug?.(`[snowluma:render] font rejected by satori (${path}): ${String(err)}`);
      continue;
    }
    fonts = { regular: data, source: path };
    break;
  }

  if (fonts) {
    // Bold is optional: satori does not synthesise weight, so without a 700 face
    // **bold** simply renders at regular weight — worth having, never worth failing over.
    const boldPaths = cfg.boldFontPath ? [cfg.boldFontPath, ...candidates.bold] : candidates.bold;
    for (const path of boldPaths) {
      try {
        fonts.bold = await readFontFile(path);
        break;
      } catch {
        // try the next one
      }
    }
    log?.info?.(
      `[snowluma:render] using font ${fonts.source}${fonts.bold ? " (+ bold face)" : " (no bold face — bold text renders at regular weight)"}`,
    );
  }

  fontsCache = { key, fonts };
  return fonts;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Render `markdown` to a PNG. Returns `null` — never throws — whenever the
 * image cannot be produced, which is the caller's signal to send text instead.
 */
export async function renderMarkdownToPng(
  markdown: string,
  cfg: ResolvedRenderConfig,
  log?: RenderLogger,
  deps: RenderDeps = {},
): Promise<Uint8Array | null> {
  if (!markdown.trim()) return null;
  if (markdown.length > cfg.maxChars) {
    log?.info?.(
      `[snowluma:render] reply is ${markdown.length} chars (> maxChars ${cfg.maxChars}) — sending as text instead`,
    );
    return null;
  }

  let modules: RenderModules;
  try {
    modules = await loadModules(deps);
  } catch (err) {
    // The packages are optional in practice: an install that predates this
    // feature simply has no satori/resvg next to the plugin. Say so once, then
    // stay quiet — every summary would otherwise repeat it.
    if (!loadWarned) {
      loadWarned = true;
      log?.error?.(
        `[snowluma:render] image rendering unavailable (${String(err)}) — replies will be sent as text. ` +
          "Reinstall the plugin so satori / @resvg/resvg-wasm / marked are present.",
      );
    } else {
      log?.debug?.(`[snowluma:render] render stack still unavailable: ${String(err)}`);
    }
    return null;
  }

  try {
    const fonts = await resolveFonts(modules, cfg, deps, log);
    if (!fonts) {
      log?.error?.(
        "[snowluma:render] no usable font found — sending text instead. " +
          "Set channels.snowluma.render.fontPath to a .ttf/.otf, or install a CJK font (e.g. fonts-noto-cjk).",
      );
      return null;
    }

    const element = buildDocument(modules.lex(markdown) as never, {
      theme: cfg.theme === "dark" ? DARK_THEME : LIGHT_THEME,
      fontSize: cfg.fontSize,
      fontFamily: FONT_FAMILY,
    });

    const svg = await modules.satori(element, {
      width: cfg.width,
      // No `height`: satori grows the document to fit, so a summary of any
      // length comes out as one correctly-sized image.
      fonts: [
        { name: FONT_FAMILY, data: fonts.regular, weight: 400, style: "normal" },
        ...(fonts.bold ? [{ name: FONT_FAMILY, data: fonts.bold, weight: 700, style: "normal" }] : []),
      ],
    });

    const png = new modules.Resvg(svg, {
      fitTo: { mode: "width", value: Math.round(cfg.width * cfg.scale) },
    })
      .render()
      .asPng();

    log?.debug?.(`[snowluma:render] rendered ${markdown.length} chars of markdown into ${png.length} bytes of PNG`);
    return png;
  } catch (err) {
    log?.error?.(`[snowluma:render] rendering failed (${String(err)}) — sending as text instead`);
    return null;
  }
}
