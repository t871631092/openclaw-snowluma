/**
 * Global vitest setup: pre-load `@snowluma/sdk` into the lazy registry
 * (src/sdk.ts) so tests that reach `getSnowLumaSdk()` synchronously — segment
 * parsing, outbound builders, the default client factory — behave exactly as
 * they do in production, where `startGateway`/`acquireActionClient` always
 * ensure the SDK first. Cases that specifically test the "not loaded" path
 * reset the registry via `__setSnowLumaSdkForTests` and restore it afterwards.
 */
import { ensureSnowLumaSdk } from "../../src/sdk.js";

await ensureSnowLumaSdk();
