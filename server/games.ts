import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createGame, getGame, listRecentGames, updateGame } from './db.js';
import { requireAuth, type AuthEnv } from './auth.js';

/**
 * Solo training game records. These are user-scoped training history —
 * gameplay itself runs client-side (WASM) for solo games; only multiplayer
 * is server-adjudicated. Validation here protects data integrity, not
 * competitive fairness (solo records never feed Elo or coins).
 */

const card = z.object({
  suit: z.number().int().min(0).max(3),
  rank: z.number().int().min(0).max(5),
});

const play = z.object({ seat: z.number().int().min(0).max(3), card });

const bid = z.object({
  seat: z.number().int().min(0).max(3),
  action: z.number().int().min(0).max(10),
});

const handResult = z.object({
  tricks: z.tuple([z.number().int().min(0).max(5), z.number().int().min(0).max(5)]),
  points: z.number().int().min(-4).max(4),
  isEuchre: z.boolean(),
  isSweep: z.boolean(),
});

const handRecord = z
  .object({
    deal: z.array(z.array(card).max(6)).max(4),
    bids: z.array(bid).max(16),
    plays: z.array(play).max(24),
    result: handResult,
    alone: z.boolean().optional(),
    sittingOut: z.number().int().min(-1).max(3).optional(),
  })
  .passthrough();

const decision = z
  .object({
    played: card,
    optimal: card,
    wpc: z.number(),
    etd: z.number(),
    grade: z.string().max(20),
  })
  .passthrough();

const handAnalysis = z
  .object({
    decisions: z.array(decision).max(30),
    totalWpc: z.number(),
    totalEtd: z.number(),
  })
  .passthrough();

const score = z.tuple([
  z.number().int().min(0).max(14),
  z.number().int().min(0).max(14),
]);

const createGameBody = z.object({
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  difficulty: z.number().int().min(0).max(3),
});

const updateGameBody = z.object({
  hands: z.array(handRecord).max(50).optional(),
  finalScore: score.optional(),
  analysis: z.array(handAnalysis).max(50).optional(),
});

const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const gameRoutes = new Hono<AuthEnv>();

gameRoutes.use('*', requireAuth);

gameRoutes.post('/', zValidator('json', createGameBody), (c) => {
  const { seed, difficulty } = c.req.valid('json');
  const game = createGame(c.get('userId'), seed, difficulty);
  return c.json(game, 201);
});

gameRoutes.get('/', zValidator('query', listQuery), (c) => {
  const { limit } = c.req.valid('query');
  return c.json(listRecentGames(c.get('userId'), limit));
});

gameRoutes.get('/:id', zValidator('param', idParam), (c) => {
  const { id } = c.req.valid('param');
  const game = getGame(c.get('userId'), id);
  if (!game) return c.json({ error: 'Not found' }, 404);
  return c.json(game);
});

gameRoutes.patch(
  '/:id',
  zValidator('param', idParam),
  zValidator('json', updateGameBody),
  (c) => {
    const { id } = c.req.valid('param');
    const game = updateGame(c.get('userId'), id, c.req.valid('json'));
    if (!game) return c.json({ error: 'Not found' }, 404);
    return c.json(game);
  },
);
