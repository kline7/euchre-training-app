import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './auth.js';
import { gameRoutes } from './games.js';
import { leaderboardRoutes } from './leaderboard.js';
import { friendRoutes } from './friends.js';
import { teamRoutes } from './teams.js';
import { CORS_ORIGINS } from './env.js';

/** Build the Hono app (no listener) — shared by index.ts and tests. */
export function buildApp() {
  const app = new Hono();

  if (process.env.NODE_ENV !== 'test') {
    app.use(logger());
  }
  app.use(
    '/api/*',
    cors({
      origin: CORS_ORIGINS,
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    }),
  );
  app.use('/api/*', bodyLimit({ maxSize: 512 * 1024 }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.route('/api/auth', authRoutes);
  app.route('/api/games', gameRoutes);
  app.route('/api/leaderboard', leaderboardRoutes);
  app.route('/api/friends', friendRoutes);
  app.route('/api/teams', teamRoutes);

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
