/**
 * Verifies the local `defineChannelPluginEntry` in `src/plugin-entry.ts` is a
 * faithful port of the SDK helper (kept local to keep index.js's graph
 * openclaw-free; see load-graph.test.ts and src/plugin-entry.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { defineChannelPluginEntry } from "../src/plugin-entry.js";

const plugin = { id: "snowluma" } as never;

function makeApi(registrationMode: string) {
  const registered: unknown[] = [];
  const api = {
    registrationMode,
    registerChannel: (r: unknown) => registered.push(r),
    runtime: { tag: "runtime" },
  } as never;
  return { api, registered };
}

describe("defineChannelPluginEntry (local port)", () => {
  it("copies id/name/description and exposes channelPlugin + setChannelRuntime", () => {
    const setRuntime = vi.fn();
    const entry = defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin, setRuntime });
    expect(entry.id).toBe("x");
    expect(entry.name).toBe("N");
    expect(entry.description).toBe("D");
    expect(entry.channelPlugin).toBe(plugin);
    expect(entry.setChannelRuntime).toBe(setRuntime);
  });

  it("omits setChannelRuntime when no setRuntime is given", () => {
    const entry = defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin });
    expect("setChannelRuntime" in entry).toBe(false);
  });

  it.each(["full", "discovery"])("registers the channel and runtime in %s mode", (mode) => {
    const setRuntime = vi.fn();
    const entry = defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin, setRuntime });
    const { api, registered } = makeApi(mode);
    entry.register(api);
    expect(registered).toEqual([{ plugin }]);
    expect(setRuntime).toHaveBeenCalledWith({ tag: "runtime" });
  });

  it.each(["cli-metadata", "tool-discovery"])("does NOT register the channel in %s mode", (mode) => {
    const setRuntime = vi.fn();
    const entry = defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin, setRuntime });
    const { api, registered } = makeApi(mode);
    entry.register(api);
    expect(registered).toEqual([]);
    expect(setRuntime).not.toHaveBeenCalled();
  });

  it("invokes registerCliMetadata / registerFull only in the modes the SDK does", () => {
    const registerCliMetadata = vi.fn();
    const registerFull = vi.fn();
    const entry = defineChannelPluginEntry({
      id: "x",
      name: "N",
      description: "D",
      plugin,
      registerCliMetadata,
      registerFull,
    });
    entry.register(makeApi("cli-metadata").api);
    expect(registerCliMetadata).toHaveBeenCalledTimes(1);
    expect(registerFull).not.toHaveBeenCalled();

    entry.register(makeApi("tool-discovery").api);
    expect(registerFull).toHaveBeenCalledTimes(1);

    entry.register(makeApi("discovery").api);
    expect(registerCliMetadata).toHaveBeenCalledTimes(2); // discovery also calls cli-metadata

    entry.register(makeApi("full").api);
    expect(registerCliMetadata).toHaveBeenCalledTimes(3);
    expect(registerFull).toHaveBeenCalledTimes(2);
  });

  it("uses a passed configSchema (value or factory) instead of the empty default", () => {
    const schema = { schema: { type: "object" } };
    expect(defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin, configSchema: schema }).configSchema).toBe(schema);
    expect(defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin, configSchema: () => schema }).configSchema).toBe(schema);
  });

  describe("default emptyChannelConfigSchema.safeParse", () => {
    const safeParse = (
      defineChannelPluginEntry({ id: "x", name: "N", description: "D", plugin })
        .configSchema as { runtime: { safeParse(v: unknown): { success: boolean; issues?: { message: string }[] } } }
    ).runtime.safeParse;

    it("accepts undefined and an empty object", () => {
      expect(safeParse(undefined)).toEqual({ success: true, data: undefined });
      expect(safeParse({})).toEqual({ success: true, data: {} });
    });

    it("rejects a non-object and a non-empty object", () => {
      expect(safeParse("nope").success).toBe(false);
      expect(safeParse([]).success).toBe(false);
      expect(safeParse({ a: 1 })).toEqual({ success: false, issues: [{ path: [], message: "config must be empty" }] });
    });
  });
});
