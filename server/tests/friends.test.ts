import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const app = buildApp();

interface Session {
  token: string;
  username: string;
}

async function makeGuest(): Promise<Session> {
  const res = await app.request('/api/auth/guest', { method: 'POST' });
  const body = (await res.json()) as { token: string; profile: { username: string } };
  return { token: body.token, username: body.profile.username };
}

function authed(s: Session, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.token}`,
      ...(init.headers ?? {}),
    },
  };
}

let alice: Session;
let bob: Session;
let carol: Session;

beforeAll(async () => {
  alice = await makeGuest();
  bob = await makeGuest();
  carol = await makeGuest();
});

describe('friends API', () => {
  it('requires auth', async () => {
    const res = await app.request('/api/friends');
    expect(res.status).toBe(401);
  });

  it('sends a request, shows pending on both sides, then accepts', async () => {
    const send = await app.request(
      '/api/friends/request',
      authed(alice, { method: 'POST', body: JSON.stringify({ username: bob.username }) }),
    );
    expect(send.status).toBe(201);

    const aliceList = (await (await app.request('/api/friends', authed(alice))).json()) as {
      username: string;
      status: string;
    }[];
    expect(aliceList.find((f) => f.username === bob.username)?.status).toBe('outgoing');

    const bobList = (await (await app.request('/api/friends', authed(bob))).json()) as {
      username: string;
      status: string;
      division: string;
    }[];
    const incoming = bobList.find((f) => f.username === alice.username);
    expect(incoming?.status).toBe('incoming');
    expect(incoming?.division).toBe('Silver'); // 1200 elo

    const accept = await app.request(
      '/api/friends/respond',
      authed(bob, {
        method: 'POST',
        body: JSON.stringify({ username: alice.username, accept: true }),
      }),
    );
    expect(accept.status).toBe(200);

    const after = (await (await app.request('/api/friends', authed(alice))).json()) as {
      username: string;
      status: string;
    }[];
    expect(after.find((f) => f.username === bob.username)?.status).toBe('friends');
  });

  it('rejects duplicate requests and self-friending', async () => {
    const dup = await app.request(
      '/api/friends/request',
      authed(alice, { method: 'POST', body: JSON.stringify({ username: bob.username }) }),
    );
    expect(dup.status).toBe(409);

    const self = await app.request(
      '/api/friends/request',
      authed(alice, { method: 'POST', body: JSON.stringify({ username: alice.username }) }),
    );
    expect(self.status).toBe(400);

    const ghost = await app.request(
      '/api/friends/request',
      authed(alice, { method: 'POST', body: JSON.stringify({ username: 'nobody_here_404' }) }),
    );
    expect(ghost.status).toBe(404);
  });

  it('declining removes the request', async () => {
    await app.request(
      '/api/friends/request',
      authed(carol, { method: 'POST', body: JSON.stringify({ username: alice.username }) }),
    );
    const decline = await app.request(
      '/api/friends/respond',
      authed(alice, {
        method: 'POST',
        body: JSON.stringify({ username: carol.username, accept: false }),
      }),
    );
    expect(decline.status).toBe(200);
    const list = (await (await app.request('/api/friends', authed(carol))).json()) as {
      username: string;
    }[];
    expect(list.find((f) => f.username === alice.username)).toBeUndefined();
  });

  it('cross-requesting auto-accepts', async () => {
    await app.request(
      '/api/friends/request',
      authed(carol, { method: 'POST', body: JSON.stringify({ username: bob.username }) }),
    );
    const back = await app.request(
      '/api/friends/request',
      authed(bob, { method: 'POST', body: JSON.stringify({ username: carol.username }) }),
    );
    expect(back.status).toBe(200);
    const list = (await (await app.request('/api/friends', authed(bob))).json()) as {
      username: string;
      status: string;
    }[];
    expect(list.find((f) => f.username === carol.username)?.status).toBe('friends');
  });

  it('unfriending works', async () => {
    const res = await app.request(`/api/friends/${bob.username}`, authed(alice, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    const list = (await (await app.request('/api/friends', authed(alice))).json()) as {
      username: string;
    }[];
    expect(list.find((f) => f.username === bob.username)).toBeUndefined();
  });

  it('profile and leaderboard include divisions', async () => {
    const me = await app.request('/api/auth/me', authed(alice));
    const { profile } = (await me.json()) as { profile: { division: string } };
    expect(profile.division).toBe('Silver');

    const teams = await app.request('/api/leaderboard?type=teams', authed(alice));
    expect(teams.status).toBe(200);
    expect(Array.isArray(await teams.json())).toBe(true);
  });

  it('lists my teams with division info', async () => {
    const res = await app.request('/api/teams/mine', authed(alice));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
