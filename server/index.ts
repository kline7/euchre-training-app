import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { setupWebSocket } from './ws.js';
import { sqlite, abandonStaleMatches } from './db.js';
import { PORT, TURN_TIMEOUT_MS } from './env.js';
import { DEFAULT_TIMINGS } from './match.js';

// Matches from a previous process can never resume — mark them abandoned
const stale = abandonStaleMatches();
if (stale > 0) {
  console.log(`Cleaned up ${stale} stale active match(es) from a previous run`);
}

const app = buildApp();
const { injectWebSocket, matchmaker } = setupWebSocket(app, {
  ...DEFAULT_TIMINGS,
  turnTimeoutMs: TURN_TIMEOUT_MS,
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Euchre server running on http://localhost:${info.port}`);
});
injectWebSocket(server);

function shutdown(signal: string) {
  console.log(`${signal} received — shutting down`);
  matchmaker.stop();
  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
  // Hard exit if connections refuse to drain
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
