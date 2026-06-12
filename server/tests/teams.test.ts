import { describe, expect, it } from 'vitest';
import {
  insertUser,
  insertRating,
  getOrCreateTeam,
  getTeamById,
  getRating,
  coinBalance,
  getMatchStmt,
  sqlite,
  type UserRow,
  type RatingRow,
} from '../db.js';
import { divisionFor, DIVISIONS, WIN_COIN_REWARD } from '../elo.js';
import { MatchSession, type SeatMessage } from '../match.js';

const FAST = {
  turnTimeoutMs: 3,
  disconnectedTurnMs: 3,
  botTurnMs: 2,
  trickPauseMs: 1,
  interHandPauseMs: 1,
};

let counter = 0;
function makeUser(elo = 1200): UserRow {
  counter += 1;
  const user = insertUser.get(`team_user_${counter}`, null, 1) as UserRow;
  insertRating.run(user.id);
  if (elo !== 1200) {
    sqlite.prepare(`UPDATE ratings SET elo = ? WHERE user_id = ?`).run(elo, user.id);
  }
  return user;
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('divisions', () => {
  it('maps elo to the ladder', () => {
    expect(divisionFor(0)).toBe('Bronze');
    expect(divisionFor(1099)).toBe('Bronze');
    expect(divisionFor(1100)).toBe('Silver');
    expect(divisionFor(1200)).toBe('Silver'); // new accounts
    expect(divisionFor(1300)).toBe('Gold');
    expect(divisionFor(1500)).toBe('Platinum');
    expect(divisionFor(1700)).toBe('Diamond');
    expect(divisionFor(1900)).toBe('Master');
    expect(divisionFor(2500)).toBe('Master');
  });

  it('divisions are sorted and contiguous', () => {
    for (let i = 1; i < DIVISIONS.length; i++) {
      expect(DIVISIONS[i].minElo).toBeGreaterThan(DIVISIONS[i - 1].minElo);
    }
  });
});

describe('persistent teams', () => {
  it('a new team starts at the average of member elos (combined rating)', () => {
    const a = makeUser(1400);
    const b = makeUser(1100);
    const team = getOrCreateTeam(a.id, b.id);
    expect(team.elo).toBe(1250);
  });

  it('is the same team regardless of member order', () => {
    const a = makeUser();
    const b = makeUser();
    const t1 = getOrCreateTeam(a.id, b.id);
    const t2 = getOrCreateTeam(b.id, a.id);
    expect(t1.id).toBe(t2.id);
  });
});

describe('team_rated matches', () => {
  it('moves the TEAM elo (not individual elo) and pays winners', async () => {
    const [a1, a2, b1, b2] = [makeUser(), makeUser(), makeUser(), makeUser()];
    const teamA = getOrCreateTeam(a1.id, a2.id);
    const teamB = getOrCreateTeam(b1.id, b2.id);

    const inbox = new Map<number, SeatMessage[]>([[0, []], [1, []], [2, []], [3, []]]);
    const session = new MatchSession(
      [
        { userId: a1.id, username: a1.username, elo: 1200, seat: 0 },
        { userId: b1.id, username: b1.username, elo: 1200, seat: 1 },
        { userId: a2.id, username: a2.username, elo: 1200, seat: 2 },
        { userId: b2.id, username: b2.username, elo: 1200, seat: 3 },
      ],
      (seat, msg) => inbox.get(seat)!.push(msg),
      FAST,
      { mode: 'team_rated', teamIds: { team0: teamA.id, team1: teamB.id } },
    );
    session.start();

    await waitFor(() => inbox.get(0)!.some((m) => m.type === 'game_over'));
    const over = inbox.get(0)!.find((m) => m.type === 'game_over')!;
    if (over.type !== 'game_over') throw new Error('unreachable');

    const winnerTeamRow = over.winningTeam === 0 ? getTeamById(teamA.id) : getTeamById(teamB.id);
    const loserTeamRow = over.winningTeam === 0 ? getTeamById(teamB.id) : getTeamById(teamA.id);

    // Team ratings moved, zero-sum between the two teams
    expect(winnerTeamRow.elo).toBeGreaterThan(1200);
    expect(loserTeamRow.elo).toBeLessThan(1200);
    expect(winnerTeamRow.elo + loserTeamRow.elo).toBe(2400);
    expect(winnerTeamRow.games_played).toBe(1);
    expect(winnerTeamRow.wins).toBe(1);
    expect(loserTeamRow.wins).toBe(0);

    // Individual elo untouched in team matches
    for (const u of [a1, a2, b1, b2]) {
      expect((getRating.get(u.id) as RatingRow).elo).toBe(1200);
    }

    // Winners earned milk coins
    const winners = over.winningTeam === 0 ? [a1.id, a2.id] : [b1.id, b2.id];
    const losers = over.winningTeam === 0 ? [b1.id, b2.id] : [a1.id, a2.id];
    for (const id of winners) expect(coinBalance(id)).toBe(WIN_COIN_REWARD);
    for (const id of losers) expect(coinBalance(id)).toBe(0);

    // Match row records the mode
    const row = getMatchStmt.get(session.id) as { mode: string; status: string };
    expect(row.mode).toBe('team_rated');
    expect(row.status).toBe('complete');

    // game_over reports the TEAM elo transition
    const mine = over.results.find((r) => r.seat === 0)!;
    expect(mine.eloBefore).toBe(1200);
    expect(mine.eloAfter).toBe(over.winningTeam === 0 ? winnerTeamRow.elo : loserTeamRow.elo);
  }, 90_000);
});

describe('team_vs_ai matches', () => {
  it('two humans + two bots complete a match with NO rating or coin changes', async () => {
    const a = makeUser();
    const b = makeUser();
    const team = getOrCreateTeam(a.id, b.id);
    const teamEloBefore = team.elo;

    const inbox = new Map<number, SeatMessage[]>([[0, []], [2, []]]);
    const session = new MatchSession(
      [
        { userId: a.id, username: a.username, elo: 1200, seat: 0 },
        { userId: -1, username: 'Bot Lefty', elo: 1200, seat: 1, isBot: true },
        { userId: b.id, username: b.username, elo: 1200, seat: 2 },
        { userId: -2, username: 'Bot Righty', elo: 1200, seat: 3, isBot: true },
      ],
      (seat, msg) => inbox.get(seat)?.push(msg),
      FAST,
      { mode: 'team_vs_ai', aiDifficulty: 2 },
    );
    session.start();

    await waitFor(() => inbox.get(0)!.some((m) => m.type === 'game_over'));
    const over = inbox.get(0)!.find((m) => m.type === 'game_over')!;
    if (over.type !== 'game_over') throw new Error('unreachable');

    // Practice match: no elo movement, no coins
    for (const r of over.results) {
      expect(r.eloDelta).toBe(0);
      expect(r.coinsAwarded).toBe(0);
    }
    expect(getTeamById(team.id).elo).toBe(teamEloBefore);
    expect(getTeamById(team.id).games_played).toBe(0);
    expect((getRating.get(a.id) as RatingRow).elo).toBe(1200);
    expect(coinBalance(a.id)).toBe(0);
    expect(coinBalance(b.id)).toBe(0);

    // Both humans saw the result; bots have no inbox
    expect(inbox.get(2)!.some((m) => m.type === 'game_over')).toBe(true);

    const row = getMatchStmt.get(session.id) as { mode: string; status: string };
    expect(row.mode).toBe('team_vs_ai');
    expect(row.status).toBe('complete');
  }, 90_000);

  it('the state players list shows the bots so the UI can render them', async () => {
    const a = makeUser();
    const b = makeUser();
    const inbox = new Map<number, SeatMessage[]>([[0, []], [2, []]]);
    const session = new MatchSession(
      [
        { userId: a.id, username: a.username, elo: 1200, seat: 0 },
        { userId: -1, username: 'Bot Lefty', elo: 1200, seat: 1, isBot: true },
        { userId: b.id, username: b.username, elo: 1200, seat: 2 },
        { userId: -2, username: 'Bot Righty', elo: 1200, seat: 3, isBot: true },
      ],
      (seat, msg) => inbox.get(seat)?.push(msg),
      { ...FAST, turnTimeoutMs: 60_000, disconnectedTurnMs: 60_000, botTurnMs: 60_000 },
      { mode: 'team_vs_ai' },
    );
    session.start();
    const state = inbox.get(0)!.find((m) => m.type === 'state');
    if (state?.type !== 'state') throw new Error('missing state');
    expect(state.players.map((p) => p.username)).toContain('Bot Lefty');
    session.abandon();
  });
});
