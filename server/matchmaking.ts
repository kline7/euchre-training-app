import { getOrCreateTeam, getRating, type RatingRow } from './db.js';
import {
  MatchSession,
  type SendFn,
  type MatchTimings,
  type MatchOptions,
  DEFAULT_TIMINGS,
} from './match.js';

const AI_BOT_NAMES = ['Bot Lefty', 'Bot Righty'];

export interface QueueEntry {
  userId: number;
  username: string;
  elo: number;
  joinedAt: number;
}

/** Initial half-width of the acceptable Elo band. */
const BASE_BAND = 100;
/** The band widens by this much for every WIDEN_INTERVAL_MS waited. */
const BAND_STEP = 50;
const WIDEN_INTERVAL_MS = 5_000;
/** Hard cap so the band cannot grow unbounded. */
const MAX_BAND = 1_000;

export function bandFor(entry: QueueEntry, now: number): number {
  const waited = Math.max(0, now - entry.joinedAt);
  return Math.min(MAX_BAND, BASE_BAND + BAND_STEP * Math.floor(waited / WIDEN_INTERVAL_MS));
}

/** Two players are compatible when each falls inside the other's band. */
export function compatible(a: QueueEntry, b: QueueEntry, now: number): boolean {
  const gap = Math.abs(a.elo - b.elo);
  return gap <= bandFor(a, now) && gap <= bandFor(b, now);
}

/**
 * Seat a group of 4 by rating so teams are balanced: the strongest and
 * weakest players (1st + 4th) form team 0, the middle two form team 1.
 * Seats: team 0 = {0, 2}, team 1 = {1, 3}.
 */
export function balanceTeams(group: QueueEntry[]): { entry: QueueEntry; seat: number }[] {
  const sorted = [...group].sort((a, b) => b.elo - a.elo);
  return [
    { entry: sorted[0], seat: 0 },
    { entry: sorted[1], seat: 1 },
    { entry: sorted[2], seat: 3 },
    { entry: sorted[3], seat: 2 },
  ];
}

/**
 * Find one group of 4 mutually-compatible players, preferring those who have
 * waited longest. Returns the group or null.
 */
export function findGroup(queue: QueueEntry[], now: number): QueueEntry[] | null {
  if (queue.length < 4) return null;
  const byWait = [...queue].sort((a, b) => a.joinedAt - b.joinedAt);
  for (const anchor of byWait) {
    const candidates = byWait.filter((e) => e === anchor || compatible(anchor, e, now));
    if (candidates.length < 4) continue;
    // Greedy: take the anchor plus the closest-rated compatible players,
    // then verify mutual compatibility.
    const closest = candidates
      .filter((e) => e !== anchor)
      .sort((a, b) => Math.abs(a.elo - anchor.elo) - Math.abs(b.elo - anchor.elo));
    for (let skip = 0; skip + 3 <= closest.length; skip++) {
      const group = [anchor, ...closest.slice(skip, skip + 3)];
      const mutual = group.every((a) => group.every((b) => a === b || compatible(a, b, now)));
      if (mutual) return group;
    }
  }
  return null;
}

/**
 * The matchmaking queue. In-memory: queue state is transient by design —
 * clients re-join on reconnect.
 */
export interface TeamQueueEntry {
  partyId: string;
  teamId: number;
  /** The persistent team rating used for matchmaking. */
  elo: number;
  users: { userId: number; username: string }[];
  joinedAt: number;
}

export class Matchmaker {
  private queue = new Map<number, QueueEntry>();
  /** Pre-made duo queue, keyed by party id; matched by TEAM elo. */
  private teamQueue = new Map<string, TeamQueueEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Live matches by match id. */
  readonly matches = new Map<number, MatchSession>();
  /** Match id by user id, for routing and reconnection. */
  readonly matchByUser = new Map<number, number>();

