/**
 * Covers src/sdk.ts: the specifier patcher (fixture round-trip + idempotency),
 * every load outcome of `loadSnowLumaSdkModule` via injected deps, and the
 * registry contract (`ensureSnowLumaSdk`/`getSnowLumaSdk`) — including the
 * graceful degrade in `segments.ts` when the registry is not loaded.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setSnowLumaSdkForTests,
  ensureSnowLumaSdk,
  getSnowLumaSdk,
  loadSnowLumaSdkModule,
  patchSnowLumaSdkDist,
  resolveSnowLumaSdkDist,
  tryGetSnowLumaSdk,
  type SnowLumaSdkModule,
} from "../src/sdk.js";
import { toSegments } from "../src/segments.js";

// The global setup file loaded the real SDK; keep a handle so every test that
// clears the registry can restore the invariant the other test files rely on.
const realSdk = tryGetSnowLumaSdk();

afterEach(() => {
  __setSnowLumaSdkForTests(realSdk);
});

describe("patchSnowLumaSdkDist", () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), "snowluma-sdk-patch-"));
    mkdirSync(join(dist, "client"));
    mkdirSync(join(dist, "pkg"));
    writeFileSync(join(dist, "util.js"), "export const x = 1;\n");
    writeFileSync(join(dist, "pkg", "index.js"), "export const pkg = 1;\n");
    writeFileSync(join(dist, "client", "api-client.js"), "import { x } from '../util';\n");
    writeFileSync(join(dist, "client", "api-client.d.ts"), "export * from '../util';\n");
    writeFileSync(
      join(dist, "index.js"),
      [
        "export * from './client/api-client';", // → ./client/api-client.js
        "import './util';", // side-effect import → ./util.js
        "import a from './pkg';", // directory → ./pkg/index.js
        "const b = import('./pkg');", // dynamic → ./pkg/index.js
        "const c = require('./util');", // require → ./util.js
        "import d from './done.js';", // already extensioned → untouched
        "import ws from 'ws';", // bare package → untouched
        "import e from './nope';", // unresolvable → untouched
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it("rewrites extensionless relative specifiers across .js and .d.ts files", () => {
    const result = patchSnowLumaSdkDist(dist);
    expect(result).toEqual({ patchedFiles: 3, patchedSpecifiers: 6 });

    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(
      [
        "export * from './client/api-client.js';",
        "import './util';", // side-effect import has no `from`/call head — left alone by design
        "import a from './pkg/index.js';",
        "const b = import('./pkg/index.js');",
        "const c = require('./util.js');",
        "import d from './done.js';",
        "import ws from 'ws';",
        "import e from './nope';",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(dist, "client", "api-client.js"), "utf8")).toBe("import { x } from '../util.js';\n");
    expect(readFileSync(join(dist, "client", "api-client.d.ts"), "utf8")).toBe("export * from '../util.js';\n");
  });

  it("is idempotent: a second run changes nothing", () => {
    patchSnowLumaSdkDist(dist);
    expect(patchSnowLumaSdkDist(dist)).toEqual({ patchedFiles: 0, patchedSpecifiers: 0 });
  });
});

describe("resolveSnowLumaSdkDist", () => {
  it("finds the installed SDK's dist directory", () => {
    const dist = resolveSnowLumaSdkDist();
    expect(dist).toBeDefined();
    expect(dist!.replace(/\\/g, "/")).toMatch(/@snowluma\/sdk\/dist$/);
  });
});

describe("loadSnowLumaSdkModule", () => {
  const fakeSdk = { fake: true } as unknown as SnowLumaSdkModule;

  it("skips patching when the SDK dist cannot be located, and imports", async () => {
    const patchDist = vi.fn();
    const mod = await loadSnowLumaSdkModule(undefined, {
      resolveDist: () => undefined,
      patchDist,
      importSdk: async () => fakeSdk,
    });
    expect(mod).toBe(fakeSdk);
    expect(patchDist).not.toHaveBeenCalled();
  });

  it("patches before importing and logs when specifiers were rewritten", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const patchDist = vi.fn().mockReturnValue({ patchedFiles: 3, patchedSpecifiers: 7 });
    const mod = await loadSnowLumaSdkModule(log, {
      resolveDist: () => "/fake/dist",
      patchDist,
      importSdk: async () => fakeSdk,
    });
    expect(mod).toBe(fakeSdk);
    expect(patchDist).toHaveBeenCalledWith("/fake/dist");
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![0]).toContain("patched 7 extensionless import(s) across 3 file(s)");
  });

  it("stays silent when a pre-patched tree needed no rewrites", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await loadSnowLumaSdkModule(log, {
      resolveDist: () => "/fake/dist",
      patchDist: () => ({ patchedFiles: 0, patchedSpecifiers: 0 }),
      importSdk: async () => fakeSdk,
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("a patch failure alone does not fail the load (pre-patched trees import fine)", async () => {
    const mod = await loadSnowLumaSdkModule(undefined, {
      resolveDist: () => "/fake/dist",
      patchDist: () => {
        throw new Error("EROFS: read-only file system");
      },
      importSdk: async () => fakeSdk,
    });
    expect(mod).toBe(fakeSdk);
  });

  it("an import failure reports the cause — and the patch failure when there was one", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const importError = new Error("Cannot find module './client/api-client'");
    await expect(
      loadSnowLumaSdkModule(log, {
        resolveDist: () => "/fake/dist",
        patchDist: () => {
          throw new Error("EROFS: read-only file system");
        },
        importSdk: async () => {
          throw importError;
        },
      }),
    ).rejects.toMatchObject({
      message:
        "Failed to load @snowluma/sdk: Cannot find module './client/api-client'" +
        " (self-patch also failed: EROFS: read-only file system)",
      cause: importError,
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("an import failure without a patch failure omits the self-patch note", async () => {
    await expect(
      loadSnowLumaSdkModule(undefined, {
        resolveDist: () => undefined,
        importSdk: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/^Failed to load @snowluma\/sdk: boom$/);
  });
});

describe("registry (ensureSnowLumaSdk / getSnowLumaSdk)", () => {
  it("getSnowLumaSdk throws a descriptive error before any load", () => {
    __setSnowLumaSdkForTests(undefined);
    expect(() => getSnowLumaSdk()).toThrow(/ensureSnowLumaSdk\(\) must complete first/);
    expect(tryGetSnowLumaSdk()).toBeUndefined();
  });

  it("ensureSnowLumaSdk loads the real SDK and memoizes it", async () => {
    __setSnowLumaSdkForTests(undefined);
    const mod = await ensureSnowLumaSdk();
    expect(typeof mod.parseSegments).toBe("function");
    expect(typeof mod.SnowLumaWebSocketClient).toBe("function");
    expect(getSnowLumaSdk()).toBe(mod);
    await expect(ensureSnowLumaSdk()).resolves.toBe(mod);
  });

  it("toSegments degrades to the plain-text fallback while the SDK is not loaded", () => {
    __setSnowLumaSdkForTests(undefined);
    // A CQ string would normally go through the SDK parser; unloaded registry
    // must degrade to the raw text fallback instead of throwing.
    expect(toSegments("[CQ:at,qq=42] hello", "raw fallback")).toEqual([
      { type: "text", data: { text: "raw fallback" } },
    ]);
  });
});
