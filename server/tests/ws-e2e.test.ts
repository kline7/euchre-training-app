import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { buildApp } from '../app.js';
import { setupWebSocket } from '../ws.js';
import type { Matchmaker } from '../matchmaking.js';

/**
 * Full-stack test: real HTTP + WebSocket server, four real WebSocket
 * clients implementing minimal legal bots, one complete rated match.
 */

let server: ServerType;
let matchmaker: Matchmaker;
let baseUrl = '';
let wsUrl = '';

beforeAll(async () => {
  const app = buildApp();
  const ws = setupWebSocket(app, {
    turnTimeoutMs: 30_000, // bots act; the clock should never fire
    disconnectedTurnMs: 30_000,
    trickPauseMs: 2,
    interHandPauseMs: 2,
  });
  matchmaker = ws.matchmaker;
  server = serve({ fetch: app.fetch, port: 0 });
  ws.injectWebSocket(server);
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  matchmaker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface CardData {
  suit: number;
  rank: number;
}

interface StateMsg {
  type: 'state';
  yourSeat: number;
  phase: number;
  hand: CardData[];
  legalPlays: CardData[];
  nextToPlay: number;
  dealer: number;
  turnedDownSuit: number;
  scores: [number, number];
}

/** A minimal legal euchre bot speaking the wire protocol. */
class BotClient {
  ws!: WebSocket;
  seat = -1;
  messages: Record<string, unknown>[] = [];
  gameOver: Record<string, unknown> | null = null;
  errors: string[] = [];
  profile: Record<string, unknown> | null = null;

  constructor(readonly token: string) {}

  async connect() {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    this.ws.addEventListener('message', (evt) => this.onMessage(String(evt.data)));
    this.send({ type: 'auth', token: this.token });
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    this.messages.push(msg);
    switch (msg.type) {
      case 'match_found':
        this.seat = msg.seat as number;
        break;
      case 'state':
        this.act(msg as unknown as StateMsg);
        break;
      case 'game_over':
        this.gameOver = msg;
        break;
      case 'error':
        this.errors.push(msg.message as string);
        break;
    }
  }

  /** Act when it is our turn, using only information a real client has. */
  private act(state: StateMsg) {
    if (state.nextToPlay !== state.yourSeat) return;
    switch (state.phase) {
      case 1: // round 1: always pass (always legal)
        this.send({ type: 'action', action: { type: 'bid', bid: 0 } });
        break;
      case 2: {
        // round 2: dealer is stuck and must call; others pass
        if (state.yourSeat === state.dealer) {
          const suit = (state.turnedDownSuit + 1) % 4;
          this.send({ type: 'action', action: { type: 'bid', bid: 2 + suit } });
        } else {
          this.send({ type: 'action', action: { type: 'bid', bid: 0 } });
        }
        break;
      }
      case 3: // dealer discard
        this.send({ type: 'action', action: { type: 'discard', card: state.hand[0] } });
        break;
      case 4: // play the first legal card
        if (state.legalPlays.length > 0) {
          this.send({ type: 'action', action: { type: 'play', card: state.legalPlays[0] } });
        }
        break;
    }
  }

  close() {
    this.ws.close();
  }
}

async function createGuest(): Promise<{ token: string; username: string }> {
  const res = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; profile: { username: string } };
  return { token: body.token, username: body.profile.username };
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('WebSocket end-to-end', () => {
  it('four clients queue, match by elo, play a full rated game, and get paid', async () => {
    const bots: BotClient[] = [];
    for (let i = 0; i < 4; i++) {
      const { token } = await createGuest();
      const bot = new BotClient(token);
      await bot.connect();
      bots.push(bot);
    }

    // Everyone authenticated
    await waitFor(() => bots.every((b) => b.messages.some((m) => m.type === 'auth_ok')));

    // Join the queue; all 1200-elo guests are instantly compatible
    for (const bot of bots) bot.send({ type: 'queue_join' });
    await waitFor(() => bots.every((b) => b.seat >= 0));

    // Seats are distinct 0-3
    expect(new Set(bots.map((b) => b.seat)).size).toBe(4);

    // The bots play the entire game over the wire
    await waitFor(() => bots.every((b) => b.gameOver !== null), 120_000);

    const over = bots[0].gameOver as {
      winningTeam: number;
      scores: [number, number];
      results: { seat: number; eloDelta: number; coinsAwarded: number }[];
    };
    expect(over.scores[over.winningTeam]).toBeGreaterThanOrEqual(10);
    expect(over.results).toHaveLength(4);

    // No bot ever submitted an illegal action
    for (const bot of bots) {
      expect(bot.errors).toEqual([]);
    }

    // Winners earned coins on top of the 100 signup grant — verify via REST
    for (const bot of bots) {
      const me = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${bot.token}` },
      });
      const { profile } = (await me.json()) as {
        profile: { coins: number; elo: number; gamesPlayed: number };
      };
      const result = over.results.find((r) => r.seat === bots.indexOf(bot) || true)!;
      expect(profile.gamesPlayed).toBe(1);
      const mine = over.results.find((r) => r.seat === bot.seat)!;
      expect(profile.coins).toBe(100 + mine.coinsAwarded);
      expect(profile.elo).toBe(1200 + mine.eloDelta);
      void result;
    }

    // Leaderboard now has 4 rated players
    const lb = await fetch(`${baseUrl}/api/leaderboard`, {
      headers: { Authorization: `Bearer ${bots[0].token}` },
    });
    expect(lb.status).toBe(200);
    expect(((await lb.json()) as unknown[]).length).toBe(4);

    // Presence: every client was told who is online; during the match the
    // in-game count covered all four players
    const presenceMsgs = bots[0].messages.filter((m) => m.type === 'presence');
    expect(presenceMsgs.length).toBeGreaterThan(0);
    expect(Math.max(...presenceMsgs.map((m) => m.online as number))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...presenceMsgs.map((m) => m.inGame as number))).toBeGreaterThanOrEqual(4);

    // The public REST endpoint reports the same counts (no auth required)
    const presence = await fetch(`${baseUrl}/api/presence`);
    expect(presence.status).toBe(200);
    const stats = (await presence.json()) as { online: number; inQueue: number; inGame: number };
    expect(stats.online).toBeGreaterThanOrEqual(4); // bots still connected
    expect(stats.inGame).toBe(0); // match is over
    expect(stats.inQueue).toBe(0);

    for (const bot of bots) bot.close();
  }, 180_000);

  it('rejects unauthenticated sockets and bad tokens', async () => {
    const ws = new WebSocket(wsUrl);
    const messages: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve(), { once: true }));
    ws.addEventListener('message', (evt) => messages.push(JSON.parse(String(evt.data))));

    ws.send(JSON.stringify({ type: 'queue_join' }));
    await waitFor(() => messages.some((m) => m.type === 'error'));
    expect(messages.find((m) => m.type === 'error')?.message).toMatch(/authenticate/);

    const closed = new Promise<void>((resolve) =>
      ws.addEventListener('close', () => resolve(), { once: true }),
    );
    ws.send(JSON.stringify({ type: 'auth', token: 'bogus' }));
    await closed; // server closes bad-token sockets
  }, 30_000);
});
