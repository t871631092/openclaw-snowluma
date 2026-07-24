#!/usr/bin/env node
/**
 * Workaround for an upstream packaging bug in `@snowluma/sdk` (observed through
 * v1.12.8): the package declares `"type": "module"` but its compiled output uses
 * extensionless relative specifiers (`export ... from './client/api-client'`).
 * Node's ESM resolver requires full paths, so importing the package throws
 * ERR_MODULE_NOT_FOUND before any of our code runs.
 *
 * This rewrites those specifiers in place by resolving each one against the
 * filesystem: `./x` becomes `./x.js` if that file exists, or `./x/index.js` if
 * it is a directory. Already-extensioned and bare-package specifiers are left
 * alone, so the script is idempotent and safe to re-run.
 *
 * Remove this once upstream publishes a fixed build.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = resolve(here, "..", "node_modules", "@snowluma", "sdk", "dist");

/** Matches the specifier in `from "./x"` / `import("./x")` / `require("./x")`. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\2/g;

function resolveSpecifier(fileDir, specifier) {
  // Anything already carrying an extension is fine.
  if (/\.(js|mjs|cjs|json|d\.ts)$/.test(specifier)) return null;

  const target = join(fileDir, specifier);
  if (existsSync(`${target}.js`)) return `${specifier}.js`;
  if (existsSync(target) && statSync(target).isDirectory()) {
    if (existsSync(join(target, "index.js"))) return `${specifier}/index.js`;
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    // .d.ts needs the same treatment: TypeScript's NodeNext resolution is as
    // strict about extensions as Node itself.
    else if (/\.(js|d\.ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

if (!existsSync(sdkDist)) {
  // Nothing installed yet (e.g. `npm ci` ordering, or a consumer without the
  // optional dep). Staying silent keeps this from breaking unrelated installs.
  process.exit(0);
}

let patchedFiles = 0;
let patchedSpecifiers = 0;

for (const file of walk(sdkDist)) {
  const source = readFileSync(file, "utf8");
  const fileDir = dirname(file);
  let changed = 0;

  const next = source.replace(SPECIFIER_RE, (match, head, quote, specifier) => {
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

if (patchedSpecifiers > 0) {
  console.log(
    `[openclaw-snowluma] patched ${patchedSpecifiers} extensionless import(s) across ${patchedFiles} file(s) in @snowluma/sdk`,
  );
}
