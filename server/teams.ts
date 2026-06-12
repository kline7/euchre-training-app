import { Hono } from 'hono';
import { listTeamsForUser, type TeamRow } from './db.js';
import { requireAuth, type AuthEnv } from './auth.js';
import { divisionFor } from './elo.js';

export interface TeamView {
  id: number;
  members: [string, string];
  elo: number;
  division: string;
  gamesPlayed: number;
  wins: number;
}

export function teamView(
  row: TeamRow & { lo_username?: string; hi_username?: string },
  loName: string,
  hiName: string,
): TeamView {
  return {
    id: row.id,
    members: [loName, hiName],
    elo: row.elo,
    division: divisionFor(row.elo),
    gamesPlayed: row.games_played,
    wins: row.wins,
  };
}

export const teamRoutes = new Hono<AuthEnv>();

teamRoutes.use('*', requireAuth);

/** All persistent teams the current user belongs to, best first. */
teamRoutes.get('/mine', (c) => {
  const rows = listTeamsForUser.all(c.get('userId'), c.get('userId')) as (TeamRow & {
    lo_username: string;
    hi_username: string;
  })[];
  return c.json(rows.map((r) => teamView(r, r.lo_username, r.hi_username)));
});
