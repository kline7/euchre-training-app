import { describe, expect, it } from 'vitest';
import { bandFor, compatible, balanceTeams, findGroup, type QueueEntry } from '../matchmaking.js';

function entry(userId: number, elo: number, joinedAt = 0): QueueEntry {
  return { userId, username: `u${userId}`, elo, joinedAt };
}

describe('bandFor', () => {
  it('starts at the base band and widens with wait time', () => {
    const e = entry(1, 1200, 0);
    expect(bandFor(e, 0)).toBe(100);
    expect(bandFor(e, 5_000)).toBe(150);
    expect(bandFor(e, 20_000)).toBe(300);
  });

  it('caps at the maximum band', () => {
    const e = entry(1, 1200, 0);
    expect(bandFor(e, 10_000_000)).toBe(1000);
  });
});

describe('compatible', () => {
  it('requires both players to accept the gap', () => {
    const fresh = entry(1, 1200, 10_000); // just joined → band 100
    const waiting = entry(2, 1380, 0); // waited 10s → band 200
    // gap 180: waiting accepts (200) but fresh does not (100)
    expect(compatible(fresh, waiting, 10_000)).toBe(false);
    // after fresh waits 5s, its band is 150 — still not enough
    expect(compatible(fresh, waiting, 15_000)).toBe(false);
    // after 10s its band is 200 — both accept
    expect(compatible(fresh, waiting, 20_000)).toBe(true);
  });
});

describe('findGroup', () => {
  it('returns null with fewer than 4 players', () => {
    expect(findGroup([entry(1, 1200), entry(2, 1200), entry(3, 1200)], 0)).toBeNull();
  });

  it('matches 4 similarly rated players', () => {
    const queue = [entry(1, 1200), entry(2, 1250), entry(3, 1180), entry(4, 1220)];
    const group = findGroup(queue, 0);
    expect(group).toHaveLength(4);
  });

  it('does not match players too far apart', () => {
    const queue = [entry(1, 1200), entry(2, 1250), entry(3, 1180), entry(4, 2000)];
    expect(findGroup(queue, 0)).toBeNull();
  });

  it('matches distant players after the band widens', () => {
    const queue = [
      entry(1, 1200, 0),
      entry(2, 1250, 0),
      entry(3, 1180, 0),
      entry(4, 1500, 0),
    ];
    expect(findGroup(queue, 0)).toBeNull();
    // After 30s everyone's band is 400 — the 1500 player fits
    expect(findGroup(queue, 30_000)).toHaveLength(4);
  });

  it('prefers the four closest when more than 4 wait', () => {
    const queue = [
      entry(1, 1200),
      entry(2, 1210),
      entry(3, 1190),
      entry(4, 1205),
      entry(5, 1290),
    ];
    const group = findGroup(queue, 0)!;
    const ids = group.map((e) => e.userId).sort();
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

describe('balanceTeams', () => {
  it('pairs strongest with weakest', () => {
    const group = [entry(1, 1400), entry(2, 1300), entry(3, 1200), entry(4, 1100)];
    const seated = balanceTeams(group);
    const seatOf = (id: number) => seated.find((s) => s.entry.userId === id)!.seat;
    // Team 0 = seats 0,2; team 1 = seats 1,3
    const team0 = [seatOf(1), seatOf(4)].sort();
    const team1 = [seatOf(2), seatOf(3)].sort();
    expect(team0).toEqual([0, 2]);
    expect(team1).toEqual([1, 3]);
  });

  it('assigns all four distinct seats', () => {
    const seated = balanceTeams([entry(1, 1200), entry(2, 1200), entry(3, 1200), entry(4, 1200)]);
    expect(seated.map((s) => s.seat).sort()).toEqual([0, 1, 2, 3]);
  });
});
