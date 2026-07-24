/**
 * Self-patching lazy loader for `@snowluma/sdk`.
 *
 * Two gateway realities force this module's existence:
 *
 * 1. `@snowluma/sdk` (through at least v1.12.8) ships ESM with extensionless
 *    relative imports, which Node's resolver rejects (ERR_MODULE_NOT_FOUND)
 *    unless the files are rewritten first (see scripts/patch-snowluma-sdk.mjs).
 * 2. OpenClaw's plugin installer runs `npm install` with `--ignore-scripts`
 *    hardcoded (plus `NPM_CONFIG_IGNORE_SCRIPTS=true` in the env), so this
 *    plugin's `postinstall` hook NEVER runs on a gateway install — the patch
 *    cannot be applied at install time there.
 *
 * So the plugin patches the SDK itself, at load time, right before the first
 * dynamic `import("@snowluma/sdk")`. A static `import { X } from "@snowluma/sdk"`
 * anywhere in the runtime graph would defeat this: ESM links — and therefore
 * resolves the SDK's broken internal specifiers — for the WHOLE graph before any
 * plugin code runs. That is why every other module keeps its SDK imports
 * `import type`-only and reads SDK values from this registry instead.
 * `test/load-graph.test.ts` enforces both halves structurally.
 *
 * Load order in production: `startGateway` and `acquireActionClient` — the two
 * places all SDK usage funnels through — `await ensureSnowLumaSdk()` before
 * constructing clients, so every downstream synchronous `getSnowLumaSdk()` call
 * (segment parsing, message builders) runs strictly after the SDK is loaded.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The SDK's module namespace — type-only, erased at compile time. */
export type SnowLumaSdkModule = typeof import("@snowluma/sdk");

export interface SdkLoadLogger {
  info?(message: string): void;
  error?(message: string): void;
}

// ── Patch (in-process port of scripts/patch-snowluma-sdk.mjs) ──────────────
// Keep the rewrite semantics in sync with that script: it remains the
// standalone fallback for manual `npm install` flows, while this port is what
// actually runs on `--ignore-scripts` gateway installs.

/** Matches the specifier in `from "./x"` / `import("./x")` / `require("./x")`. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\2/g;

function resolveSpecifier(fileDir: string, specifier: string): string | null {
  // Anything already carrying an extension is fine.
  if (/\.(js|mjs|cjs|json|d\.ts)$/.test(specifier)) return null;

  const target = join(fileDir, specifier);
  if (existsSync(`${target}.js`)) return `${specifier}.js`;
  if (existsSync(target) && statSync(target).isDirectory() && existsSync(join(target, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return null;
}

function walkPatchableFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkPatchableFiles(full));
    // .d.ts needs the same treatment: TypeScript's NodeNext resolution is as
    // strict about extensions as Node itself.
    else if (/\.(js|d\.ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export interface SdkPatchResult {
  patchedFiles: number;
  patchedSpecifiers: number;
}

/**
 * Rewrites extensionless relative specifiers under `sdkDist` in place.
 * Idempotent: already-extensioned specifiers and bare package imports are left
 * alone, so re-running against a patched tree changes nothing.
 */
export function patchSnowLumaSdkDist(sdkDist: string): SdkPatchResult {
  let patchedFiles = 0;
  let patchedSpecifiers = 0;

  for (const file of walkPatchableFiles(sdkDist)) {
    const source = readFileSync(file, "utf8");
    const fileDir = dirname(file);
    let changed = 0;

    const next = source.replace(SPECIFIER_RE, (match, head: string, quote: string, specifier: string) => {
      const fixed = resolveSpecifier(fileDir, specifier);
      if (!fixed) return match;
      changed += 1;
      return `${head}${quote}${fixed}${quote}`;
    });

    if (changed > 0) {
      writeFileSync(file, next, "utf8");
      patchedFiles += 1;
      patchedSpecifiers += changed;
    }
  }

  return { patchedFiles, patchedSpecifiers };
}

