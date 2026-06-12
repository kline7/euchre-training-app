import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const app = buildApp();

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

let token = '';

beforeAll(async () => {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'secret-pass-1' }),
  });
  expect(res.status).toBe(201);
  const body = await json(res);
  token = body.token as string;
});

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  };
}

describe('auth', () => {
  it('register grants signup coins and default elo', async () => {
    const res = await app.request('/api/auth/me', authed());
    expect(res.status).toBe(200);
    const { profile } = (await json(res)) as { profile: Record<string, unknown> };
    expect(profile.username).toBe('tester');
    expect(profile.elo).toBe(1200);
    expect(profile.coins).toBe(100);
  });

  it('rejects duplicate usernames (case-insensitive)', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'TESTER', password: 'another-pass-1' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects bad credentials', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('login works with correct credentials', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'secret-pass-1' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).token).toBeTruthy();
  });

  it('creates guest accounts without a password', async () => {
    const res = await app.request('/api/auth/guest', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.token).toBeTruthy();
    expect((body.profile as Record<string, unknown>).isGuest).toBe(true);
  });

  it('rejects invalid registration payloads', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'short' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('games API', () => {
  it('requires auth', async () => {
    const res = await app.request('/api/games');
    expect(res.status).toBe(401);
  });

  it('validates the create payload', async () => {
    const bad = await app.request(
      '/api/games',
      authed({ method: 'POST', body: JSON.stringify({ seed: 'junk', difficulty: 99 }) }),
    );
    expect(bad.status).toBe(400);
  });

  it('rejects malformed JSON with a 400, not a 500', async () => {
    const res = await app.request(
      '/api/games',
      authed({ method: 'POST', body: '{not json' }),
    );
    expect([400]).toContain(res.status);
  });

  it('creates, lists, fetches, and updates a game', async () => {
    const created = await app.request(
      '/api/games',
      authed({ method: 'POST', body: JSON.stringify({ seed: 12345, difficulty: 2 }) }),
    );
    expect(created.status).toBe(201);
    const game = (await json(created)) as { id: number };

    const list = await app.request('/api/games?limit=10', authed());
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBeGreaterThan(0);

    const fetched = await app.request(`/api/games/${game.id}`, authed());
    expect(fetched.status).toBe(200);

    const updated = await app.request(
      `/api/games/${game.id}`,
      authed({
        method: 'PATCH',
        body: JSON.stringify({ finalScore: [10, 7] }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(((await json(updated)) as { finalScore: number[] }).finalScore).toEqual([10, 7]);
  });

  it('rejects out-of-range finalScore and oversized limits', async () => {
    const created = await app.request(
      '/api/games',
      authed({ method: 'POST', body: JSON.stringify({ seed: 1, difficulty: 0 }) }),
    );
    const game = (await json(created)) as { id: number };

    const bad = await app.request(
      `/api/games/${game.id}`,
      authed({ method: 'PATCH', body: JSON.stringify({ finalScore: [99, -1] }) }),
    );
    expect(bad.status).toBe(400);

    const badLimit = await app.request('/api/games?limit=-1', authed());
    expect(badLimit.status).toBe(400);

    const badId = await app.request('/api/games/abc', authed());
    expect(badId.status).toBe(400);
  });

  it("cannot read or write another user's games", async () => {
    // First user creates a game
    const created = await app.request(
      '/api/games',
      authed({ method: 'POST', body: JSON.stringify({ seed: 777, difficulty: 1 }) }),
    );
    const game = (await json(created)) as { id: number };

    // Second user cannot see it
    const other = await app.request('/api/auth/guest', { method: 'POST' });
    const otherToken = ((await json(other)) as { token: string }).token;
    const stolen = await app.request(`/api/games/${game.id}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(stolen.status).toBe(404);

    const tampered = await app.request(`/api/games/${game.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherToken}`,
      },
      body: JSON.stringify({ finalScore: [10, 0] }),
    });
    expect(tampered.status).toBe(404);
  });

  it('has a health check', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });
});
