import { afterEach, describe, expect, it } from 'vitest';
import { insertUser, insertRating, sqlite, getOrCreateTeam, type UserRow } from '../db.js';
import { Matchmaker } from '../matchmaking.js';
import type { SeatMessage } from '../match.js';

const FAST = {
  turnTimeoutMs: 60_000,
  disconnectedTurnMs: 60_000,
  botTurnMs: 60_000,
  trickPauseMs: 1,
  interHandPauseMs: 1,
};

let counter = 0;
function makeUser(elo = 1200): UserRow {
  counter += 1;
  const user = insertUser.get(`mm_user_${counter}`, null, 1) as UserRow;
  insertRating.run(user.id);
  if (elo !== 1200) {
    sqlite.prepare(`UPDATE ratings SET elo = ? WHERE user_id = ?`).run(elo, user.id);
  }
  return user;
}

function makeDuo(elo = 1200): { partyId: string; users: { userId: number; username: string }[] } {
  const a = makeUser(elo);
  const b = makeUser(elo);
  return {
    partyId: `party-${a.id}-${b.id}`,
    users: [
      { userId: a.id, username: a.username },
      { userId: b.id, username: b.username },
    ],
  };
}

function makeMatchmaker() {
  const matched: { userId: number; matchId: number; seat: number }[] = [];
  const messages: { userId: number; msg: SeatMessage }[] = [];
  const mm = new Matchmaker(
    (userId, _seat, msg) => messages.push({ userId, msg }),
    () => {},
    (userId, matchId, seat) => matched.push({ userId, matchId, seat }),
    FAST,
    3_600_000, // no automatic ticking — tests drive tick() manually
  );
  return { mm, matched, messages };
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('team matchmaking', () => {
  it('matches two similarly rated duos into one team_rated match', () => {
    const { mm, matched } = makeMatchmaker();
    cleanup.push(() => {
      for (const m of mm.matches.values()) m.abandon();
      mm.stop();
    });

    const duoA = makeDuo(1200);
    const duoB = makeDuo(1250);
    expect(mm.joinTeamQueue(duoA.partyId, duoA.users).error).toBeUndefined();
    expect(mm.joinTeamQueue(duoB.partyId, duoB.users).error).toBeUndefined();

    expect(matched).toHaveLength(4);
    const matchIds = new Set(matched.map((m) => m.matchId));
    expect(matchIds.size).toBe(1);

    // Duo A holds seats {0,2} (team 0), duo B holds {1,3}
    const seatOf = (userId: number) => matched.find((m) => m.userId === userId)!.seat;
    expect([seatOf(duoA.users[0].userId), seatOf(duoA.users[1].userId)].sort()).toEqual([0, 2]);
    expect([seatOf(duoB.users[0].userId), seatOf(duoB.users[1].userId)].sort()).toEqual([1, 3]);

    const session = mm.matches.get([...matchIds][0])!;
    expect(session.mode).toBe('team_rated');
  });

  it('does not match duos that are too far apart until the band widens', () => {
    const { mm, matched } = makeMatchmaker();
    cleanup.push(() => {
      for (const m of mm.matches.values()) m.abandon();
      mm.stop();
    });

    const duoA = makeDuo(1200);
    const duoB = makeDuo(1600); // 400 apart — outside the initial 100 band
    mm.joinTeamQueue(duoA.partyId, duoA.users);
    mm.joinTeamQueue(duoB.partyId, duoB.users);
    expect(matched).toHaveLength(0);
    expect(mm.inTeamQueue(duoA.partyId)).toBe(true);
  });

  it('solo and team queues are independent: 2 solos + 1 duo never mix', () => {
    const { mm, matched } = makeMatchmaker();
    cleanup.push(() => {
      for (const m of mm.matches.values()) m.abandon();
      mm.stop();
    });

    const s1 = makeUser();
    const s2 = makeUser();
    mm.join(s1.id, s1.username);
    mm.join(s2.id, s2.username);
    const duo = makeDuo();
    mm.joinTeamQueue(duo.partyId, duo.users);
    mm.tick();
    expect(matched).toHaveLength(0); // 2 solos can't form a 4; 1 duo can't either
  });

  it('joining the team queue removes members from the solo queue', () => {
    const { mm } = makeMatchmaker();
    cleanup.push(() => mm.stop());

    const duo = makeDuo();
    mm.join(duo.users[0].userId, duo.users[0].username);
    expect(mm.inQueue(duo.users[0].userId)).toBe(true);
    mm.joinTeamQueue(duo.partyId, duo.users);
    expect(mm.inQueue(duo.users[0].userId)).toBe(false);
    expect(mm.inTeamQueue(duo.partyId)).toBe(true);
  });

  it('startTeamVsAi launches an unrated match with 2 bots immediately', () => {
    const { mm, matched } = makeMatchmaker();
    cleanup.push(() => {
      for (const m of mm.matches.values()) m.abandon();
      mm.stop();
    });

    const duo = makeDuo();
    getOrCreateTeam(duo.users[0].userId, duo.users[1].userId);
    const { error } = mm.startTeamVsAi(duo.users, 2);
    expect(error).toBeUndefined();
    expect(matched).toHaveLength(2); // only the humans are notified
    const session = mm.matches.get(matched[0].matchId)!;
    expect(session.mode).toBe('team_vs_ai');
    expect(session.players.filter((p) => p.isBot)).toHaveLength(2);
    // Humans on the same team (seats 0 and 2)
    expect(matched.map((m) => m.seat).sort()).toEqual([0, 2]);
  });

  it('cannot queue as a team while a member is in a match', () => {
    const { mm } = makeMatchmaker();
    cleanup.push(() => {
      for (const m of mm.matches.values()) m.abandon();
      mm.stop();
    });

    const duo = makeDuo();
    mm.startTeamVsAi(duo.users, 3);
    const result = mm.joinTeamQueue(duo.partyId, duo.users);
    expect(result.error).toMatch(/already in a match/);
  });
});
