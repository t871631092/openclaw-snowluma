/**
 * Structural guard for `openclaw.plugin.json`'s `channelConfigs.snowluma` schema.
 *
 * On OpenClaw gateways (verified against 2026.7.1), the control-UI's config
 * editor gets the `channels.snowluma` schema from the PLUGIN MANIFEST
 * (`resolvePluginMetadataSnapshot` → `collectChannelSchemaMetadata(registry)` →
 * `record.channelConfigs[channelId].schema`), NOT from the loaded module's
 * `snowLumaPlugin.configSchema`. The UI then normalizes that schema with a
 * renderer that supports only a small JSON-Schema subset — and anything it
 * can't normalize renders as "Unsupported schema node. Use Raw mode." instead
 * of form fields. Notably it does NOT resolve `$ref` (history: 0.1.5's manifest
 * used `$ref`/`$defs` for reconnect/receive/quote/tools/accounts, and exactly
 * those five fields broke).
 *
 * `walkLikeControlUi` below is a faithful port of the UI's normalizer
 * (`dist/control-ui/assets/config-form-*.js`, openclaw 2026.7.1): same
 * traversal, same unsupported-path rules. The test fails when the manifest
 * schema contains any node that normalizer would flag.
 *
 * Also guards the gateway's response budget: a channel schema over 256KB is
 * silently replaced with a generic "omitted" schema (EXTENSION_SCHEMA_MAX_BYTES
 * in the gateway's schema builder).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type SchemaNode = Record<string, unknown>;

/** Keys the UI treats as "annotation only" when deciding whether `additionalProperties` is a free-form JSON map. */
const ANNOTATION_KEYS = new Set(["title", "description", "default", "nullable", "tags", "x-tags"]);
const SCALARISH = new Set(["string", "number", "integer", "boolean", "object", "array"]);

function isRecord(v: unknown): v is SchemaNode {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Port of the UI's `Nn`: primary type of a node, ignoring `"null"` in type arrays. */
function nodeType(node: SchemaNode): unknown {
  const t = node.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null") ?? t[0];
  return t;
}

/** Port of the UI's "annotation-only object" check for `additionalProperties`. */
function isAnnotationOnly(node: SchemaNode): boolean {
  return Object.keys(node).filter((k) => !ANNOTATION_KEYS.has(k)).length === 0;
}

function dedupEnum(values: unknown[]): { enumValues: unknown[]; nullable: boolean } {
  const nonNull = values.filter((v) => v != null);
  const out: unknown[] = [];
  for (const v of nonNull) if (!out.some((o) => Object.is(o, v))) out.push(v);
  return { enumValues: out, nullable: nonNull.length !== values.length };
}

/** Port of the UI's anyOf/oneOf/allOf combinator handling (`ee`). Returns null when the combinator is unsupported. */
function tryCombinator(node: SchemaNode, path: string[], unsupported: Set<string>): boolean {
  if (node.allOf) return false;
  const branches = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (!branches) return false;
  const enumValues: unknown[] = [];
  const objects: SchemaNode[] = [];
  for (const branch of branches) {
    if (!isRecord(branch)) return false;
    if (Array.isArray(branch.enum)) {
      enumValues.push(...dedupEnum(branch.enum).enumValues);
      continue;
    }
    if ("const" in branch) {
      if (branch.const != null) enumValues.push(branch.const);
      continue;
    }
    if (nodeType(branch) === "null") continue;
    objects.push(branch);
  }
  // SecretRef union special-case ($): needs a string branch + a SecretRef object union — not our shape; skip.
  if (enumValues.length > 0 && objects.length === 0) return true;
  if (objects.length === 1) {
    walk({ ...node, ...objects[0], anyOf: undefined, oneOf: undefined, allOf: undefined }, path, unsupported);
    return true;
  }
  return objects.length > 0 && enumValues.length === 0 && objects.every((b) => SCALARISH.has(String(nodeType(b) ?? "")));
}

/** Port of the UI's normalizer walk (`X`): adds the dotted path of every node the form renderer cannot handle. */
function walk(node: SchemaNode, path: string[], unsupported: Set<string>): void {
  const here = path.join(".") || "<root>";
  if (node.anyOf || node.oneOf || node.allOf) {
    if (!tryCombinator(node, path, unsupported)) unsupported.add(here);
    return;
  }
  const type = nodeType(node) ?? (node.properties || node.additionalProperties ? "object" : undefined);
  if (Array.isArray(node.enum)) {
    if (dedupEnum(node.enum).enumValues.length === 0) unsupported.add(here);
    return;
  }
  if (type === "object") {
    for (const [key, child] of Object.entries((node.properties as SchemaNode) ?? {})) {
      if (isRecord(child)) walk(child, [...path, key], unsupported);
    }
    const ap = node.additionalProperties;
    if (isRecord(ap) && !isAnnotationOnly(ap)) {
      const before = unsupported.size;
      walk(ap, [...path, "*"], unsupported);
      if (unsupported.size > before) unsupported.add(here);
    }
    return;
  }
  if (type === "array") {
    const items = Array.isArray(node.items) ? node.items[0] : node.items;
    if (!isRecord(items)) {
      unsupported.add(here);
      return;
    }
    const before = unsupported.size;
    walk(items, [...path, "*"], unsupported);
    if (unsupported.size > before) unsupported.add(here);
    return;
  }
  if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
    unsupported.add(here);
  }
}

