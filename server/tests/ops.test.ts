import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import {
  sqlite,
  insertMatch,
  abandonStaleMatches,
  getMatchStmt,
} from '../db.js';

describe('stale match cleanup', () => {
  it('abandons active matches left over from a previous process', () => {
    const { id: a } = insertMatch.get('solo_rated') as { id: number };
    const { id: b } = insertMatch.get('team_vs_ai') as { id: number };
    // One already-finished match must be untouched
    const { id: done } = insertMatch.get('solo_rated') as { id: number };
    sqlite
      .prepare(`UPDATE matches SET status = 'complete', winning_team = 0 WHERE id = ?`)
      .run(done);

    const cleaned = abandonStaleMatches();
    expect(cleaned).toBe(2);

    expect((getMatchStmt.get(a) as { status: string }).status).toBe('abandoned');
    expect((getMatchStmt.get(b) as { status: string }).status).toBe('abandoned');
    expect((getMatchStmt.get(done) as { status: string }).status).toBe('complete');

    // Idempotent: nothing left to clean
    expect(abandonStaleMatches()).toBe(0);
  });
});

describe('auth rate limiting', () => {
  it('caps unauthenticated requests per IP and recovers per window', async () => {
    const app = buildApp();
    const headers = { 'X-Forwarded-For': '203.0.113.7' };

    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const res = await app.request('/api/auth/guest', { method: 'POST', headers });
      if (res.status === 429) limited++;
      else expect(res.status).toBe(201);
    }
    // 30/min allowed → the last 5 are rejected
    expect(limited).toBe(5);

    // A different IP is unaffected
    const other = await app.request('/api/auth/guest', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.8' },
    });
    expect(other.status).toBe(201);

    // Authenticated endpoints are NOT rate limited (e.g. /me polling)
    const body = (await other.json()) as { token: string };
    for (let i = 0; i < 40; i++) {
      const me = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(me.status).toBe(200);
    }
  });

  it('limits login and register through the same counter surface', async () => {
    const app = buildApp();
    const headers = {
      'X-Forwarded-For': '203.0.113.9',
      'Content-Type': 'application/json',
    };
    // Burn the budget with bad logins
    for (let i = 0; i < 30; i++) {
      await app.request('/api/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'nobody_x', password: 'wrongpassword' }),
      });
    }
    const blocked = await app.request('/api/auth/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'brute_force', password: 'longenough1' }),
    });
    expect(blocked.status).toBe(429);
  });
});
