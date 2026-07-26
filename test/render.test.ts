/**
 * The Markdown → PNG orchestration in `src/render.ts`.
 *
 * Every external moving part (the three deferred packages, the font files, the
 * platform) is injected, so these tests never load satori/resvg, never touch a
 * real font, and behave identically on a machine with no CJK fonts installed.
 */
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RENDER_DEFAULTS } from "../src/config.js";
import { __resetRenderCache, renderMarkdownToPng } from "../src/render.js";
import type { ResolvedRenderConfig } from "../src/types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function cfg(overrides: Partial<ResolvedRenderConfig> = {}): ResolvedRenderConfig {
  return { ...RENDER_DEFAULTS, ...overrides };
}

/** A stand-in for the satori/resvg/marked trio, recording what it was handed. */
function makeModules(options: { satoriFails?: (data: Uint8Array) => boolean } = {}) {
  const satori = vi.fn(async (_element: unknown, opts: unknown) => {
    const fonts = (opts as { fonts: { data: Uint8Array }[] }).fonts;
    if (options.satoriFails?.(fonts[0]!.data)) throw new Error("unsupported font format");
    return "<svg/>";
  });
  const resvgOptions: unknown[] = [];
  class Resvg {
    constructor(_svg: string, opts?: unknown) {
      resvgOptions.push(opts);
    }
    render() {
      return { asPng: () => PNG };
    }
  }
  const lex = vi.fn((md: string) => [{ type: "paragraph", text: md, tokens: [{ type: "text", text: md }] }]);
  return {
    modules: { satori, Resvg: Resvg as never, lex },
    satori,
    lex,
    resvgOptions,
  };
}

/** A fake font tree: only the listed paths exist. */
function makeFontReader(available: Record<string, Uint8Array>) {
  return vi.fn(async (path: string) => {
    const data = available[path];
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  });
}

const WIN_REGULAR = "C:/Windows/Fonts/Deng.ttf";
const WIN_BOLD = "C:/Windows/Fonts/Dengb.ttf";

beforeEach(() => {
  __resetRenderCache();
});

describe("renderMarkdownToPng — refusals", () => {
  it("returns null for empty or whitespace-only markdown", async () => {
    const { modules } = makeModules();
    const deps = { loadModules: async () => modules, readFontFile: makeFontReader({}), platform: "win32" };
    expect(await renderMarkdownToPng("", cfg(), undefined, deps)).toBeNull();
    expect(await renderMarkdownToPng("   \n ", cfg(), undefined, deps)).toBeNull();
  });

  it("returns null when the reply is longer than maxChars", async () => {
    const { modules, satori } = makeModules();
    const info: string[] = [];
    const result = await renderMarkdownToPng("x".repeat(101), cfg({ maxChars: 100 }), { info: (m) => info.push(m) }, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });
    expect(result).toBeNull();
    expect(satori).not.toHaveBeenCalled();
    expect(info.join("\n")).toContain("maxChars");
  });

  it("returns null and warns exactly once when the packages are missing", async () => {
    const errors: string[] = [];
    const debug: string[] = [];
    const deps = {
      loadModules: async () => {
        throw new Error("Cannot find package 'satori'");
      },
      readFontFile: makeFontReader({}),
      platform: "linux",
    };

    expect(await renderMarkdownToPng("内容", cfg(), { error: (m) => errors.push(m), debug: (m) => debug.push(m) }, deps)).toBeNull();
    expect(await renderMarkdownToPng("内容", cfg(), { error: (m) => errors.push(m), debug: (m) => debug.push(m) }, deps)).toBeNull();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Cannot find package 'satori'");
    expect(debug).toHaveLength(1);
  });

  it("returns null with an actionable message when no font can be found", async () => {
    const { modules } = makeModules();
    const errors: string[] = [];
    const result = await renderMarkdownToPng("内容", cfg(), { error: (m) => errors.push(m) }, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({}),
      platform: "linux",
    });
    expect(result).toBeNull();
    expect(errors.join("\n")).toContain("fontPath");
  });

  it("returns null (never throws) when the rasterizer blows up", async () => {
    const { modules } = makeModules();
    modules.satori = vi.fn(async () => {
      throw new Error("layout exploded");
    }) as never;
    const errors: string[] = [];
    // The probe render fails too, so this surfaces as "no usable font" —
    // either way the contract is the same: null, no throw.
    await expect(
      renderMarkdownToPng("内容", cfg(), { error: (m) => errors.push(m) }, {
        loadModules: async () => modules,
        readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
        platform: "win32",
      }),
    ).resolves.toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("renderMarkdownToPng — happy path", () => {
  it("renders PNG bytes and rasterizes at width × scale", async () => {
    const { modules, satori, resvgOptions } = makeModules();
    const png = await renderMarkdownToPng("# 总结", cfg({ width: 700, scale: 3 }), undefined, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });

    expect(png).toEqual(PNG);
    // The probe render plus the real one.
    expect(satori).toHaveBeenCalledTimes(2);
    expect((satori.mock.calls[1]![1] as { width: number }).width).toBe(700);
    // No explicit height — satori grows the document to fit.
    expect(satori.mock.calls[1]![1]).not.toHaveProperty("height");
    expect(resvgOptions[0]).toEqual({ fitTo: { mode: "width", value: 2100 } });
  });

  it("registers a bold face when one exists, and copes when it does not", async () => {
    const withBold = makeModules();
    await renderMarkdownToPng("内容", cfg(), undefined, {
      loadModules: async () => withBold.modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]), [WIN_BOLD]: new Uint8Array([2]) }),
      platform: "win32",
    });
    const boldFonts = (withBold.satori.mock.calls[1]![1] as { fonts: { weight: number }[] }).fonts;
    expect(boldFonts.map((f) => f.weight)).toEqual([400, 700]);

    __resetRenderCache();

    const noBold = makeModules();
    const png = await renderMarkdownToPng("内容", cfg(), undefined, {
      loadModules: async () => noBold.modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });
    expect(png).toEqual(PNG);
    expect((noBold.satori.mock.calls[1]![1] as { fonts: unknown[] }).fonts).toHaveLength(1);
  });

  it("lexes the markdown it was given", async () => {
    const { modules, lex } = makeModules();
    await renderMarkdownToPng("## 标题\n\n正文", cfg(), undefined, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });
    expect(lex).toHaveBeenCalledWith("## 标题\n\n正文");
  });
});