  constructor(
    private send: (userId: number, seat: number, msg: Parameters<SendFn>[1]) => void,
    private notifyQueued: (userId: number, position: number, waitedMs: number) => void,
    private notifyMatched: (userId: number, matchId: number, seat: number) => void,
    private timings: MatchTimings = DEFAULT_TIMINGS,
    tickMs = 2_000,
  ) {
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  join(userId: number, username: string): { error?: string } {
    if (this.matchByUser.has(userId)) {
      return { error: 'already in a match' };
    }
    if (this.queue.has(userId)) {
      return {}; // idempotent
    }
    const rating = getRating.get(userId) as RatingRow | undefined;
    this.queue.set(userId, {
      userId,
      username,
      elo: rating?.elo ?? 1200,
      joinedAt: Date.now(),
    });
    this.tick();
    return {};
  }

  leave(userId: number) {
    this.queue.delete(userId);
  }

  inQueue(userId: number): boolean {
    return this.queue.has(userId);
  }

  // --- Pre-made team (duo) queue ---

  /** Queue a full party as a team. Rated: matched against another duo by
   * the persistent TEAM elo. */
  joinTeamQueue(
    partyId: string,
    users: { userId: number; username: string }[],
  ): { error?: string } {
    if (users.length !== 2) return { error: 'a team needs exactly 2 players' };
    for (const u of users) {
      if (this.matchByUser.has(u.userId)) return { error: 'a team member is already in a match' };
      if (this.queue.has(u.userId)) this.queue.delete(u.userId); // leave solo queue
    }
    if (this.teamQueue.has(partyId)) return {}; // idempotent
    const team = getOrCreateTeam(users[0].userId, users[1].userId);
    this.teamQueue.set(partyId, {
      partyId,
      teamId: team.id,
      elo: team.elo,
      users,
      joinedAt: Date.now(),
    });
    this.tick();
    return {};
  }

  leaveTeamQueue(partyId: string) {
    this.teamQueue.delete(partyId);
  }

  inTeamQueue(partyId: string): boolean {
    return this.teamQueue.has(partyId);
  }

  /** Number of users currently waiting in either queue (solo + duo members). */
  queuedUserCount(): number {
    let n = this.queue.size;
    for (const t of this.teamQueue.values()) n += t.users.length;
    return n;
  }

  /** Start an unrated practice match: the duo vs two AI opponents. */
  startTeamVsAi(
    users: { userId: number; username: string }[],
    difficulty: number,
  ): { error?: string } {
    if (users.length !== 2) return { error: 'a team needs exactly 2 players' };
    for (const u of users) {
      if (this.matchByUser.has(u.userId)) return { error: 'a team member is already in a match' };
    }
    const team = getOrCreateTeam(users[0].userId, users[1].userId);
    const humanElos = users.map(
      (u) => (getRating.get(u.userId) as RatingRow | undefined)?.elo ?? 1200,
    );
    const players = [
      { userId: users[0].userId, username: users[0].username, elo: humanElos[0], seat: 0 },
      { userId: -1, username: AI_BOT_NAMES[0], elo: team.elo, seat: 1, isBot: true },
      { userId: users[1].userId, username: users[1].username, elo: humanElos[1], seat: 2 },
      { userId: -2, username: AI_BOT_NAMES[1], elo: team.elo, seat: 3, isBot: true },
    ];
    this.launchMatch(players, { mode: 'team_vs_ai' as const, aiDifficulty: difficulty });
    return {};
  }

  matchFor(userId: number): MatchSession | undefined {
    const id = this.matchByUser.get(userId);
    return id === undefined ? undefined : this.matches.get(id);
  }

  tick() {
    const now = Date.now();
    // Solo queue: form as many matches as possible
    for (;;) {
      const group = findGroup([...this.queue.values()], now);
      if (!group) break;
      for (const e of group) this.queue.delete(e.userId);
      this.createSoloMatch(group);
    }
    // Team queue: pair mutually-compatible duos by TEAM elo (same widening bands)
    for (;;) {
      const pair = this.findTeamPair(now);
      if (!pair) break;
      this.teamQueue.delete(pair[0].partyId);
      this.teamQueue.delete(pair[1].partyId);
      this.createTeamMatch(pair[0], pair[1]);
    }
    // Status updates for those still waiting
    const waiting = [...this.queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    waiting.forEach((e, i) => this.notifyQueued(e.userId, i + 1, now - e.joinedAt));
    const teamsWaiting = [...this.teamQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    teamsWaiting.forEach((t, i) => {
      for (const u of t.users) this.notifyQueued(u.userId, i + 1, now - t.joinedAt);
    });
  }

  private findTeamPair(now: number): [TeamQueueEntry, TeamQueueEntry] | null {
    const entries = [...this.teamQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const gap = Math.abs(a.elo - b.elo);
        const bandA = bandFor({ ...a, userId: 0, username: '' }, now);
        const bandB = bandFor({ ...b, userId: 0, username: '' }, now);
        if (gap <= bandA && gap <= bandB) return [a, b];
      }
    }
    return null;
  }

  private createSoloMatch(group: QueueEntry[]) {
    const seated = balanceTeams(group);
    this.launchMatch(
      seated.map(({ entry, seat }) => ({
        userId: entry.userId,
        username: entry.username,
        elo: entry.elo,
        seat,
      })),
      { mode: 'solo_rated' as const },
    );
  }

  /** Team A takes seats {0,2}, team B {1,3}; rated on the duo's team elo. */
  private createTeamMatch(a: TeamQueueEntry, b: TeamQueueEntry) {
    const eloOf = (userId: number) =>
      (getRating.get(userId) as RatingRow | undefined)?.elo ?? 1200;
    this.launchMatch(
      [
        { userId: a.users[0].userId, username: a.users[0].username, elo: eloOf(a.users[0].userId), seat: 0 },
        { userId: b.users[0].userId, username: b.users[0].username, elo: eloOf(b.users[0].userId), seat: 1 },
        { userId: a.users[1].userId, username: a.users[1].username, elo: eloOf(a.users[1].userId), seat: 2 },
        { userId: b.users[1].userId, username: b.users[1].username, elo: eloOf(b.users[1].userId), seat: 3 },
      ],
      { mode: 'team_rated' as const, teamIds: { team0: a.teamId, team1: b.teamId } },
    );
  }

  private launchMatch(
    players: { userId: number; username: string; elo: number; seat: number; isBot?: boolean }[],
    options: MatchOptions,
  ) {
    const session = new MatchSession(
      players,
      (seat, msg) => {
        const player = session.players.find((p) => p.seat === seat);
        if (player && !player.isBot) this.send(player.userId, seat, msg);
      },
      this.timings,
      options,
    );
    this.matches.set(session.id, session);
    const humans = session.players.filter((p) => !p.isBot);
    for (const p of humans) {
      this.matchByUser.set(p.userId, session.id);
    }
    session.onFinished = () => {
      this.matches.delete(session.id);
      for (const p of humans) {
        if (this.matchByUser.get(p.userId) === session.id) {
          this.matchByUser.delete(p.userId);
        }
      }
    };
    for (const p of humans) {
      this.notifyMatched(p.userId, session.id, p.seat);
    }
    session.start();
  }
}