describe("openclaw.plugin.json — channelConfigs.snowluma.schema stays control-UI renderable", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "openclaw.plugin.json"), "utf8")) as {
    channelConfigs?: Record<string, { schema?: SchemaNode; uiHints?: unknown }>;
  };
  const entry = manifest.channelConfigs?.snowluma;

  it("declares a channelConfigs.snowluma.schema (the gateway serves the config UI from the MANIFEST, not the module)", () => {
    expect(entry?.schema, "channelConfigs.snowluma.schema missing from openclaw.plugin.json").toBeTruthy();
  });

  it("contains no $ref/$defs — the control-UI renderer does not resolve references", () => {
    const raw = JSON.stringify(entry?.schema ?? {});
    expect(raw.includes('"$ref"'), "schema contains $ref; inline the definition instead").toBe(false);
    expect(raw.includes('"$defs"'), "schema contains $defs; nothing may reference them, drop them").toBe(false);
  });

  it("every node passes the control-UI normalizer (no 'Unsupported schema node. Use Raw mode.')", () => {
    const unsupported = new Set<string>();
    walk(entry?.schema ?? {}, [], unsupported);
    expect([...unsupported], "these paths would render as 'Unsupported schema node. Use Raw mode.'").toEqual([]);
  });

  it("stays under the gateway's 256KB per-schema response budget", () => {
    expect(JSON.stringify(entry?.schema ?? {}).length).toBeLessThan(256 * 1024);
  });

  // Proves the ported normalizer is not vacuous: it flags exactly the node
  // shapes that broke in 0.1.5 ($ref) and passes the shapes we rely on.
  it("positive control: the ported normalizer flags $ref nodes and unsupported combinators", () => {
    const flagged = new Set<string>();
    walk({ type: "object", properties: { bad: { $ref: "#/$defs/x", description: "d" } } }, [], flagged);
    expect([...flagged]).toEqual(["bad"]);

    const allOf = new Set<string>();
    walk({ type: "object", properties: { bad: { allOf: [{ type: "string" }] } } }, [], allOf);
    expect([...allOf]).toEqual(["bad"]);

    const ok = new Set<string>();
    walk(
      {
        type: "object",
        properties: {
          s: { type: "string" },
          n: { type: ["integer", "string"] },
          u: { anyOf: [{ type: "number" }, { type: "string" }] },
          e: { type: "string", enum: ["a", "b"] },
          arr: { type: "array", items: { type: "string" } },
          map: { type: "object", additionalProperties: { type: "object", properties: { x: { type: "boolean" } } } },
        },
      },
      [],
      ok,
    );
    expect([...ok]).toEqual([]);
  });
});
