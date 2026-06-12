import { randomInt } from 'node:crypto';
import { HandEngine, Phase, type CardData } from './engine.js';
import {
  sqlite,
  insertMatch,
  insertMatchPlayer,
  insertMatchAction,
  completeMatchStmt,
  abandonMatchStmt,
  setPlayerRatingAfter,
  getRating,
  updateRatingStmt,
  insertLedgerEntry,
  type RatingRow,
} from './db.js';
import { getTeamById, updateTeamRating } from './db.js';
import { computeEloDeltas, applyDelta, expectedScore, K_FACTOR, ELO_FLOOR, WIN_COIN_REWARD } from './elo.js';

export type MatchMode = 'solo_rated' | 'team_rated' | 'team_vs_ai';

export interface MatchPlayerInfo {
  /** Negative for AI-controlled seats. */
  userId: number;
  username: string;
  elo: number;
  seat: number;
  connected: boolean;
  isBot?: boolean;
}

export interface MatchOptions {
  mode: MatchMode;
  /** For team_rated: persistent team ids — team 0 = seats {0,2}, team 1 = seats {1,3}. */
  teamIds?: { team0: number; team1: number };
  /** AI difficulty (0-3) for bot seats and auto-play. Defaults to expert. */
  aiDifficulty?: number;
  /** House rule: trump may not be led until broken (default true). */
  trumpMustBeBroken?: boolean;
}

export interface BidLogEntry {
  seat: number;
  bid: number;
}

/** Message sent to a specific seat. */
export type SeatMessage =
  | {
      type: 'state';
      matchId: number;
      yourSeat: number;
      handNumber: number;
      phase: number;
      players: { seat: number; username: string; elo: number; connected: boolean }[];
      hand: CardData[];
      handCounts: number[];
      legalPlays: CardData[];
      nextToPlay: number;
      trump: number;
      upcard: CardData;
      dealer: number;
      maker: number;
      trickNumber: number;
      currentTrick: { seat: number; card: CardData }[];
      tricksWon: [number, number];
      scores: [number, number];
      alone: boolean;
      sittingOut: number;
      turnedDownSuit: number;
      bidLog: BidLogEntry[];
      turnDeadline: number | null;
      paused: boolean;
      trumpMustBeBroken: boolean;
    }
  | {
      type: 'hand_result';
      points: number;
      isEuchre: boolean;
      isSweep: boolean;
      makerTeam: number;
      scores: [number, number];
    }
  | {
      type: 'game_over';
      winningTeam: number;
      scores: [number, number];
      results: {
        seat: number;
        username: string;
        eloBefore: number;
        eloAfter: number;
        eloDelta: number;
        coinsAwarded: number;
      }[];
    }
  | { type: 'error'; message: string }
  | { type: 'opponent_connection'; seat: number; connected: boolean };

export type SendFn = (seat: number, msg: SeatMessage) => void;

export interface MatchTimings {
  /** ms a connected player may take per turn before the server plays for them */
  turnTimeoutMs: number;
  /** ms a disconnected player's turn waits before auto-play */
  disconnectedTurnMs: number;
  /** ms an AI-controlled seat waits before acting (natural pacing) */
  botTurnMs?: number;
  /** ms the completed trick stays on screen */
  trickPauseMs: number;
  /** ms between hand scoring and the next deal */
  interHandPauseMs: number;
}

export const DEFAULT_TIMINGS: MatchTimings = {
  turnTimeoutMs: 45_000,
  disconnectedTurnMs: 2_000,
  botTurnMs: 900,
  trickPauseMs: 1_500,
  interHandPauseMs: 5_000,
};

export type ClientAction =
  | { type: 'bid'; bid: number }
  | { type: 'play'; card: CardData }
  | { type: 'discard'; card: CardData };

/** AI difficulty used when the server must act for an absent/slow player. */
const AUTOPLAY_DIFFICULTY = 3; // Expert

/**
 * A live, server-authoritative match. The server owns the deck (seeds are
 * generated here, never by clients), validates every action through the same
 * Rust rules engine the client uses, persists an append-only action log for
 * replay/audit, and settles Elo + milk coins in one transaction at the end.
 */
