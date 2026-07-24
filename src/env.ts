/**
 * Environment-variable fallbacks, isolated here so the rest of the plugin never
 * touches `process.env` directly (which keeps it trivially testable).
 */

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDefaultWsUrl(): string | undefined {
  return readEnv("SNOWLUMA_WS_URL");
}

export function getDefaultHttpUrl(): string | undefined {
  return readEnv("SNOWLUMA_HTTP_URL");
}

export function getDefaultAccessToken(): string | undefined {
  return readEnv("SNOWLUMA_ACCESS_TOKEN") ?? readEnv("SNOWLUMA_TOKEN");
}

export function getDefaultSelfId(): number | undefined {
  const raw = readEnv("SNOWLUMA_SELF_ID");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
