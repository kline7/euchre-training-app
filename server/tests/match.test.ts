import { describe, expect, it } from 'vitest';
import {
  sqlite,
  insertUser,
  insertRating,
  getRating,
  coinBalance,
  getMatchStmt,
  getMatchActionsStmt,
  type UserRow,
  type RatingRow,
} from '../db.js';
import { MatchSession, type SeatMessage } from '../match.js';
import { WIN_COIN_REWARD } from '../elo.js';

const FAST = {
  turnTimeoutMs: 3,
  disconnectedTurnMs: 3,
  trickPauseMs: 1,
  interHandPauseMs: 1,
};

let userCounter = 0;
function makeUser(): UserRow {
  userCounter += 1;
  const user = insertUser.get(`player_${userCounter}`, null, 1) as UserRow;
  insertRating.run(user.id);
  return user;
}

function makePlayers() {
  return [0, 1, 2, 3].map((seat) => {
    const u = makeUser();
    return { userId: u.id, username: u.username, elo: 1200, seat };
  });
}

type Inbox = Map<number, SeatMessage[]>;

function startMatch(timings = FAST) {
  const inbox: Inbox = new Map([[0, []], [1, []], [2, []], [3, []]]);
  const players = makePlayers();
  const session = new MatchSession(
    players,
    (seat, msg) => inbox.get(seat)!.push(msg),
    timings,
  );
  return { session, inbox, players };
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('MatchSession', () => {
  it('plays a complete server-authoritative game and settles elo + coins', async () => {
    const { session, inbox, players } = startMatch();
    session.start();

    // The server's turn clock auto-plays every seat (expert AI) — the whole
    // game runs to completion without any client input.
    await waitFor(() => inbox.get(0)!.some((m) => m.type === 'game_over'));

    const gameOver = inbox.get(0)!.find((m) => m.type === 'game_over')!;
    if (gameOver.type !== 'game_over') throw new Error('unreachable');

    // A team actually won with a valid euchre score
    expect([0, 1]).toContain(gameOver.winningTeam);
    const winnerScore = gameOver.scores[gameOver.winningTeam];
    expect(winnerScore).toBeGreaterThanOrEqual(10);

    // Every seat got the same outcome
    for (const seat of [1, 2, 3]) {
      const msg = inbox.get(seat)!.find((m) => m.type === 'game_over');
      expect(msg).toBeTruthy();
    }

    // Elo settled: winners up, losers down, zero-sum
    const deltas = gameOver.results.map((r) => r.eloDelta);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(0);
    for (const r of gameOver.results) {
      const isWinner = r.seat % 2 === gameOver.winningTeam;
      if (isWinner) {
        expect(r.eloDelta).toBeGreaterThan(0);
        expect(r.coinsAwarded).toBe(WIN_COIN_REWARD);
      } else {
        expect(r.eloDelta).toBeLessThan(0);
        expect(r.coinsAwarded).toBe(0);
      }
    }

    // Database state matches: ratings, coins, match row, action log
    for (const p of players) {
      const rating = getRating.get(p.userId) as RatingRow;
      const result = gameOver.results.find((r) => r.seat === p.seat)!;
      expect(rating.elo).toBe(result.eloAfter);
      expect(rating.games_played).toBe(1);
      expect(coinBalance(p.userId)).toBe(result.coinsAwarded); // no signup grant in this test path
    }

    const matchRow = getMatchStmt.get(session.id) as { status: string; winning_team: number };
    expect(matchRow.status).toBe('complete');
    expect(matchRow.winning_team).toBe(gameOver.winningTeam);

    // Append-only action log exists and is replay-shaped
    const actions = getMatchActionsStmt.all(session.id) as { action_json: string; seq: number }[];
    expect(actions.length).toBeGreaterThan(20);
    const first = JSON.parse(actions[0].action_json);
    expect(first.type).toBe('deal');
    expect(typeof first.seed).toBe('number'); // server-owned seed
    // Sequences are strictly increasing from 1
    actions.forEach((a, i) => expect(a.seq).toBe(i + 1));
  }, 90_000);

  it('rejects out-of-turn and malformed actions without corrupting state', async () => {
    // Long turn timeout: nothing auto-plays during this test
    const { session, inbox, players } = startMatch({
      ...FAST,
      turnTimeoutMs: 60_000,
      disconnectedTurnMs: 60_000,
    });
    session.start();

    const state = inbox.get(0)!.find((m) => m.type === 'state');
    expect(state).toBeTruthy();
    if (state?.type !== 'state') throw new Error('unreachable');

    const actor = state.nextToPlay;
    const notActor = players.find((p) => p.seat !== actor)!;

    // Out of turn
    session.handleAction(notActor.userId, { type: 'bid', bid: 0 });
    const err = inbox.get(notActor.seat)!.find((m) => m.type === 'error');
    expect(err && err.type === 'error' && err.message).toMatch(/not your turn/);

    // Malformed bid from the actual actor
    const actorPlayer = players.find((p) => p.seat === actor)!;
    session.handleAction(actorPlayer.userId, { type: 'bid', bid: 42 });
    const err2 = inbox.get(actor)!.find((m) => m.type === 'error');
    expect(err2 && err2.type === 'error' && err2.message).toMatch(/invalid bid/);

    // Playing a card during bidding is rejected by the rules engine
    session.handleAction(actorPlayer.userId, {
      type: 'play',
      card: { suit: 0, rank: 0 },
    });
    const errs = inbox.get(actor)!.filter((m) => m.type === 'error');
    expect(errs.length).toBeGreaterThanOrEqual(2);

    // A legal pass from the actor IS accepted
    session.handleAction(actorPlayer.userId, { type: 'bid', bid: 0 });
    const after = inbox
      .get(0)!
      .filter((m) => m.type === 'state')
      .at(-1);
    if (after?.type !== 'state') throw new Error('unreachable');
    expect(after.bidLog.length).toBe(1);

    session.abandon();
  });

  it('information hiding: players only ever see their own cards', async () => {
    const { session, inbox } = startMatch({
      ...FAST,
      turnTimeoutMs: 60_000,
      disconnectedTurnMs: 60_000,
    });
    session.start();

    for (const seat of [0, 1, 2, 3]) {
      const state = inbox.get(seat)!.find((m) => m.type === 'state');
      if (state?.type !== 'state') throw new Error('missing state');
      expect(state.yourSeat).toBe(seat);
      expect(state.hand.length).toBe(5);
      // hand counts are public, but no other hand contents are present
      expect(state.handCounts).toEqual([5, 5, 5, 5]);
    }

    // Hands are disjoint across seats (each player got THEIR hand)
    const allCards = [0, 1, 2, 3].flatMap((seat) => {
      const state = inbox.get(seat)!.find((m) => m.type === 'state');
      return state?.type === 'state' ? state.hand.map((c) => `${c.suit}-${c.rank}`) : [];
    });
    expect(new Set(allCards).size).toBe(20);

    session.abandon();
  });

  it('plays on when a player disconnects and abandons when all leave', async () => {
    const { session, players, inbox } = startMatch();
    session.start();
    // One player drops — the match continues via auto-play
    session.setConnected(players[1].userId, false);
    await waitFor(() => inbox.get(0)!.some((m) => m.type === 'game_over'));
    const matchRow = getMatchStmt.get(session.id) as { status: string };
    expect(matchRow.status).toBe('complete');

    // A fresh match abandoned by everyone
    const second = startMatch({ ...FAST, turnTimeoutMs: 60_000, disconnectedTurnMs: 60_000 });
    second.session.start();
    for (const p of second.players) second.session.setConnected(p.userId, false);
    const row = getMatchStmt.get(second.session.id) as { status: string };
    expect(row.status).toBe('abandoned');
  }, 90_000);

  it('settlement is idempotent: ledger entries cannot double-credit', async () => {
    const { session, inbox, players } = startMatch();
    session.start();
    await waitFor(() => inbox.get(0)!.some((m) => m.type === 'game_over'));

    const winner = players.find((p) => {
      const over = inbox.get(0)!.find((m) => m.type === 'game_over');
      return over?.type === 'game_over' && p.seat % 2 === over.winningTeam;
    })!;
    const before = coinBalance(winner.userId);

    // Replaying the ledger insert with the same idempotency key is a no-op
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO coin_ledger (user_id, amount, reason, match_id, idempotency_key)
         VALUES (?, ?, 'match_win', ?, ?)`,
      )
      .run(winner.userId, WIN_COIN_REWARD, session.id, `match:${session.id}:seat:${winner.seat}:win`);

    expect(coinBalance(winner.userId)).toBe(before);
  }, 90_000);
});