export class MatchSession {
  readonly id: number;
  readonly players: MatchPlayerInfo[];
  private engine: HandEngine | null = null;
  private dealer: number;
  private scores: [number, number] = [0, 0];
  private handNumber = 0;
  private seq = 0;
  private bidLog: BidLogEntry[] = [];
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private turnDeadline: number | null = null;
  status: 'active' | 'complete' | 'abandoned' = 'active';
  readonly mode: MatchMode;
  readonly trumpMustBeBroken: boolean;
  private teamIds: { team0: number; team1: number } | null;
  private aiDifficulty: number;
  /** Called when the match reaches a terminal state (for registry cleanup). */
  onFinished: (() => void) | null = null;

  constructor(
    players: Omit<MatchPlayerInfo, 'connected'>[],
    private send: SendFn,
    private timings: MatchTimings = DEFAULT_TIMINGS,
    options: MatchOptions = { mode: 'solo_rated' },
  ) {
    if (players.length !== 4) throw new Error('a match requires exactly 4 players');
    this.mode = options.mode;
    this.trumpMustBeBroken = options.trumpMustBeBroken ?? true;
    this.teamIds = options.teamIds ?? null;
    this.aiDifficulty = options.aiDifficulty ?? AUTOPLAY_DIFFICULTY;
    if (this.mode === 'team_rated' && !this.teamIds) {
      throw new Error('team_rated matches require team ids');
    }
    this.players = players
      .map((p) => ({ ...p, connected: !p.isBot }))
      .sort((a, b) => a.seat - b.seat);

    const createMatch = sqlite.transaction(() => {
      const { id } = insertMatch.get(this.mode) as { id: number };
      for (const p of this.players) {
        if (!p.isBot) insertMatchPlayer.run(id, p.userId, p.seat, p.elo);
      }
      return id;
    });
    this.id = createMatch();
    this.dealer = randomInt(4);
  }

  private humans(): MatchPlayerInfo[] {
    return this.players.filter((p) => !p.isBot);
  }

  start() {
    this.startHand();
  }

  private startHand() {
    if (this.status !== 'active') return;
    this.engine?.free();
    this.handNumber += 1;
    this.bidLog = [];
    const seed = randomInt(0, 2 ** 48 - 1); // server-owned randomness
    this.engine = new HandEngine({
      seed,
      difficulty: this.aiDifficulty,
      dealer: this.dealer,
      scores: this.scores,
      trump_must_be_broken: this.trumpMustBeBroken,
    });
    this.recordAction(null, { type: 'deal', seed, dealer: this.dealer, hand: this.handNumber });
    this.broadcastState();
    this.armTurnTimer();
  }

  seatOf(userId: number): number | undefined {
    return this.players.find((p) => p.userId === userId)?.seat;
  }

  setConnected(userId: number, connected: boolean) {
    const player = this.players.find((p) => p.userId === userId && !p.isBot);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    for (const p of this.humans()) {
      if (p.userId !== userId) {
        this.send(p.seat, { type: 'opponent_connection', seat: player.seat, connected });
      }
    }
    if (connected) {
      // Re-sync the rejoining player
      this.sendStateTo(player.seat);
    } else {
      if (this.humans().every((p) => !p.connected)) {
        this.abandon();
        return;
      }
      // If it's their turn, shorten the clock so the table isn't held hostage
      if (this.currentActorSeat() === player.seat) {
        this.armTurnTimer();
      }
    }
  }

