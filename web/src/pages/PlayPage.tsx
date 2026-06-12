import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useUI, useSettings } from '../stores/store';
import { getEngine, resetEngine } from '../engine/bridge';
import type { PimcResult } from '../engine/worker';
import {
  createGame as createGameApi,
  updateGame,
  ApiError,
  flushOutbox,
  outboxPut,
  outboxRemove,
} from '../db/api';
import type { HandRecord, BidRecord, PlayRecord, DecisionRecord, HandAnalysisRecord } from '../db/schema';
import GameTable from '../components/GameTable';
import BiddingPanel from '../components/BiddingPanel';
import DiscardPanel from '../components/DiscardPanel';
import DealingAnimation from '../components/DealingAnimation';
import HandSummary from '../components/HandSummary';
import GameOver from '../components/GameOver';
import type { CardData } from '../components/cards/Card';

const SUIT_SYMBOLS = ['♥', '♦', '♣', '♠'];
const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];

function bidLabel(action: number): string {
  if (action === 0) return 'Pass';
  if (action === 1) return 'Order Up!';
  if (action >= 2 && action <= 5) return `${SUIT_SYMBOLS[action - 2]} ${SUIT_NAMES[action - 2]}`;
  if (action === 6) return 'Alone!';
  if (action >= 7 && action <= 10) return `${SUIT_SYMBOLS[action - 7]} Alone!`;
  return 'Pass';
}

interface BidEntry {
  seat: number;
  label: string;
}

interface TrickCard {
  seat: number;
  card: CardData;
}

interface Decision {
  /** Index within the recorded plays of this hand (for review mapping). */
  playIndex: number;
  played: CardData;
  optimal: CardData;
  wpc: number;
  etd: number;
  grade: string;
}

interface BidAnalysis {
  grade: string;         // 'good' | 'inaccuracy' | 'mistake' | 'blunder'
  message: string;       // Human-readable explanation
  humanCalled: boolean;  // Did the human call trump?
  trumpStrength: number; // Hand strength score (0-10)
  wasEuchred: boolean;
}

// Same-color suit pairs for Left Bower detection
const SAME_COLOR: Record<number, number> = { 0: 1, 1: 0, 2: 3, 3: 2 };

/**
 * Compute a trump strength score for bidding evaluation.
 * Mirrors the engine's scale exactly (engine/src/ai/opponents.rs
 * trump_strength): Right Bower 3, Left Bower 2, trump Ace 2, other trump 1,
 * off-suit Ace 1. The AI calls around effective strength 6.
 */
function trumpStrength(hand: CardData[], trump: number): number {
  const leftSuit = SAME_COLOR[trump];
  let score = 0;
  for (const c of hand) {
    const isTrump = c.suit === trump;
    const isLeftBower = c.rank === 2 && c.suit === leftSuit;
    if (c.rank === 2 && isTrump) score += 3;      // Right Bower
    else if (isLeftBower) score += 2;              // Left Bower
    else if (isTrump && c.rank === 5) score += 2;  // Ace of trump
    else if (isTrump) score += 1;                  // Other trump
    else if (c.rank === 5) score += 1;             // Off-suit Ace
  }
  return score;
}

/** Value of the upcard going to the dealer, from the bidder's perspective. */
function orderUpBonus(upcard: CardData, dealerSeat: number, humanSeat: number): number {
  const dealerIsSelf = dealerSeat === humanSeat;
  const dealerIsPartner = dealerSeat === (humanSeat + 2) % 4;
  if (dealerIsSelf) {
    // We pick it up ourselves (jack of the upcard suit = right bower)
    if (upcard.rank === 2) return 3;
    if (upcard.rank === 5) return 2;
    return 1;
  }
  if (dealerIsPartner) return 1; // partner gains a trump
  return -2; // ordering up arms the opposing dealer
}

/**
 * Analyze the human's bidding decision after the hand is scored.
 * Only ever judges decisions the human ACTUALLY faced:
 * - Round 1: the only callable suit is the upcard suit (order up).
 * - Round 2: any suit EXCEPT the turned-down (upcard) suit — and only if
 *   bidding actually reached the human in round 2.
 */
