/**
 * Local, dependency-free reimplementations of the two `openclaw/plugin-sdk/core`
 * param readers this plugin uses (`readStringParam` / `readNumberParam`).
 *
 * WHY LOCAL — this is a deliberate load-time correctness fix, not a style choice.
 * Importing these from `openclaw/plugin-sdk/core` pulls that whole (large) module
 * graph into `tools.ts`, and therefore into `setup-entry.ts`'s transitive graph
 * (`setup-entry → channel → tools`). OpenClaw's plugin loader **synchronously
 * `require()`s** `setup-entry.js` (to read the setup surface) while it is
 * **asynchronously `import()`ing** `index.js` on the loader-hook thread. When the
 * sync `require()` reaches `openclaw/plugin-sdk/core.js` while that same module is
 * still mid-evaluation from the async import, Node throws
 * `ERR_REQUIRE_ESM_RACE_CONDITION` and the whole plugin fails to load. Keeping
 * these helpers local means `setup-entry.js`'s runtime graph contains ZERO
 * `openclaw/*` imports, so there is nothing for the sync require to race on.
 * See docs/guide/troubleshooting.md#err-require-esm-race-condition.
 *
 * Behaviour mirrors the SDK helpers (`common.ts`) for every option this plugin
 * relies on: snake_case key fallback, `required`, `trim`, and numeric coercion.
 */

/** Thrown when a `required` param is missing; message matches the SDK (`<label> required`). */
export class ToolInputError extends Error {}

/** camelCase → snake_case, matching `openclaw`'s `toSnakeCaseKey` for keys without whitespace. */
function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Read `params[key]`, falling back to the snake_case spelling (`messageSeq` → `message_seq`). */
function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) return params[key];
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) return params[snakeKey];
  return undefined;
}

export interface ReadStringParamOptions {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
}

// Overloads mirror the SDK: `{ required: true }` narrows the result to `string`.
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: ReadStringParamOptions & { required: true },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: ReadStringParamOptions,
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: ReadStringParamOptions = {},
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return value;
}

export interface ReadNumberParamOptions {
  required?: boolean;
  label?: string;
  integer?: boolean;
  strict?: boolean;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: ReadNumberParamOptions & { required: true },
): number;
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options?: ReadNumberParamOptions,
): number | undefined;
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: ReadNumberParamOptions = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) value = parsed;
    }
  }
  if (value === undefined) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return integer ? Math.trunc(value) : value;
}