  /** Handle an action submitted by a client. Illegal actions are rejected
   * with an error message to that seat only; state never changes. */
  handleAction(userId: number, action: ClientAction) {
    if (this.status !== 'active' || !this.engine) {
      return this.sendError(userId, 'match is not active');
    }
    const seat = this.seatOf(userId);
    if (seat === undefined) return;
    if (this.pauseTimer) {
      return this.sendErrorSeat(seat, 'please wait');
    }
    const actor = this.currentActorSeat();
    if (actor !== seat) {
      return this.sendErrorSeat(seat, 'not your turn');
    }

    try {
      switch (action.type) {
        case 'bid': {
          const bid = action.bid;
          if (!Number.isInteger(bid) || bid < 0 || bid > 10) {
            return this.sendErrorSeat(seat, 'invalid bid');
          }
          this.engine.applyBid(bid);
          this.bidLog.push({ seat, bid });
          this.recordAction(seat, { type: 'bid', bid });
          break;
        }
        case 'discard': {
          this.engine.dealerDiscard(action.card);
          this.recordAction(seat, { type: 'discard', card: action.card });
          break;
        }
        case 'play': {
          this.engine.playCard(action.card);
          this.recordAction(seat, { type: 'play', card: action.card });
          break;
        }
        default:
          return this.sendErrorSeat(seat, 'unknown action');
      }
    } catch (err) {
      // Rules engine rejected the action — tell the offender, change nothing
      return this.sendErrorSeat(seat, err instanceof Error ? err.message : 'illegal action');
    }

    this.afterAction();
  }

  /** The seat that must act now, or -1 when no action is awaited. */
  private currentActorSeat(): number {
    if (!this.engine) return -1;
    const phase = this.engine.phase;
    if (
      phase === Phase.BiddingRound1 ||
      phase === Phase.BiddingRound2 ||
      phase === Phase.DealerDiscard ||
      phase === Phase.Playing
    ) {
      return this.engine.nextToPlay();
    }
    return -1;
  }

