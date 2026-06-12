import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  sqlite,
  insertUser,
  getUserByName,
  getUserById,
  insertSession,
  getSession,
  deleteSession,
  insertRating,
  insertLedgerEntry,
  getRating,
  coinBalance,
  type UserRow,
  type RatingRow,
} from './db.js';
import { SESSION_TTL_DAYS } from './env.js';
import { divisionFor } from './elo.js';
import { rateLimit } from './ratelimit.js';

/** Coins granted to every new account. */
export const SIGNUP_COIN_GRANT = 100;

// --- Password hashing (scrypt, no native deps) ---

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT_PARAMS);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// --- Sessions ---

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionFor(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  insertSession.run(hashToken(token), userId, expires);
  return token;
}

export function resolveToken(token: string): UserRow | undefined {
  const session = getSession.get(hashToken(token)) as { user_id: number } | undefined;
  if (!session) return undefined;
  return getUserById.get(session.user_id) as UserRow | undefined;
}

// --- Hono middleware ---

export interface AuthEnv {
  Variables: { userId: number; username: string };
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? resolveToken(token) : undefined;
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('userId', user.id);
  c.set('username', user.username);
  await next();
});

// --- Account creation helpers ---

const createAccount = sqlite.transaction(
  (username: string, passwordHash: string | null, isGuest: boolean): UserRow => {
    const user = insertUser.get(username, passwordHash, isGuest ? 1 : 0) as UserRow;
    insertRating.run(user.id);
    insertLedgerEntry.run(
      user.id,
      SIGNUP_COIN_GRANT,
      'signup_grant',
      null,
      `signup:${user.id}`,
    );
    return user;
  },
);

export function profileFor(user: UserRow) {
  const rating = getRating.get(user.id) as RatingRow;
  return {
    id: user.id,
    username: user.username,
    isGuest: user.is_guest === 1,
    elo: rating.elo,
    division: divisionFor(rating.elo),
    gamesPlayed: rating.games_played,
    wins: rating.wins,
    coins: coinBalance(user.id),
  };
}

// --- Routes ---

const USERNAME = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, and underscores only');
const PASSWORD = z.string().min(8).max(128);

export const authRoutes = new Hono<AuthEnv>();

// The only unauthenticated, write-capable endpoints — cap per IP
const authLimiter = rateLimit(30, 60_000);

authRoutes.post(
  '/register',
  authLimiter,
  zValidator('json', z.object({ username: USERNAME, password: PASSWORD })),
  (c) => {
    const { username, password } = c.req.valid('json');
    if (getUserByName.get(username)) {
      return c.json({ error: 'Username is taken' }, 409);
    }
    const user = createAccount(username, hashPassword(password), false);
    const token = createSessionFor(user.id);
    return c.json({ token, profile: profileFor(user) }, 201);
  },
);

authRoutes.post(
  '/login',
  authLimiter,
  zValidator('json', z.object({ username: USERNAME, password: PASSWORD })),
  (c) => {
    const { username, password } = c.req.valid('json');
    const user = getUserByName.get(username) as UserRow | undefined;
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }
    const token = createSessionFor(user.id);
    return c.json({ token, profile: profileFor(user) });
  },
);

/** Frictionless guest account: server generates a name; token is the only key. */
authRoutes.post('/guest', authLimiter, (c) => {
  let user: UserRow | undefined;
  for (let attempt = 0; attempt < 5 && !user; attempt++) {
    const name = `guest_${randomBytes(4).toString('hex')}`;
    if (!getUserByName.get(name)) {
      user = createAccount(name, null, true);
    }
  }
  if (!user) return c.json({ error: 'Could not create guest account' }, 500);
  const token = createSessionFor(user.id);
  return c.json({ token, profile: profileFor(user) }, 201);
});

authRoutes.post('/logout', requireAuth, (c) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) deleteSession.run(hashToken(token));
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => {
  const user = getUserById.get(c.get('userId')) as UserRow;
  return c.json({ profile: profileFor(user) });
});
