/**
 * Structural guard for the two plugin entry graphs (`index.ts`, `setup-entry.ts`).
 *
 * OpenClaw's loader synchronously `require()`s BOTH plugin entry files
 * (`index.js` = extensions, `setup-entry.js` = setup surface) while also
 * asynchronously `import()`ing them on the loader-hook thread, and its
 * installer runs `npm install --ignore-scripts`. That environment imposes two
 * structural rules on everything reachable from an entry at runtime:
 *
 * 1. **No `openclaw/*` runtime imports, static or dynamic.** If a sync require
 *    reaches a shared `openclaw/*` module while it is mid-evaluation from the
 *    async import, Node throws ERR_REQUIRE_ESM_RACE_CONDITION and the plugin
 *    fails to load. The plugin reaches the host only through the runtime
 *    `api`/`ctx` objects and `import type` (erased).
 *
 * 2. **No static bare runtime imports except `node:*` builtins.** The gateway
 *    controls which dependencies exist next to the installed plugin, and it
 *    never runs `postinstall` — so `@snowluma/sdk` (whose published build needs
 *    an ESM-specifier patch before it can even be linked) may only be loaded
 *    DYNAMICALLY, after the self-patch in `src/sdk.ts` has run, and nothing
 *    else (e.g. `typebox`) may be a runtime dependency at all.
 *
 * This test walks the TypeScript source graph the way the runtime does —
 * following only runtime (non-`import type`) relative imports — and fails on
 * any violation of either rule.
 *
 * See docs/guide/troubleshooting.md, src/sdk.ts, src/plugin-entry.ts,
 * src/params.ts, src/runtime.ts, and setup-entry.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** One import/export edge out of a module. */
interface Edge {
  spec: string;
  /** True when the statement is erased at compile time (`import type` / `export type`). */
  typeOnly: boolean;
  /** True for `import("x")` — resolved at call time, not at graph link time. */
  dynamic: boolean;
}

export function parseEdges(src: string): Edge[] {
  const clean = stripComments(src);
  const edges: Edge[] = [];
  // `import ... from "x"`, `export ... from "x"`, side-effect `import "x"`, and dynamic `import("x")`.
  const re =
    /(?:^|\n)\s*(import|export)\b([^\n;]*?)\bfrom\s*["'`]([^"'`]+)["'`]|(?:^|\n)\s*import\s*["'`]([^"'`]+)["'`]|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const keyword = m[1];
    const clause = m[2] ?? "";
    const spec = m[3] ?? m[4] ?? m[5];
    if (!spec) continue;
    const typeOnly = keyword !== undefined && /^\s*type\b/.test(clause);
    const dynamic = m[5] !== undefined;
    edges.push({ spec, typeOnly, dynamic });
  }
  return edges;
}

/** Resolve a relative `./x.js` specifier (as written in TS source) to its `.ts` file. */
function resolveRelativeSource(fromFile: string, spec: string): string {
  return resolve(dirname(fromFile), spec).replace(/\.js$/, ".ts");
}

interface BareImportHit {
  spec: string;
  file: string;
  dynamic: boolean;
}

/**
 * Walk the runtime module graph from `entry`, following only runtime relative
 * imports. Returns every runtime non-relative specifier encountered, tagged
 * with the (repo-relative) file it appears in and whether it was dynamic.
 */
function collectRuntimeBareImports(entry: string): BareImportHit[] {
  const seen = new Set<string>();
  const hits: BareImportHit[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const { spec, typeOnly, dynamic } of parseEdges(src)) {
      if (typeOnly) continue; // erased — not in the runtime graph
      if (spec.startsWith(".")) {
        walk(resolveRelativeSource(file, spec));
      } else {
        hits.push({ spec, file: file.slice(ROOT.length + 1).replace(/\\/g, "/"), dynamic });
      }
    }
  };
  walk(entry);
  return hits;
}

const formatHits = (hits: BareImportHit[]): string =>
  hits.map((h) => `${h.dynamic ? "import()" : "static"} ${h.spec}  (in ${h.file})`).join("\n");

describe("plugin-load graph — entry graphs stay host- and install-independent", () => {
  for (const entry of ["index.ts", "setup-entry.ts"]) {
    const hits = collectRuntimeBareImports(resolve(ROOT, entry));

    it(`${entry}'s runtime graph imports NOTHING from openclaw/* (static or dynamic)`, () => {
      const openclaw = hits.filter((h) => h.spec === "openclaw" || h.spec.startsWith("openclaw/"));
      expect(openclaw, `openclaw runtime import(s) in the sync-required ${entry} graph:\n${formatHits(openclaw)}`).toEqual(
        [],
      );
    });

    it(`${entry}'s runtime graph has NO static bare imports except node:* builtins`, () => {
      const offenders = hits.filter((h) => !h.dynamic && !h.spec.startsWith("node:"));
      expect(
        offenders,
        `static bare runtime import(s) in ${entry}'s graph — these break on gateway installs ` +
          `(--ignore-scripts / installer-controlled dependencies):\n${formatHits(offenders)}`,
      ).toEqual([]);
    });

    it(`${entry}'s runtime graph defers @snowluma/sdk: dynamic import, only from src/sdk.ts`, () => {
      const dynamicBare = hits.filter((h) => h.dynamic && !h.spec.startsWith("node:"));
      for (const hit of dynamicBare) {
        expect(hit.spec, `unexpected dynamic bare import:\n${formatHits([hit])}`).toBe("@snowluma/sdk");
        expect(hit.file, `dynamic @snowluma/sdk import outside the self-patching loader:\n${formatHits([hit])}`).toBe(
          "src/sdk.ts",
        );
      }
      // The loader itself must be part of both entry graphs (it is what makes
      // the deferred import reachable at all).
      expect(dynamicBare.length, "expected src/sdk.ts's deferred import(\"@snowluma/sdk\") in the graph").toBeGreaterThan(0);
    });
  }

  // Proves the analyzer is not vacuously returning [] — it really distinguishes
  // runtime, type-only, and dynamic edges.
  it("positive control: parseEdges classifies runtime, type-only, and dynamic imports", () => {
    expect(parseEdges('import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";')).toEqual([
      { spec: "openclaw/plugin-sdk/core", typeOnly: false, dynamic: false },
    ]);

    expect(parseEdges('import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";')).toEqual([
      { spec: "openclaw/plugin-sdk/core", typeOnly: true, dynamic: false },
    ]);

    expect(parseEdges('import { Type } from "typebox";')).toEqual([
      { spec: "typebox", typeOnly: false, dynamic: false },
    ]);

    expect(parseEdges('const sdk = await import("@snowluma/sdk");')).toEqual([
      { spec: "@snowluma/sdk", typeOnly: false, dynamic: true },
    ]);
  });
});