/**
 * Locates the installed SDK's `dist/` directory relative to THIS module — on a
 * gateway that is the plugin's own generation dir, exactly the copy the dynamic
 * import below will load. Returns undefined when the SDK isn't resolvable
 * (the import afterwards will then produce the real, useful error).
 */
export function resolveSnowLumaSdkDist(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // The SDK's exports map exposes "./package.json", so this resolves cleanly.
    const pkgPath = require.resolve("@snowluma/sdk/package.json");
    const dist = join(dirname(pkgPath), "dist");
    return existsSync(dist) ? dist : undefined;
  } catch {
    return undefined;
  }
}

// ── Loader / registry ───────────────────────────────────────────────────────

/** Injectable seams so tests can exercise every load outcome without real installs. */
export interface SdkLoadDeps {
  importSdk?: () => Promise<SnowLumaSdkModule>;
  resolveDist?: () => string | undefined;
  patchDist?: (sdkDist: string) => SdkPatchResult;
}

/**
 * One patch-then-import pass, no memoization — `ensureSnowLumaSdk` is the
 * memoized entry point production code uses.
 */
export async function loadSnowLumaSdkModule(
  log?: SdkLoadLogger,
  deps: SdkLoadDeps = {},
): Promise<SnowLumaSdkModule> {
  let patchError: unknown;
  try {
    const dist = (deps.resolveDist ?? resolveSnowLumaSdkDist)();
    if (dist) {
      const result = (deps.patchDist ?? patchSnowLumaSdkDist)(dist);
      if (result.patchedSpecifiers > 0) {
        log?.info?.(
          `[snowluma] patched ${result.patchedSpecifiers} extensionless import(s) across ` +
            `${result.patchedFiles} file(s) in @snowluma/sdk (postinstall did not run at install time)`,
        );
      }
    }
  } catch (err) {
    // Don't fail yet: a pre-patched tree (manual install) still imports fine.
    patchError = err;
  }

  try {
    return await (deps.importSdk ?? (() => import("@snowluma/sdk")))();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const patchNote =
      patchError === undefined
        ? ""
        : ` (self-patch also failed: ${patchError instanceof Error ? patchError.message : String(patchError)})`;
    const error = new Error(`Failed to load @snowluma/sdk: ${message}${patchNote}`);
    (error as { cause?: unknown }).cause = err;
    log?.error?.(error.message);
    throw error;
  }
}

let loadedSdk: SnowLumaSdkModule | undefined;
let loadPromise: Promise<SnowLumaSdkModule> | undefined;

/**
 * Loads (and, when needed, self-patches) the SDK exactly once per process.
 * A failed attempt clears the memo so a later call can retry.
 */
export async function ensureSnowLumaSdk(log?: SdkLoadLogger): Promise<SnowLumaSdkModule> {
  if (loadedSdk) return loadedSdk;
  loadPromise ??= loadSnowLumaSdkModule(log).then(
    (mod) => {
      loadedSdk = mod;
      return mod;
    },
    (err) => {
      loadPromise = undefined;
      throw err;
    },
  );
  return loadPromise;
}

/**
 * Synchronous accessor for code paths that run strictly after
 * `ensureSnowLumaSdk()` (segment parsing, message builders). Throwing here
 * means a code path used the SDK before gateway start / client acquisition —
 * a plugin bug, not a user configuration problem.
 */
export function getSnowLumaSdk(): SnowLumaSdkModule {
  if (!loadedSdk) {
    throw new Error(
      "@snowluma/sdk is not loaded yet — ensureSnowLumaSdk() must complete first " +
        "(plugin bug: an SDK-dependent code path ran before gateway start / client acquisition)",
    );
  }
  return loadedSdk;
}

export function tryGetSnowLumaSdk(): SnowLumaSdkModule | undefined {
  return loadedSdk;
}

/** Test-only: replaces (or clears) the registry so cases control load state. */
export function __setSnowLumaSdkForTests(mod: SnowLumaSdkModule | undefined): void {
  loadedSdk = mod;
  loadPromise = mod === undefined ? undefined : Promise.resolve(mod);
}
