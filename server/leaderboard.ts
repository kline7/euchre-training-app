import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sqlite, topTeams } from './db.js';
import { requireAuth, type AuthEnv } from './auth.js';
import { divisionFor } from './elo.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['players', 'teams']).default('players'),
});

const topRatings = sqlite.prepare(
  `SELECT u.username, r.elo, r.games_played AS gamesPlayed, r.wins
   FROM ratings r JOIN users u ON u.id = r.user_id
   WHERE r.games_played > 0
   ORDER BY r.elo DESC, r.wins DESC
   LIMIT ?`,
);

export const leaderboardRoutes = new Hono<AuthEnv>();

leaderboardRoutes.get('/', requireAuth, zValidator('query', listQuery), (c) => {
  const { limit, type } = c.req.valid('query');
  if (type === 'teams') {
    const rows = topTeams.all(limit) as {
      elo: number;
      gamesPlayed: number;
      wins: number;
      member1: string;
      member2: string;
    }[];
    return c.json(rows.map((r) => ({ ...r, division: divisionFor(r.elo) })));
  }
  const rows = topRatings.all(limit) as {
    username: string;
    elo: number;
    gamesPlayed: number;
    wins: number;
  }[];
  return c.json(rows.map((r) => ({ ...r, division: divisionFor(r.elo) })));
});