// ── Real end-to-end render ──────────────────────────────────────────────
//
// Everything above injects fakes, which means the REAL loader — the three
// dynamic imports, the `satori` default-export interop, `initWasm`, and the
// `index_bg.wasm` path resolution — would otherwise never run in CI. This block
// exercises it for real, and skips itself on a host with no usable CJK font
// (the same condition that makes the feature degrade to text in production).

const PROBE_FONTS = [
  "C:/Windows/Fonts/Deng.ttf",
  "C:/Windows/Fonts/simhei.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/System/Library/Fonts/PingFang.ttc",
];
const hasFont = PROBE_FONTS.some((p) => existsSync(p));

describe.runIf(hasFont)("renderMarkdownToPng — real satori + resvg-wasm", () => {
  it("turns real Markdown into a real PNG", { timeout: 60_000 }, async () => {
    const markdown = [
      "# 群聊总结",
      "",
      "今天讨论了 **三件事**，其中 `会议时间` 已确定。",
      "",
      "1. 周四下午三点开会",
      "2. 张三准备材料",
      "",
      "> 待确认：会议室是否可用",
    ].join("\n");

    const png = await renderMarkdownToPng(markdown, cfg({ width: 640, scale: 1 }));

    expect(png).not.toBeNull();
    // PNG magic number — proves resvg really rasterised something.
    expect(Array.from(png!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png!.length).toBeGreaterThan(1000);
  });

  it("still refuses oversized input on the real path", async () => {
    expect(await renderMarkdownToPng("字".repeat(200), cfg({ maxChars: 50 }))).toBeNull();
  });
});

describe("renderMarkdownToPng — font resolution", () => {
  it("tries the configured fontPath before any platform candidate", async () => {
    const { modules, satori } = makeModules();
    const custom = new Uint8Array([9, 9, 9]);
    await renderMarkdownToPng("内容", cfg({ fontPath: "/opt/fonts/custom.otf" }), undefined, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ "/opt/fonts/custom.otf": custom, [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });
    expect((satori.mock.calls[1]![1] as { fonts: { data: Uint8Array }[] }).fonts[0]!.data).toBe(custom);
  });

  it("logs loudly when a configured fontPath is unreadable, then falls back", async () => {
    const { modules } = makeModules();
    const errors: string[] = [];
    const png = await renderMarkdownToPng("内容", cfg({ fontPath: "/nope/missing.ttf" }), { error: (m) => errors.push(m) }, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "win32",
    });
    expect(errors.join("\n")).toContain("/nope/missing.ttf");
    expect(png).toEqual(PNG);
  });

  it("skips a candidate satori cannot parse and takes the next one", async () => {
    const unparseable = new Uint8Array([0xff]);
    const good = new Uint8Array([0x01]);
    const { modules, satori } = makeModules({ satoriFails: (data) => data === unparseable });

    const png = await renderMarkdownToPng("内容", cfg(), undefined, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: unparseable, "C:/Windows/Fonts/simhei.ttf": good }),
      platform: "win32",
    });

    expect(png).toEqual(PNG);
    const used = (satori.mock.calls.at(-1)![1] as { fonts: { data: Uint8Array }[] }).fonts[0]!.data;
    expect(used).toBe(good);
  });

  it("has no candidates for an unknown platform, so it degrades to text", async () => {
    const { modules } = makeModules();
    const result = await renderMarkdownToPng("内容", cfg(), undefined, {
      loadModules: async () => modules,
      readFontFile: makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) }),
      platform: "aix",
    });
    expect(result).toBeNull();
  });

  it("resolves the font once and reuses it for later renders", async () => {
    const { modules } = makeModules();
    const readFontFile = makeFontReader({ [WIN_REGULAR]: new Uint8Array([1]) });
    const deps = { loadModules: async () => modules, readFontFile, platform: "win32" };

    await renderMarkdownToPng("一", cfg(), undefined, deps);
    const afterFirst = readFontFile.mock.calls.length;
    await renderMarkdownToPng("二", cfg(), undefined, deps);

    expect(readFontFile.mock.calls.length).toBe(afterFirst);
  });

  it("re-resolves when the configured font path changes", async () => {
    const { modules } = makeModules();
    const readFontFile = makeFontReader({
      [WIN_REGULAR]: new Uint8Array([1]),
      "/opt/other.ttf": new Uint8Array([7]),
    });
    const deps = { loadModules: async () => modules, readFontFile, platform: "win32" };

    await renderMarkdownToPng("一", cfg(), undefined, deps);
    const afterFirst = readFontFile.mock.calls.length;
    await renderMarkdownToPng("二", cfg({ fontPath: "/opt/other.ttf" }), undefined, deps);

    expect(readFontFile.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