  private afterAction() {
    if (!this.engine) return;
    this.clearTurnTimer();

    if (this.engine.hasCompletedTrick()) {
      // Show the completed trick to everyone, then collect it and move on.
      // The pause timer is set BEFORE broadcasting so no state message can
      // advertise an actionable turn during the pause.
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        this.engine?.collectTrick();
        this.proceed();
      }, this.timings.trickPauseMs);
      this.broadcastState();
      return;
    }
    this.proceed();
  }

  private proceed() {
    if (!this.engine || this.status !== 'active') return;

    if (this.engine.phase === Phase.HandScoring || this.engine.phase === Phase.GameOver) {
      this.scoreCurrentHand();
      return;
    }

    this.broadcastState();
    this.armTurnTimer();
  }

  private scoreCurrentHand() {
    if (!this.engine) return;
    const makerTeam = this.engine.snapshot().maker % 2;
    const result = this.engine.scoreHand();
    const snap = this.engine.snapshot();
    this.scores = snap.scores;
    this.recordAction(null, {
      type: 'hand_scored',
      points: result.points,
      isEuchre: result.isEuchre,
      isSweep: result.isSweep,
      scores: this.scores,
    });

    for (const p of this.humans()) {
      this.send(p.seat, {
        type: 'hand_result',
        points: result.points,
        isEuchre: result.isEuchre,
        isSweep: result.isSweep,
        makerTeam,
        scores: this.scores,
      });
    }
    this.broadcastState();

    if (snap.winner >= 0) {
      this.settle(snap.winner as 0 | 1);
      return;
    }

    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.dealer = (this.dealer + 1) % 4;
      this.startHand();
    }, this.timings.interHandPauseMs);
  }

  /** Final settlement: persist result, update ratings, award milk coins —
   * all inside a single transaction so a crash can never half-settle.
   * What gets rated depends on the match mode:
   * - solo_rated: each player's individual elo moves; winners earn coins
   * - team_rated: the two persistent TEAM ratings move; winners earn coins
   * - team_vs_ai: practice — nothing is rated, no coins */
  private settle(winningTeam: 0 | 1) {
    this.status = 'complete';
    this.clearTurnTimer();

    switch (this.mode) {
      case 'solo_rated':
        this.settleSolo(winningTeam);
        break;
      case 'team_rated':
        this.settleTeam(winningTeam);
        break;
      case 'team_vs_ai':
        this.settleUnrated(winningTeam);
        break;
    }
    this.cleanup();
  }

  private settleSolo(winningTeam: 0 | 1) {
    const ratings = this.players.map(
      (p) => (getRating.get(p.userId) as RatingRow).elo,
    );
    const { team0Delta } = computeEloDeltas(
      [ratings[0], ratings[2]],
      [ratings[1], ratings[3]],
      winningTeam,
    );

    const results = this.players.map((p) => {
      const before = ratings[p.seat];
      const delta = p.seat % 2 === 0 ? team0Delta : -team0Delta;
      const after = applyDelta(before, delta);
      const won = p.seat % 2 === winningTeam;
      return {
        seat: p.seat,
        username: p.username,
        userId: p.userId,
        eloBefore: before,
        eloAfter: after,
        eloDelta: after - before,
        won,
        coinsAwarded: won ? WIN_COIN_REWARD : 0,
      };
    });

    const settleTx = sqlite.transaction(() => {
      completeMatchStmt.run(JSON.stringify(this.scores), winningTeam, this.id);
      for (const r of results) {
        updateRatingStmt.run(r.eloAfter, r.won ? 1 : 0, r.userId);
        setPlayerRatingAfter.run(r.eloAfter, this.id, r.seat);
        if (r.won) {
          insertLedgerEntry.run(
            r.userId,
            WIN_COIN_REWARD,
            'match_win',
            this.id,
            `match:${this.id}:seat:${r.seat}:win`,
          );
        }
      }
    });
    settleTx();

    this.broadcastGameOver(
      winningTeam,
      results.map(({ userId: _u, won: _w, ...rest }) => rest),
    );
  }

  private settleTeam(winningTeam: 0 | 1) {
    const ids = this.teamIds!;
    const team0 = getTeamById(ids.team0);
    const team1 = getTeamById(ids.team1);

    // Head-to-head team elo: one rating per duo
    const expected0 = expectedScore(team0.elo, team1.elo);
    const delta0 = Math.round(K_FACTOR * ((winningTeam === 0 ? 1 : 0) - expected0));
    const after0 = Math.max(ELO_FLOOR, team0.elo + delta0);
    const after1 = Math.max(ELO_FLOOR, team1.elo - delta0);

    const results = this.players.map((p) => {
      const isTeam0 = p.seat % 2 === 0;
      const won = p.seat % 2 === winningTeam;
      return {
        seat: p.seat,
        username: p.username,
        userId: p.userId,
        eloBefore: isTeam0 ? team0.elo : team1.elo,
        eloAfter: isTeam0 ? after0 : after1,
        eloDelta: isTeam0 ? after0 - team0.elo : after1 - team1.elo,
        won,
        coinsAwarded: won ? WIN_COIN_REWARD : 0,
      };
    });

    const settleTx = sqlite.transaction(() => {
      completeMatchStmt.run(JSON.stringify(this.scores), winningTeam, this.id);
      updateTeamRating.run(after0, winningTeam === 0 ? 1 : 0, ids.team0);
      updateTeamRating.run(after1, winningTeam === 1 ? 1 : 0, ids.team1);
      for (const r of results) {
        setPlayerRatingAfter.run(r.eloAfter, this.id, r.seat);
        if (r.won) {
          insertLedgerEntry.run(
            r.userId,
            WIN_COIN_REWARD,
            'match_win',
            this.id,
            `match:${this.id}:seat:${r.seat}:win`,
          );
        }
      }
    });
    settleTx();

    this.broadcastGameOver(
      winningTeam,
      results.map(({ userId: _u, won: _w, ...rest }) => rest),
    );
  }

  /** Practice vs AI: record completion only — no elo, no coins. */
  private settleUnrated(winningTeam: 0 | 1) {
    completeMatchStmt.run(JSON.stringify(this.scores), winningTeam, this.id);
    const results = this.humans().map((p) => ({
      seat: p.seat,
      username: p.username,
      eloBefore: p.elo,
      eloAfter: p.elo,
      eloDelta: 0,
      coinsAwarded: 0,
    }));
    this.broadcastGameOver(winningTeam, results);
  }

  private broadcastGameOver(
    winningTeam: number,
    results: {
      seat: number;
      username: string;
      eloBefore: number;
      eloAfter: number;
      eloDelta: number;
      coinsAwarded: number;
    }[],
  ) {
    for (const p of this.humans()) {
      this.send(p.seat, {
        type: 'game_over',
        winningTeam,
        scores: this.scores,
        results,
      });
    }
  }

  abandon() {
    if (this.status !== 'active') return;
    this.status = 'abandoned';
    abandonMatchStmt.run(this.id);
    this.cleanup();
  }

  private cleanup() {
    this.clearTurnTimer();
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.engine?.free();
    this.engine = null;
    this.onFinished?.();
  }

  // --- Turn clock / auto-play ---

  private armTurnTimer() {
    this.clearTurnTimer();
    if (this.status !== 'active' || !this.engine) return;
    const seat = this.currentActorSeat();
    if (seat < 0) return;
    const player = this.players[seat];
    const ms = player.isBot
      ? (this.timings.botTurnMs ?? 900)
      : player.connected
        ? this.timings.turnTimeoutMs
        : this.timings.disconnectedTurnMs;
    this.turnDeadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.autoAct(seat), ms);
  }

  private clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
  }

  /** The server acts for a slow or disconnected player using the expert AI. */
  private autoAct(seat: number) {
    if (this.status !== 'active' || !this.engine) return;
    if (this.currentActorSeat() !== seat) return;
    try {
      switch (this.engine.phase) {
        case Phase.BiddingRound1:
        case Phase.BiddingRound2: {
          const bid = this.engine.aiBid();
          this.engine.applyBid(bid);
          this.bidLog.push({ seat, bid });
          this.recordAction(seat, { type: 'bid', bid, auto: true });
          break;
        }
        case Phase.DealerDiscard: {
          const card = this.engine.aiDiscard();
          this.engine.dealerDiscard(card);
          this.recordAction(seat, { type: 'discard', card, auto: true });
          break;
        }
        case Phase.Playing: {
          const card = this.engine.aiPlay();
          this.engine.playCard(card);
          this.recordAction(seat, { type: 'play', card, auto: true });
          break;
        }
        default:
          return;
      }
      this.afterAction();
    } catch (err) {
      // Should be impossible (AI actions are legal); fail safe by abandoning
      console.error(`match ${this.id}: auto-act failed`, err);
      this.abandon();
    }
  }

  // --- State broadcast ---

  private recordAction(seat: number | null, action: Record<string, unknown>) {
    this.seq += 1;
    insertMatchAction.run(this.id, this.seq, seat, JSON.stringify(action));
  }

  private broadcastState() {
    for (const p of this.players) {
      if (p.connected) this.sendStateTo(p.seat);
    }
  }

  sendStateTo(seat: number) {
    if (!this.engine) return;
    const snap = this.engine.snapshot();
    // During a display pause (completed trick / between hands) no turn is
    // actionable — never advertise legal plays mid-pause.
    const paused = this.pauseTimer !== null;
    const isActor = !paused && this.currentActorSeat() === seat;
    this.send(seat, {
      type: 'state',
      matchId: this.id,
      yourSeat: seat,
      handNumber: this.handNumber,
      phase: snap.phase,
      players: this.players.map((p) => ({
        seat: p.seat,
        username: p.username,
        elo: p.elo,
        connected: p.connected,
      })),
      // Information hiding: each player sees ONLY their own cards
      hand: this.engine.handOf(seat),
      handCounts: [0, 1, 2, 3].map((s) => this.engine!.handOf(s).length),
      legalPlays:
        isActor && snap.phase === Phase.Playing ? this.engine.legalPlays() : [],
      nextToPlay: snap.nextToPlay,
      trump: snap.trump,
      upcard: snap.upcard,
      dealer: snap.dealer,
      maker: snap.maker,
      trickNumber: snap.trickNumber,
      currentTrick: snap.currentTrick,
      tricksWon: snap.tricksWon,
      scores: snap.scores,
      alone: snap.alone,
      sittingOut: snap.sittingOut,
      turnedDownSuit: snap.turnedDownSuit,
      bidLog: this.bidLog,
      turnDeadline: this.turnDeadline,
      paused,
      trumpMustBeBroken: this.trumpMustBeBroken,
    });
  }

  private sendError(userId: number, message: string) {
    const seat = this.seatOf(userId);
    if (seat !== undefined) this.sendErrorSeat(seat, message);
  }

  private sendErrorSeat(seat: number, message: string) {
    this.send(seat, { type: 'error', message });
  }
}
