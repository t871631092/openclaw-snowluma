/**
 * Pins the module-local runtime store semantics in `src/runtime.ts` — a
 * hand-rolled equivalent of the SDK's `createPluginRuntimeStore("<message>")`
 * string overload (kept local to keep `setup-entry.js`'s graph openclaw-free;
 * see load-graph.test.ts and src/runtime.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSnowLumaRuntime,
  getSnowLumaRuntime,
  setSnowLumaRuntime,
  tryGetSnowLumaRuntime,
} from "../src/runtime.js";

// The store is a module-level singleton; reset it between cases so ordering never matters.
afterEach(() => clearSnowLumaRuntime());

const fakeRuntime = { channel: {} } as never;

describe("SnowLuma runtime store", () => {
  it("tryGet returns null and get throws before a runtime is set", () => {
    clearSnowLumaRuntime();
    expect(tryGetSnowLumaRuntime()).toBeNull();
    expect(() => getSnowLumaRuntime()).toThrow("SnowLuma runtime not initialized");
  });

  it("returns the set runtime from both get and tryGet", () => {
    setSnowLumaRuntime(fakeRuntime);
    expect(getSnowLumaRuntime()).toBe(fakeRuntime);
    expect(tryGetSnowLumaRuntime()).toBe(fakeRuntime);
  });

  it("clear resets back to the uninitialized state", () => {
    setSnowLumaRuntime(fakeRuntime);
    clearSnowLumaRuntime();
    expect(tryGetSnowLumaRuntime()).toBeNull();
    expect(() => getSnowLumaRuntime()).toThrow("SnowLuma runtime not initialized");
  });
});
