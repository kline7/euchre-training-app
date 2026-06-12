/** Environment configuration with safe defaults for local development. */

export const PORT = parsePort(process.env.PORT, 3001);
export const DB_PATH = process.env.DB_PATH ?? defaultDbPath();
export const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
/** Seconds a multiplayer player may take before the server acts for them. */
export const TURN_TIMEOUT_MS = parseIntEnv(process.env.TURN_TIMEOUT_MS, 45_000);
/** Session lifetime in days. */
export const SESSION_TTL_DAYS = parseIntEnv(process.env.SESSION_TTL_DAYS, 30);

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function defaultDbPath(): string {
  // Keep the dev database out of the compiled output and source tree root
  return new URL('./euchre.db', import.meta.url).pathname;
}