function analyzeBid(
  dealHand: CardData[],  // Human's hand at deal time
  humanBids: { action: number }[],
  trump: number,
  maker: number,
  humanSeat: number,
  tricksWon: [number, number],
  isEuchre: boolean,
  upcard: CardData,
  dealerSeat: number,
): BidAnalysis {
  const humanCalled = maker === humanSeat;
  const humanTeam = humanSeat % 2;
  const wasEuchred = isEuchre && maker % 2 === humanTeam;
  const orderedUp = trump === upcard.suit; // round-2 calls of the upcard suit are illegal

  if (humanCalled) {
    // Grade the call: hand strength in the called trump, adjusted for where
    // the upcard went when this was a round-1 order-up.
    const raw = trumpStrength(dealHand, trump);
    const bonus = orderedUp ? orderUpBonus(upcard, dealerSeat, humanSeat) : 0;
    const strength = raw + bonus;
    const detail =
      orderedUp && bonus !== 0
        ? ` (hand ${raw}${bonus > 0 ? ` + ${bonus} for the pickup` : ` − ${-bonus} for arming their dealer`})`
        : ` (strength ${raw})`;

    if (wasEuchred) {
      if (strength < 5) {
        return { grade: 'blunder', message: `Weak ${SUIT_NAMES[trump]} call${detail} — got euchred. The AI calls around 6.`, humanCalled, trumpStrength: strength, wasEuchred };
      }
      return { grade: 'mistake', message: `Reasonable ${SUIT_NAMES[trump]} call${detail} but got euchred. Bad luck or tough defense.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    if (strength >= 6) {
      return { grade: 'good', message: `Strong ${SUIT_NAMES[trump]} call${detail}. Good decision.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    const teamTricks = tricksWon[humanTeam];
    if (strength >= 5) {
      if (teamTricks >= 3) {
        return { grade: 'good', message: `Marginal ${SUIT_NAMES[trump]} call${detail} that worked out — ${teamTricks} tricks.`, humanCalled, trumpStrength: strength, wasEuchred };
      }
      return { grade: 'inaccuracy', message: `Marginal ${SUIT_NAMES[trump]} call${detail}. Risky.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    if (teamTricks >= 3) {
      return { grade: 'inaccuracy', message: `Weak ${SUIT_NAMES[trump]} call${detail} — got lucky with ${teamTricks} tricks.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    return { grade: 'mistake', message: `Weak ${SUIT_NAMES[trump]} call${detail}. The AI calls around 6.`, humanCalled, trumpStrength: strength, wasEuchred };
  }

  // --- Human did not end up as maker. Judge only the decisions they faced. ---
  if (humanBids.length === 0) {
    return { grade: 'good', message: `Trump was called before your turn — no bidding decision to grade.`, humanCalled, trumpStrength: 0, wasEuchred };
  }

  // Which rounds did the human actually act in? If the hand was ordered up,
  // round 2 never happened, so every recorded bid was round 1. Otherwise the
  // first bid was round 1 and a second bid (if any) was round 2.
  const facedRound2 = !orderedUp && humanBids.length >= 2;

  // Round 1: the only option was ordering up the upcard suit
  const r1Raw = trumpStrength(dealHand, upcard.suit);
  const r1Effective = r1Raw + orderUpBonus(upcard, dealerSeat, humanSeat);

  // Round 2: best suit excluding the turned-down suit
  let r2BestSuit = -1;
  let r2BestStr = 0;
  if (facedRound2) {
    for (let s = 0; s < 4; s++) {
      if (s === upcard.suit) continue; // turned down — illegal to call
      const str = trumpStrength(dealHand, s);
      if (str > r2BestStr) { r2BestStr = str; r2BestSuit = s; }
    }
  }

  // Report the biggest missed opportunity, if any
  if (facedRound2 && r2BestStr >= 7 && r2BestStr >= r1Effective) {
    return { grade: 'mistake', message: `Passed in round 2 holding a strong ${SUIT_NAMES[r2BestSuit]} hand (strength ${r2BestStr}). Should have called it.`, humanCalled, trumpStrength: r2BestStr, wasEuchred };
  }
  if (r1Effective >= 7) {
    return { grade: 'mistake', message: `Passed on ordering up ${SUIT_NAMES[upcard.suit]} with effective strength ${r1Effective}. Should have called.`, humanCalled, trumpStrength: r1Effective, wasEuchred };
  }
  if (facedRound2 && r2BestStr >= 6 && r2BestStr >= r1Effective) {
    return { grade: 'inaccuracy', message: `Passed in round 2 with a decent ${SUIT_NAMES[r2BestSuit]} hand (strength ${r2BestStr}). Worth considering.`, humanCalled, trumpStrength: r2BestStr, wasEuchred };
  }
  if (r1Effective >= 6) {
    return { grade: 'inaccuracy', message: `Ordering up ${SUIT_NAMES[upcard.suit]} (effective strength ${r1Effective}) was worth considering.`, humanCalled, trumpStrength: r1Effective, wasEuchred };
  }
  return { grade: 'good', message: `Good pass — nothing strong enough to call.`, humanCalled, trumpStrength: Math.max(r1Effective, r2BestStr), wasEuchred };
}

type GamePhase = 'idle' | 'loading' | 'dealing' | 'bidding1' | 'bidding2' | 'discarding' | 'playing' | 'scoring' | 'summary' | 'gameover';

interface GameState {
  phase: GamePhase;
  hands: CardData[][];
  currentTrick: TrickCard[];
  legalPlays: CardData[];
  trumpSuit: number;
  turnedDownSuit: number; // -1 until bidding round 2
  dealer: number;
  tricksWon: [number, number];
  scores: [number, number];
  trickNumber: number;
  nextSeat: number;
  upcard: CardData | null;
  handPoints: number;
  decisions: Decision[];
  totalWpc: number;      // per-hand (reset each hand, shown in HandSummary)
  totalEtd: number;      // per-hand
  gameWpc: number;       // accumulated across the whole game (shown in GameOver)
  handsPlayed: number;
  alone: boolean;
  sittingOut: number;
  bidLog: BidEntry[];
  maker: number;
  bidAnalysis: BidAnalysis | null;
}

type GameAction =
  | { type: 'SET_STATE'; payload: Partial<GameState> }
  | { type: 'RESET' };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'SET_STATE':
      return { ...state, ...action.payload };
    case 'RESET':
      return { ...initialState };
    default:
      return state;
  }
}

const initialState: GameState = {
  phase: 'idle',
  hands: [[], [], [], []],
  currentTrick: [],
  legalPlays: [],
  trumpSuit: 0,
  turnedDownSuit: -1,
  dealer: 0,
  tricksWon: [0, 0],
  scores: [0, 0],
  trickNumber: 1,
  nextSeat: 0,
  upcard: null,
  handPoints: 0,
  decisions: [],
  totalWpc: 0,
  totalEtd: 0,
  gameWpc: 0,
  handsPlayed: 0,
  alone: false,
  sittingOut: -1,
  bidLog: [],
  maker: 0,
  bidAnalysis: null,
};

const HUMAN_SEAT = 0;

const PIMC_TIMEOUT_MS = 30_000;

/** Cancellation token for in-flight AI loops (cancelled by New Game / Start Game). */
interface CancelToken {
  aborted: boolean;
}

/** Reject if `promise` doesn't settle within `ms` (the promise itself keeps running). */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

interface SaveHandData {
  tricksWon: [number, number];
  handPoints: number;
  isEuchre: boolean;
  isSweep: boolean;
  alone: boolean;
  decisions: Decision[];
  totalWpc: number;
  totalEtd: number;
  finalScore: [number, number];
}

interface PlayPageProps {
  /** False when PlayPage is mounted but hidden (other route active). */
  active?: boolean;
}

export default function PlayPage({ active = true }: PlayPageProps) {
  const setEngineReady = useUI((s) => s.setEngineReady);
  const thinking = useUI((s) => s.thinking);
  const setThinking = useUI((s) => s.setThinking);
  const restartRequested = useUI((s) => s.restartRequested);
  const difficulty = useSettings((s) => s.difficulty);

  const [game, dispatch] = useReducer(gameReducer, initialState);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Guard against concurrent operations (double-click, overlapping AI turns)
  const busyRef = useRef(false);

  // Guard against re-entrant New Game / Start Game
  const restartingRef = useRef(false);

  // Cancellation token for the in-flight AI loop (B2). acquireLoop cancels
  // any previous loop and takes ownership of busyRef release.
  const currentLoopRef = useRef<CancelToken>({ aborted: false });

  const acquireLoop = useCallback((): CancelToken => {
    currentLoopRef.current.aborted = true;
    const token: CancelToken = { aborted: false };
    currentLoopRef.current = token;
    return token;
  }, []);

  const releaseLoop = useCallback((token: CancelToken) => {
    // Only the current owner releases the busy flag — a cancelled loop
    // winding down must not unlock a newer operation's guard.
    if (currentLoopRef.current === token) {
      busyRef.current = false;
    }
  }, []);

  // Mutable bid log accumulator (avoids stale closures in processAiTurns)
  const bidLogRef = useRef<BidEntry[]>([]);

  // Game recording (mutable ref — doesn't trigger re-renders)
  const recording = useRef<{
    gameId: number | null;
    seed: number;
    deal: CardData[][];
    bids: BidRecord[];
    plays: PlayRecord[];
  }>({ gameId: null, seed: 0, deal: [], bids: [], plays: [] });

  // Full local copy of the current game (offline-first source of truth, B4)
  const localGameRef = useRef<{
    localId: string;
    seed: number;
    difficulty: number;
    hands: HandRecord[];
    analysis: HandAnalysisRecord[];
    finalScore: [number, number];
  }>({ localId: '', seed: 0, difficulty: 0, hands: [], analysis: [], finalScore: [0, 0] });

  // Latest per-hand analysis values, mirrored from reducer state so that
  // hand completion can be handled from ANY code path (bid/discard/deal
  // loops included) without stale closures.
  const analysisRef = useRef<{ decisions: Decision[]; totalWpc: number; totalEtd: number }>({
    decisions: [],
    totalWpc: 0,
    totalEtd: 0,
  });

  // Try to push any queued offline games at app start (B4)
  useEffect(() => {
    void flushOutbox();
  }, []);

  const startRecording = useCallback(async (seed: number) => {
    const engine = getEngine();
    const deal: CardData[][] = [];
    for (let i = 0; i < 4; i++) {
      deal.push(await engine.getHand(i));
    }
    recording.current = { gameId: recording.current.gameId, seed, deal, bids: [], plays: [] };
  }, []);

  /**
   * Start tracking a brand-new game locally and create the server record in
   * the background — game start never blocks on the network (B4).
   */
  const beginGameRecord = useCallback((seed: number) => {
    const localId = crypto.randomUUID();
    localGameRef.current = { localId, seed, difficulty, hands: [], analysis: [], finalScore: [0, 0] };
    recording.current.gameId = null;
    void createGameApi({ seed, difficulty })
      .then((created) => {
        // Only adopt the id if this is still the same game
        if (localGameRef.current.localId === localId) {
          recording.current.gameId = created.id;
        }
      })
      .catch((err) => {
        console.warn('createGame failed — game will be saved via outbox:', err);
      });
  }, [difficulty]);

  const recordBid = useCallback((seat: number, action: number) => {
    recording.current.bids.push({ seat, action });
  }, []);

  const recordPlay = useCallback((seat: number, card: CardData) => {
    recording.current.plays.push({ seat, card: { suit: card.suit, rank: card.rank } });
  }, []);

  // syncState must be defined before processAiTurns
  const syncState = useCallback(async () => {
    const engine = getEngine();
    const phase = await engine.phase();
    const hands: CardData[][] = [];
    for (let i = 0; i < 4; i++) {
      hands.push(await engine.getHand(i));
    }
    const legalPlays = phase === 4 ? await engine.getLegalPlays() : [];
    const nextSeat = await engine.nextToPlay();
    const trumpSuit = await engine.trump();
    const turnedDownSuit = await engine.turnedDownSuit();
    const dealer = await engine.dealer();
    const tricksWon = await engine.tricksWon();
    const scores = await engine.scores();
    const trickNumber = await engine.trickNumber();
    const currentTrick = await engine.currentTrick();
    const upcard = await engine.upcard();
    const alone = await engine.isAlone();
    const sittingOut = await engine.sittingOut();
    const maker = await engine.maker();

    let gamePhase: GamePhase;
    switch (phase) {
      case 1: gamePhase = 'bidding1'; break;
      case 2: gamePhase = 'bidding2'; break;
      case 3: gamePhase = 'discarding'; break;
      case 4: gamePhase = 'playing'; break;
      case 5: gamePhase = 'scoring'; break;
      default: gamePhase = 'playing';
    }

    dispatch({
      type: 'SET_STATE',
      payload: {
        phase: gamePhase,
        hands,
        legalPlays,
        nextSeat,
        trumpSuit,
        turnedDownSuit,
        dealer,
        tricksWon,
        scores,
        trickNumber,
        currentTrick,
        upcard,
        alone,
        sittingOut,
        maker,
      },
    });

    return { gamePhase, nextSeat };
  }, []);

  // Process AI turns (bidding or playing) until it's the human's turn.
  // The cancel token lets New Game / Start Game abort a loop mid-flight (B2).
  const processAiTurns = useCallback(async (signal: CancelToken) => {
    const engine = getEngine();
    let { gamePhase, nextSeat } = await syncState();
    if (signal.aborted) return { gamePhase, nextSeat };

    // If a trick just completed (e.g. human played the last card), pause then collect
    if (await engine.hasCompletedTrick()) {
      await new Promise((r) => setTimeout(r, 1000));
      if (signal.aborted) return { gamePhase, nextSeat };
      await engine.collectTrick();
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI bidding loop
    while ((gamePhase === 'bidding1' || gamePhase === 'bidding2') && nextSeat !== HUMAN_SEAT) {
      if (signal.aborted) return { gamePhase, nextSeat };
      await new Promise((r) => setTimeout(r, 400));
      if (signal.aborted) return { gamePhase, nextSeat };
      const aiBid = await engine.getAiBid();
      const bidSeat = nextSeat;
      recordBid(bidSeat, aiBid);

      // Show bid indicator before applying (use ref to avoid stale closure)
      bidLogRef.current = [...bidLogRef.current, { seat: bidSeat, label: bidLabel(aiBid) }];
      dispatch({ type: 'SET_STATE', payload: { bidLog: [...bidLogRef.current] } });

      // If AI orders up in round 1, pause BEFORE applying so player can see the upcard
      if (aiBid === 1 && gamePhase === 'bidding1') {
        await new Promise((r) => setTimeout(r, 1000));
        if (signal.aborted) return { gamePhase, nextSeat };
      }

      await engine.applyBid(aiBid);
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI dealer discard (if dealer is not the human)
    if (gamePhase === 'discarding') {
      const dealerSeat = await engine.dealer();
      if (dealerSeat !== HUMAN_SEAT) {
        if (signal.aborted) return { gamePhase, nextSeat };
        await new Promise((r) => setTimeout(r, 300));
        if (signal.aborted) return { gamePhase, nextSeat };
        const aiDiscard = await engine.getAiDiscard();
        await engine.dealerDiscard(aiDiscard);
        ({ gamePhase, nextSeat } = await syncState());
      } else {
        // Human is dealer — stop and let UI show discard UI
        return { gamePhase, nextSeat };
      }
    }

    // AI playing loop (if AI leads after bidding resolves)
    let aiLoopCount = 0;
    while (gamePhase === 'playing' && nextSeat !== HUMAN_SEAT) {
      if (signal.aborted) return { gamePhase, nextSeat };
      aiLoopCount++;
      if (aiLoopCount > 20) {
        console.error('processAiTurns: AI loop exceeded 20 iterations — breaking to prevent infinite loop');
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
      if (signal.aborted) return { gamePhase, nextSeat };
      const aiCard = await engine.getAiPlay();
      recordPlay(nextSeat, aiCard);
      await engine.playCard(aiCard);
      // Sync to show the card just played (snapshot preserves completed trick)
      ({ gamePhase, nextSeat } = await syncState());
      // If trick just completed, pause to let player see all cards, then collect
      if (await engine.hasCompletedTrick()) {
        await new Promise((r) => setTimeout(r, 1000));
        if (signal.aborted) return { gamePhase, nextSeat };
        await engine.collectTrick();
        ({ gamePhase, nextSeat } = await syncState());
      }
    }

    return { gamePhase, nextSeat };
  }, [syncState, recordBid, recordPlay]);

  // Start a new game — called from the start screen or internally
  const handleStartGame = useCallback(async () => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    // Cancel any stale in-flight loop before re-initializing the engine (B2)
    const token = acquireLoop();
    busyRef.current = true;
    dispatch({ type: 'SET_STATE', payload: { phase: 'loading' } });

    try {
      const engine = getEngine();
      const seed = Math.floor(Math.random() * 2 ** 32);
      await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });

      beginGameRecord(seed); // server record is created in the background (B4)
      await startRecording(seed);
      analysisRef.current = { decisions: [], totalWpc: 0, totalEtd: 0 };

      setEngineReady(true);

      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing', bidLog: [] } });
      bidLogRef.current = [];
    } catch (err) {
      console.error('Engine init failed:', err);
      setEngineError(err instanceof Error ? err.message : 'Failed to initialize engine');
    } finally {
      restartingRef.current = false;
      releaseLoop(token);
    }
  }, [difficulty, acquireLoop, releaseLoop, beginGameRecord, syncState, startRecording, setEngineReady]);

  /**
   * Persist a finished hand. All values are passed in explicitly, fetched
   * fresh from the engine at the call site (B1 — no stale closure state).
   * Network I/O happens in the background; failures land in the outbox (B4).
   */
  const saveHand = useCallback(async (data: SaveHandData) => {
    const rec = recording.current;

    const handRecord: HandRecord = {
      deal: rec.deal,
      bids: rec.bids,
      plays: rec.plays,
      alone: data.alone,
      result: {
        tricks: data.tricksWon,
        points: data.handPoints,
        isEuchre: data.isEuchre,
        isSweep: data.isSweep,
      },
    };

    const playsPerTrick = data.alone ? 3 : 4;
    const analysisRecord: HandAnalysisRecord = {
      decisions: data.decisions.map((d): DecisionRecord => ({
        trickNumber: Math.floor(d.playIndex / playsPerTrick) + 1,
        playIndex: d.playIndex,
        played: { suit: d.played.suit, rank: d.played.rank },
        optimal: { suit: d.optimal.suit, rank: d.optimal.rank },
        wpc: d.wpc,
        etd: d.etd,
        grade: d.grade,
      })),
      totalWpc: data.totalWpc,
      totalEtd: data.totalEtd,
    };

    // Accumulate locally first — the game must work fully offline
    const local = localGameRef.current;
    local.hands.push(handRecord);
    local.analysis.push(analysisRecord);
    local.finalScore = data.finalScore;

    // Server sync in the background; never blocks gameplay
    void (async () => {
      try {
        if (rec.gameId == null) throw new ApiError('Game not yet created on server');
        await updateGame(rec.gameId, {
          hands: [...local.hands],
          analysis: [...local.analysis],
          finalScore: local.finalScore,
        });
        outboxRemove(local.localId);
      } catch (err) {
        console.warn('Failed to save hand to server — queued in outbox:', err);
        outboxPut({
          localId: local.localId,
          serverId: rec.gameId ?? undefined,
          seed: local.seed,
          difficulty: local.difficulty,
          hands: [...local.hands],
          analysis: [...local.analysis],
          finalScore: local.finalScore,
        });
      }
      // Opportunistic flush of anything still queued (this game or older ones)
      const syncedIds = await flushOutbox();
      if (recording.current.gameId == null && localGameRef.current.localId === local.localId) {
        const serverId = syncedIds[local.localId];
        if (serverId != null) recording.current.gameId = serverId;
      }
    })();
  }, []);

  /**
   * Score the completed hand and move the UI to the summary/game-over screen.
   * Reachable from EVERY path that can end a hand — including hands where the
   * human never plays a card (the human sits out when their partner goes
   * alone). Reads analysis values from analysisRef to avoid stale closures.
   */
  const finishHand = useCallback(async (token: CancelToken) => {
    const engine = getEngine();
    const { decisions, totalWpc, totalEtd } = analysisRef.current;

    // Fetch end-of-hand values fresh from the engine — closure state
    // predates the final trick and final decision (B1)
    const finalTricksWon = await engine.tricksWon();
    const aloneHand = await engine.isAlone();
    const result = await engine.scoreHand(); // throws if called twice per hand
    const makerSeat = await engine.maker();
    const makerIsUs = makerSeat % 2 === 0; // seats 0,2 = team 0 (us)
    const makerPoints = result[0];
    // Convert from maker's perspective to human's (team 0) perspective
    const handPoints = makerIsUs ? makerPoints : -makerPoints;
    const isEuchre = result[1];
    const isSweep = result[2];
    const updatedScores = await engine.scores();
    const trumpSuit = await engine.trump();
    const winner = await engine.winner();
    const upcard = (await engine.upcard()) ?? { suit: 0, rank: 0 };
    const dealerSeat = await engine.dealer();

    await saveHand({
      tricksWon: finalTricksWon,
      handPoints,
      isEuchre,
      isSweep,
      alone: aloneHand,
      decisions,
      totalWpc,
      totalEtd,
      finalScore: updatedScores,
    });

    if (token.aborted) return;

    // Analyze the human's bidding decision
    const humanBids = recording.current.bids.filter(b => b.seat === HUMAN_SEAT);
    const bidAn = analyzeBid(
      recording.current.deal[HUMAN_SEAT] || [],
      humanBids,
      trumpSuit,
      makerSeat,
      HUMAN_SEAT,
      finalTricksWon,
      isEuchre,
      upcard,
      dealerSeat,
    );

    dispatch({
      type: 'SET_STATE',
      payload: {
        phase: winner >= 0 ? 'gameover' : 'summary',
        handPoints,
        handsPlayed: game.handsPlayed + 1,
        scores: updatedScores,
        tricksWon: finalTricksWon,
        bidAnalysis: bidAn,
      },
    });
  }, [saveHand, game.handsPlayed]);

  const handleDealingComplete = useCallback(async () => {
    // Acquire the busy guard so clicks during the AI loop (or a concurrent
    // dealing-complete callback) can't run a second loop against the engine (B2)
    if (busyRef.current) return;
    busyRef.current = true;
    const token = acquireLoop();
    try {
      const { gamePhase } = await processAiTurns(token);
      // The hand can end without the human ever acting (human sits out)
      if (gamePhase === 'scoring' && !token.aborted) {
        await finishHand(token);
      }
    } catch (err) {
      console.error('Error processing AI turns after deal:', err);
      if (!token.aborted) {
        setEngineError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Release before returning so the human can play when it's their turn
      releaseLoop(token);
    }
  }, [acquireLoop, releaseLoop, processAiTurns, finishHand]);

  const handlePlayCard = useCallback(async (card: CardData) => {
    // Guard: prevent concurrent plays (double-click or stuck thinking)
    if (busyRef.current) return;
    busyRef.current = true;
    const token = acquireLoop();
    setThinking(true);

    try {
      const engine = getEngine();

      // Run PIMC evaluation before playing (20 determinizations for interactive play)
      // Skip when only 1 legal play (nothing to analyze, avoids unnecessary WASM work).
      // Guarded by a 30s timeout so a hung analysis can't freeze the game forever —
      // on timeout we skip analysis for this decision and keep playing (B5).
      let pimcResult: PimcResult | null = null;
      const currentLegal = await engine.getLegalPlays();
      if (currentLegal.length > 1) {
        const seed = Math.floor(Math.random() * 2 ** 32);
        try {
          pimcResult = await withTimeout(
            engine.evaluatePlays(20, seed),
            PIMC_TIMEOUT_MS,
            'PIMC evaluation timed out',
          );
        } catch (pimcErr) {
          console.warn('PIMC evaluation failed:', pimcErr);
          // A WASM panic (unreachable) corrupts the engine instance permanently.
          // Any subsequent calls would return garbage or crash.
          const msg = pimcErr instanceof Error ? pimcErr.message : String(pimcErr);
          if (msg.includes('unreachable') || msg.includes('abort')) {
            setEngineError('Engine crashed during analysis — start a new game to recover.');
            return;
          }
          // Timeout or non-WASM error (e.g. serialization) — continue without analysis
        }
      }

      // The index this play will occupy in the recorded plays (for review mapping, B6)
      const humanPlayIndex = recording.current.plays.length;

      // Record and play human card
      recordPlay(HUMAN_SEAT, card);
      await engine.playCard(card);

      // Analyze the decision (skip if PIMC failed). The values are mirrored
      // into analysisRef so hand completion sees the final decision even
      // though React state updates asynchronously (B1).
      if (pimcResult) {
        const analysis = await engine.analyzeDecision(pimcResult, card);
        const newDecision: Decision = {
          playIndex: humanPlayIndex,
          played: analysis.played,
          optimal: analysis.optimal,
          wpc: analysis.wpc,
          etd: analysis.etd,
          grade: analysis.grade,
        };
        analysisRef.current = {
          decisions: [...analysisRef.current.decisions, newDecision],
          totalWpc: analysisRef.current.totalWpc + analysis.wpc,
          totalEtd: analysisRef.current.totalEtd + analysis.etd,
        };

        dispatch({
          type: 'SET_STATE',
          payload: {
            decisions: analysisRef.current.decisions,
            totalWpc: analysisRef.current.totalWpc,
            totalEtd: analysisRef.current.totalEtd,
            gameWpc: game.gameWpc + analysis.wpc, // game-level accumulator (B11)
          },
        });
      }

      const { gamePhase } = await processAiTurns(token);
      if (token.aborted) return;

      if (gamePhase === 'scoring') {
        await finishHand(token);
      }
    } catch (err) {
      console.error('Error during play:', err);
      if (!token.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setEngineError(
          msg.includes('unreachable') || msg.includes('recursive use') || msg.includes('unsafe aliasing')
            ? 'Engine crashed — the hand cannot continue. Start a new game to recover.'
            : msg,
        );
      }
    } finally {
      setThinking(false);
      releaseLoop(token);
    }
  }, [acquireLoop, releaseLoop, processAiTurns, setThinking, recordPlay, finishHand, game.gameWpc]);

  const handleBid = useCallback(async (bidVal: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const token = acquireLoop();
    setThinking(true);

    try {
      const engine = getEngine();
      recordBid(HUMAN_SEAT, bidVal);

      // Add human bid to visible bid log
      bidLogRef.current = [...bidLogRef.current, { seat: HUMAN_SEAT, label: bidLabel(bidVal) }];
      dispatch({ type: 'SET_STATE', payload: { bidLog: [...bidLogRef.current] } });

      await engine.applyBid(bidVal);
      const { gamePhase } = await processAiTurns(token);
      // The hand can complete without any human play — e.g. the human's
      // partner goes alone and the human sits out the entire hand.
      if (gamePhase === 'scoring' && !token.aborted) {
        await finishHand(token);
      }
    } catch (err) {
      console.error('Error during bid:', err);
      if (!token.aborted) {
        setEngineError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setThinking(false);
      releaseLoop(token);
    }
  }, [acquireLoop, releaseLoop, processAiTurns, setThinking, recordBid, finishHand]);

  const handleDiscard = useCallback(async (card: CardData) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const token = acquireLoop();
    setThinking(true);

    try {
      const engine = getEngine();
      await engine.dealerDiscard(card);
      const { gamePhase } = await processAiTurns(token);
      if (gamePhase === 'scoring' && !token.aborted) {
        await finishHand(token);
      }
    } catch (err) {
      console.error('Error during discard:', err);
      if (!token.aborted) {
        setEngineError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setThinking(false);
      releaseLoop(token);
    }
  }, [acquireLoop, releaseLoop, processAiTurns, setThinking, finishHand]);

  const handleContinue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const token = acquireLoop();

    try {
      const engine = getEngine();
      const seed = Math.floor(Math.random() * 2 ** 32);
      const newDealer = (game.dealer + 1) % 4;
      await engine.init({
        seed,
        difficulty,
        dealer: newDealer,
        scores: game.scores,
      });
      bidLogRef.current = [];
      // Per-hand stats reset; gameWpc intentionally carries across hands (B11)
      analysisRef.current = { decisions: [], totalWpc: 0, totalEtd: 0 };
      dispatch({ type: 'SET_STATE', payload: { decisions: [], totalWpc: 0, totalEtd: 0, bidLog: [], bidAnalysis: null } });
      await startRecording(seed);
      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing' } });
    } catch (err) {
      console.error('Error during continue:', err);
      if (!token.aborted) {
        setEngineError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      releaseLoop(token);
    }
  }, [game.dealer, game.scores, difficulty, acquireLoop, releaseLoop, syncState, startRecording]);

  const handleNewGame = useCallback(async () => {
    // B8: never silently ignore — cancel any in-flight AI loop and proceed.
    if (restartingRef.current) return;
    restartingRef.current = true;
    const token = acquireLoop();
    busyRef.current = true;

    try {
      const engine = getEngine();
      const seed = Math.floor(Math.random() * 2 ** 32);
      await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });

      dispatch({ type: 'RESET' });
      bidLogRef.current = [];
      analysisRef.current = { decisions: [], totalWpc: 0, totalEtd: 0 };
      beginGameRecord(seed); // server record is created in the background (B4)
      await startRecording(seed);
      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing', bidLog: [] } });
    } catch (err) {
      console.error('Error during new game:', err);
      setEngineError(err instanceof Error ? err.message : String(err));
    } finally {
      restartingRef.current = false;
      releaseLoop(token);
    }
  }, [difficulty, acquireLoop, releaseLoop, beginGameRecord, syncState, startRecording]);

  // Recover from a poisoned WASM instance: terminate the worker, then init fresh (B5)
  const handleErrorRecovery = useCallback(() => {
    void (async () => {
      setEngineError(null);
      await resetEngine();
      await handleNewGame();
    })();
  }, [handleNewGame]);

  // React to nav "New Game" requests
  const restartRef = useRef(restartRequested);
  useEffect(() => {
    if (restartRequested > restartRef.current) {
      restartRef.current = restartRequested;
      if (game.phase !== 'idle' && game.phase !== 'loading') {
        handleNewGame();
      } else if (game.phase === 'idle') {
        handleStartGame();
      }
    }
  }, [restartRequested, game.phase, handleNewGame, handleStartGame]);

  if (engineError) {
    return (
      <div className="engine-error">
        <h2>Engine Error</h2>
        <p>{engineError}</p>
        <button onClick={handleErrorRecovery}>New Game</button>
        <button onClick={() => window.location.reload()} style={{ marginLeft: 8 }}>Reload Page</button>
      </div>
    );
  }

  if (game.phase === 'idle') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 24 }}>
        <h1 style={{ fontSize: 32, margin: 0 }}>Euchre Trainer</h1>
        <p style={{ color: '#aaa', margin: 0 }}>Practice your Euchre skills against AI opponents</p>
        <button
          onClick={handleStartGame}
          style={{
            padding: '14px 48px',
            fontSize: 18,
            fontWeight: 600,
            borderRadius: 8,
            border: 'none',
            background: '#2196F3',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Start Game
        </button>
      </div>
    );
  }

  if (game.phase === 'loading') {
    return (
      <div className="loading">
        <p>Loading engine...</p>
      </div>
    );
  }

  const emptyHands: CardData[][] = [[], [], [], []];

  return (
    <div className="play-page">
      <div style={{ position: 'relative', maxWidth: 700, margin: '0 auto' }}>
        <GameTable
          hands={game.phase === 'dealing' ? emptyHands : game.hands}
          currentTrick={game.currentTrick}
          legalPlays={game.phase === 'discarding' && game.dealer === HUMAN_SEAT
            ? game.hands[HUMAN_SEAT] || []
            : game.legalPlays}
          trumpSuit={game.trumpSuit}
          dealer={game.dealer}
          tricksWon={game.tricksWon}
          scores={game.scores}
          trickNumber={game.trickNumber}
          humanSeat={HUMAN_SEAT}
          onPlayCard={game.phase === 'discarding' ? handleDiscard : handlePlayCard}
          thinking={thinking}
          active={active}
          upcard={game.phase === 'dealing' ? null : game.upcard}
          phase={game.phase}
          maker={game.maker}
          sittingOut={game.sittingOut}
          bidLog={game.phase === 'bidding1' || game.phase === 'bidding2' ? game.bidLog : []}
        />

        {game.phase === 'dealing' && (
          <DealingAnimation
            dealer={game.dealer}
            humanSeat={HUMAN_SEAT}
            upcard={game.upcard}
            onComplete={handleDealingComplete}
          />
        )}
      </div>

      {game.phase === 'discarding' && game.dealer === HUMAN_SEAT && (
        <DiscardPanel />
      )}

      {(game.phase === 'bidding1' || game.phase === 'bidding2') && game.nextSeat === HUMAN_SEAT && (
        <BiddingPanel
          phase={game.phase === 'bidding1' ? 'round1' : 'round2'}
          upcard={game.upcard}
          isDealer={game.nextSeat === game.dealer}
          turnedDownSuit={game.turnedDownSuit}
          onBid={handleBid}
        />
      )}

      {game.phase === 'summary' && (
        <HandSummary
          decisions={game.decisions}
          totalWpc={game.totalWpc}
          totalEtd={game.totalEtd}
          tricksWon={game.tricksWon}
          handPoints={game.handPoints}
          alone={game.alone}
          bidAnalysis={game.bidAnalysis}
          onContinue={handleContinue}
        />
      )}

      {game.phase === 'gameover' && (
        <GameOver
          scores={game.scores}
          totalWpc={game.gameWpc}
          handsPlayed={game.handsPlayed}
          gameId={recording.current.gameId}
          onNewGame={handleNewGame}
        />
      )}
    </div>
  );
}
