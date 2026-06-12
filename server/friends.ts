import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  getUserByName,
  getFriendship,
  insertFriendship,
  acceptFriendship,
  deleteFriendship,
  listFriendships,
  getRating,
  pairKey,
  type UserRow,
  type FriendshipRow,
  type RatingRow,
} from './db.js';
import { requireAuth, type AuthEnv } from './auth.js';
import { divisionFor } from './elo.js';

const usernameBody = z.object({ username: z.string().min(3).max(20) });

export interface FriendView {
  username: string;
  elo: number;
  division: string;
  /** 'friends' | 'incoming' (they asked you) | 'outgoing' (you asked them) */
  status: 'friends' | 'incoming' | 'outgoing';
}

export function friendsOf(userId: number): FriendView[] {
  const rows = listFriendships.all(userId, userId) as (FriendshipRow & {
    lo_username: string;
    hi_username: string;
  })[];
  return rows.map((row) => {
    const otherId = row.user_lo === userId ? row.user_hi : row.user_lo;
    const otherName = row.user_lo === userId ? row.hi_username : row.lo_username;
    const rating = getRating.get(otherId) as RatingRow | undefined;
    const elo = rating?.elo ?? 1200;
    const status: FriendView['status'] =
      row.status === 'accepted'
        ? 'friends'
        : row.requested_by === userId
          ? 'outgoing'
          : 'incoming';
    return { username: otherName, elo, division: divisionFor(elo), status };
  });
}

export const friendRoutes = new Hono<AuthEnv>();

friendRoutes.use('*', requireAuth);

friendRoutes.get('/', (c) => {
  return c.json(friendsOf(c.get('userId')));
});

/** Send a friend request (or accept a pending incoming one). */
friendRoutes.post('/request', zValidator('json', usernameBody), (c) => {
  const me = c.get('userId');
  const target = getUserByName.get(c.req.valid('json').username) as UserRow | undefined;
  if (!target) return c.json({ error: 'No such player' }, 404);
  if (target.id === me) return c.json({ error: 'That is you' }, 400);

  const [lo, hi] = pairKey(me, target.id);
  const existing = getFriendship.get(lo, hi) as FriendshipRow | undefined;
  if (existing) {
    if (existing.status === 'accepted') return c.json({ error: 'Already friends' }, 409);
    if (existing.requested_by === me) return c.json({ error: 'Request already sent' }, 409);
    // They already asked us — sending a request back means accepting
    acceptFriendship.run(lo, hi);
    return c.json({ ok: true, status: 'friends' });
  }
  insertFriendship.run(lo, hi, me);
  return c.json({ ok: true, status: 'outgoing' }, 201);
});

/** Accept or decline an incoming request. */
friendRoutes.post(
  '/respond',
  zValidator('json', usernameBody.extend({ accept: z.boolean() })),
  (c) => {
    const me = c.get('userId');
    const { username, accept } = c.req.valid('json');
    const target = getUserByName.get(username) as UserRow | undefined;
    if (!target) return c.json({ error: 'No such player' }, 404);

    const [lo, hi] = pairKey(me, target.id);
    const existing = getFriendship.get(lo, hi) as FriendshipRow | undefined;
    if (!existing || existing.status !== 'pending' || existing.requested_by === me) {
      return c.json({ error: 'No pending request from that player' }, 404);
    }
    if (accept) {
      acceptFriendship.run(lo, hi);
      return c.json({ ok: true, status: 'friends' });
    }
    deleteFriendship.run(lo, hi);
    return c.json({ ok: true, status: 'declined' });
  },
);

/** Remove a friend (or cancel an outgoing request). */
friendRoutes.delete('/:username', (c) => {
  const me = c.get('userId');
  const target = getUserByName.get(c.req.param('username')) as UserRow | undefined;
  if (!target) return c.json({ error: 'No such player' }, 404);
  const [lo, hi] = pairKey(me, target.id);
  deleteFriendship.run(lo, hi);
  return c.json({ ok: true });
});
