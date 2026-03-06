import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useUI, useSettings } from '../stores/store';
import { getEngine } from '../engine/bridge';
import { db } from '../db/schema';
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

/** Count trump cards in hand (including Left Bower). */
function countTrump(hand: CardData[], trump: number): number {
  const leftSuit = SAME_COLOR[trump];
  return hand.filter(c =>
    c.suit === trump || (c.rank === 2 && c.suit === leftSuit) // rank 2 = Jack
  ).length;
}

/** Compute a trump strength score (0-10) for bidding evaluation. */
function trumpStrength(hand: CardData[], trump: number): number {
  const leftSuit = SAME_COLOR[trump];
  let score = 0;
  for (const c of hand) {
    const isTrump = c.suit === trump;
    const isLeftBower = c.rank === 2 && c.suit === leftSuit;
    if (c.rank === 2 && isTrump) score += 3;       // Right Bower
    else if (isLeftBower) score += 2.5;             // Left Bower
    else if (isTrump && c.rank === 5) score += 2;   // Ace of trump
    else if (isTrump && c.rank === 4) score += 1.5; // King of trump
    else if (isTrump) score += 1;                    // Other trump
    else if (c.rank === 5) score += 0.5;             // Off-suit Ace
  }
  return score;
}

/** Analyze the human's bidding decision after the hand is scored. */
function analyzeBid(
  dealHand: CardData[],  // Human's hand at deal time
  humanBids: { action: number }[],
  trump: number,
  upcard: CardData | null,
  maker: number,
  humanSeat: number,
  tricksWon: [number, number],
  isEuchre: boolean,
): BidAnalysis {
  const humanCalled = maker === humanSeat;
  const humanTeam = humanSeat % 2;
  const wasEuchred = isEuchre && maker % 2 === humanTeam;

  // What did the human bid?
  const humanOrderedUp = humanBids.some(b => b.action === 1 || b.action === 6);
  const humanCalledSuit = humanBids.some(b => (b.action >= 2 && b.action <= 5) || (b.action >= 7 && b.action <= 10));
  const humanPassed = !humanOrderedUp && !humanCalledSuit;

  // Strength for the trump that was actually called
  const strength = trumpStrength(dealHand, trump);

  // Also check strength for the upcard suit (round 1 consideration)
  const upcardStrength = upcard ? trumpStrength(dealHand, upcard.suit) : 0;

  if (humanCalled) {
    // Human called trump — evaluate if the hand was strong enough
    if (wasEuchred) {
      if (strength < 4) {
        return { grade: 'blunder', message: `Weak hand (strength ${strength.toFixed(1)}) — got euchred. Need 4+ to call.`, humanCalled, trumpStrength: strength, wasEuchred };
      }
      return { grade: 'mistake', message: `Decent hand but got euchred. Bad luck or tough defense.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    if (strength >= 5) {
      return { grade: 'good', message: `Strong call (strength ${strength.toFixed(1)}). Good decision.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    if (strength >= 3.5) {
      const teamTricks = tricksWon[humanTeam];
      if (teamTricks >= 3) {
        return { grade: 'good', message: `Marginal call that worked out. ${teamTricks} tricks won.`, humanCalled, trumpStrength: strength, wasEuchred };
      }
      return { grade: 'inaccuracy', message: `Marginal hand (strength ${strength.toFixed(1)}). Risky call.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    // Weak call that happened to work
    const teamTricks = tricksWon[humanTeam];
    if (teamTricks >= 3) {
      return { grade: 'inaccuracy', message: `Weak hand (strength ${strength.toFixed(1)}) — got lucky with ${teamTricks} tricks.`, humanCalled, trumpStrength: strength, wasEuchred };
    }
    return { grade: 'mistake', message: `Weak hand (strength ${strength.toFixed(1)}) to call trump.`, humanCalled, trumpStrength: strength, wasEuchred };
  } else {
    // Human passed — did they miss a good opportunity?
    // Check if they had a strong hand in any suit
    let bestSuit = 0;
    let bestStr = 0;
    for (let s = 0; s < 4; s++) {
      const str = trumpStrength(dealHand, s);
      if (str > bestStr) { bestStr = str; bestSuit = s; }
    }

    if (bestStr >= 6 && humanPassed) {
      return { grade: 'mistake', message: `Passed with a strong hand (${SUIT_NAMES[bestSuit]} strength ${bestStr.toFixed(1)}). Should have called.`, humanCalled, trumpStrength: bestStr, wasEuchred };
    }
    if (bestStr >= 5 && humanPassed) {
      return { grade: 'inaccuracy', message: `Passed with a decent hand (${SUIT_NAMES[bestSuit]} strength ${bestStr.toFixed(1)}). Consider calling.`, humanCalled, trumpStrength: bestStr, wasEuchred };
    }
    return { grade: 'good', message: `Good pass. No strong suit to call.`, humanCalled, trumpStrength: bestStr, wasEuchred };
  }
}

type GamePhase = 'idle' | 'loading' | 'dealing' | 'bidding1' | 'bidding2' | 'discarding' | 'playing' | 'scoring' | 'summary' | 'gameover';

interface GameState {
  phase: GamePhase;
  hands: CardData[][];
  currentTrick: TrickCard[];
  legalPlays: CardData[];
  trumpSuit: number;
  dealer: number;
  tricksWon: [number, number];
  scores: [number, number];
  trickNumber: number;
  nextSeat: number;
  upcard: CardData | null;
  handPoints: number;
  decisions: Decision[];
  totalWpc: number;
  totalEtd: number;
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
  handsPlayed: 0,
  alone: false,
  sittingOut: -1,
  bidLog: [],
  maker: 0,
  bidAnalysis: null,
};

const HUMAN_SEAT = 0;

/** Abort signal for cancelling stale processAiTurns loops (e.g. StrictMode double-mount). */
interface AbortSignal { aborted: boolean }

export default function PlayPage() {
  const engineReady = useUI((s) => s.engineReady);
  const setEngineReady = useUI((s) => s.setEngineReady);
  const thinking = useUI((s) => s.thinking);
  const setThinking = useUI((s) => s.setThinking);
  const restartRequested = useUI((s) => s.restartRequested);
  const difficulty = useSettings((s) => s.difficulty);

  const [game, dispatch] = useReducer(gameReducer, initialState);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Guard against concurrent operations (double-click, overlapping AI turns)
  const busyRef = useRef(false);

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

  const startRecording = useCallback(async (seed: number) => {
    const engine = getEngine();
    const deal: CardData[][] = [];
    for (let i = 0; i < 4; i++) {
      deal.push(await engine.getHand(i));
    }
    recording.current = { gameId: recording.current.gameId, seed, deal, bids: [], plays: [] };
  }, []);

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
    const dealer = await engine.dealer();
    const tricksWon = await engine.tricksWon() as [number, number];
    const scores = await engine.scores() as [number, number];
    const trickNumber = await engine.trickNumber();
    const currentTrick = await engine.currentTrick() as TrickCard[];
    const upcard = await engine.upcard() as CardData;
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
  // Accepts an optional abort signal so the init effect can cancel on cleanup.
  const processAiTurns = useCallback(async (signal?: AbortSignal) => {
    const engine = getEngine();
    let { gamePhase, nextSeat } = await syncState();

    // If a trick just completed (e.g. human played the last card), pause then collect
    if (await engine.hasCompletedTrick()) {
      await new Promise((r) => setTimeout(r, 1000));
      if (signal?.aborted) return { gamePhase, nextSeat };
      await engine.collectTrick();
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI bidding loop
    while ((gamePhase === 'bidding1' || gamePhase === 'bidding2') && nextSeat !== HUMAN_SEAT) {
      if (signal?.aborted) return { gamePhase, nextSeat };
      await new Promise((r) => setTimeout(r, 400));
      if (signal?.aborted) return { gamePhase, nextSeat };
      const aiBid = await engine.getAiBid();
      const bidSeat = nextSeat;
      recordBid(bidSeat, aiBid);

      // Show bid indicator before applying (use ref to avoid stale closure)
      bidLogRef.current = [...bidLogRef.current, { seat: bidSeat, label: bidLabel(aiBid) }];
      dispatch({ type: 'SET_STATE', payload: { bidLog: [...bidLogRef.current] } });

      // If AI orders up in round 1, pause BEFORE applying so player can see the upcard
      if (aiBid === 1 && gamePhase === 'bidding1') {
        await new Promise((r) => setTimeout(r, 1000));
        if (signal?.aborted) return { gamePhase, nextSeat };
      }

      await engine.applyBid(aiBid);
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI dealer discard (if dealer is not the human)
    if (gamePhase === 'discarding') {
      const dealerSeat = await engine.dealer();
      if (dealerSeat !== HUMAN_SEAT) {
        if (signal?.aborted) return { gamePhase, nextSeat };
        await new Promise((r) => setTimeout(r, 300));
        if (signal?.aborted) return { gamePhase, nextSeat };
        const aiDiscard = await engine.getAiDiscard() as CardData;
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
      if (signal?.aborted) return { gamePhase, nextSeat };
      aiLoopCount++;
      if (aiLoopCount > 20) {
        console.error('processAiTurns: AI loop exceeded 20 iterations — breaking to prevent infinite loop');
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
      if (signal?.aborted) return { gamePhase, nextSeat };
      const aiCard = await engine.getAiPlay() as CardData;
      recordPlay(nextSeat, aiCard);
      await engine.playCard(aiCard);
      // Sync to show the card just played (snapshot preserves completed trick)
      ({ gamePhase, nextSeat } = await syncState());
      // If trick just completed, pause to let player see all cards, then collect
      if (await engine.hasCompletedTrick()) {
        await new Promise((r) => setTimeout(r, 1000));
        if (signal?.aborted) return { gamePhase, nextSeat };
        await engine.collectTrick();
        ({ gamePhase, nextSeat } = await syncState());
      }
    }

    return { gamePhase, nextSeat };
  }, [syncState, recordBid, recordPlay]);

  // Start a new game — called from the start screen or internally
  const handleStartGame = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    dispatch({ type: 'SET_STATE', payload: { phase: 'loading' } });

    try {
      const engine = getEngine();
      const seed = Math.floor(Math.random() * 2 ** 32);
      await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });

      const gameId = await db.games.add({
        createdAt: new Date(),
        seed,
        difficulty,
        hands: [],
        finalScore: [0, 0],
        analysis: [],
      });

      await startRecording(seed);
      recording.current.gameId = gameId ?? null;

      setEngineReady(true);

      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing', bidLog: [] } });
      bidLogRef.current = [];
    } catch (err) {
      console.error('Engine init failed:', err);
      setEngineError(err instanceof Error ? err.message : 'Failed to initialize engine');
    } finally {
      busyRef.current = false;
    }
  }, [difficulty, syncState, startRecording, setEngineReady]);

  const saveHand = useCallback(async (handPoints: number, isEuchre: boolean) => {
    const rec = recording.current;
    if (!rec.gameId) return;

    const handRecord: HandRecord = {
      deal: rec.deal,
      bids: rec.bids,
      plays: rec.plays,
      result: {
        tricks: game.tricksWon,
        points: handPoints,
        isEuchre,
        isSweep: game.tricksWon[0] === 5 || game.tricksWon[1] === 5,
      },
    };

    const analysisRecord: HandAnalysisRecord = {
      decisions: game.decisions.map((d, i): DecisionRecord => ({
        trickNumber: i + 1,
        played: { suit: d.played.suit, rank: d.played.rank },
        optimal: { suit: d.optimal.suit, rank: d.optimal.rank },
        wpc: d.wpc,
        etd: d.etd,
        grade: d.grade,
      })),
      totalWpc: game.totalWpc,
      totalEtd: game.totalEtd,
    };

    const existing = await db.games.get(rec.gameId);
    if (existing) {
      await db.games.update(rec.gameId, {
        hands: [...existing.hands, handRecord],
        analysis: [...(existing.analysis || []), analysisRecord],
        finalScore: game.scores,
      });
    }
  }, [game.tricksWon, game.decisions, game.totalWpc, game.totalEtd, game.scores]);

  const handleDealingComplete = useCallback(async () => {
    await processAiTurns();
  }, [processAiTurns]);

  const handlePlayCard = useCallback(async (card: CardData) => {
    // Guard: prevent concurrent plays (double-click or stuck thinking)
    if (busyRef.current) return;
    busyRef.current = true;
    setThinking(true);

    try {
      const engine = getEngine();

      // Run PIMC evaluation before playing (20 determinizations for interactive play)
      // Skip when only 1 legal play (nothing to analyze, avoids unnecessary WASM work)
      let pimcResult: any = null;
      const currentLegal = await engine.getLegalPlays() as CardData[];
      if (currentLegal.length > 1) {
        const seed = Math.floor(Math.random() * 2 ** 32);
        try {
          pimcResult = await engine.evaluatePlays(20, seed);
        } catch (pimcErr) {
          console.warn('PIMC evaluation failed:', pimcErr);
          // A WASM panic (unreachable) corrupts the engine instance permanently.
          // Any subsequent calls would return garbage or crash.
          const msg = pimcErr instanceof Error ? pimcErr.message : String(pimcErr);
          if (msg.includes('unreachable') || msg.includes('abort')) {
            setEngineError('Engine crashed during analysis — start a new game to recover.');
            return;
          }
          // Non-WASM error (e.g. serialization) — safe to continue without analysis
        }
      }

      // Record and play human card
      recordPlay(HUMAN_SEAT, card);
      await engine.playCard(card);

      // Analyze the decision (skip if PIMC failed)
      if (pimcResult) {
        const analysis = await engine.analyzeDecision(pimcResult, card) as any;
        const newDecision: Decision = {
          played: analysis.played,
          optimal: analysis.optimal,
          wpc: analysis.wpc,
          etd: analysis.etd,
          grade: analysis.grade,
        };

        dispatch({
          type: 'SET_STATE',
          payload: {
            decisions: [...game.decisions, newDecision],
            totalWpc: game.totalWpc + analysis.wpc,
            totalEtd: game.totalEtd + analysis.etd,
          },
        });
      }

      const { gamePhase } = await processAiTurns();

      if (gamePhase === 'scoring') {
        const result = await engine.scoreHand() as [number, boolean, boolean];
        const makerSeat = await engine.maker();
        const makerIsUs = makerSeat % 2 === 0; // seats 0,2 = team 0 (us)
        const makerPoints = result[0];
        // Convert from maker's perspective to human's (team 0) perspective
        const handPoints = makerIsUs ? makerPoints : -makerPoints;
        const isEuchre = result[1];
        await saveHand(handPoints, isEuchre);
        const newHandsPlayed = game.handsPlayed + 1;
        const updatedScores = await engine.scores() as [number, number];
        const trumpSuit = await engine.trump();
        const tricksWon = await engine.tricksWon() as [number, number];

        // Analyze the human's bidding decision
        const humanBids = recording.current.bids.filter(b => b.seat === HUMAN_SEAT);
        const bidAn = analyzeBid(
          recording.current.deal[HUMAN_SEAT] || [],
          humanBids,
          trumpSuit,
          game.upcard,
          makerSeat,
          HUMAN_SEAT,
          tricksWon,
          isEuchre,
        );

        if (updatedScores[0] >= 10 || updatedScores[1] >= 10) {
          dispatch({
            type: 'SET_STATE',
            payload: { phase: 'gameover', handPoints, handsPlayed: newHandsPlayed, scores: updatedScores, bidAnalysis: bidAn },
          });
        } else {
          dispatch({
            type: 'SET_STATE',
            payload: { phase: 'summary', handPoints, handsPlayed: newHandsPlayed, scores: updatedScores, bidAnalysis: bidAn },
          });
        }
      }
    } catch (err) {
      console.error('Error during play:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unreachable') || msg.includes('recursive use') || msg.includes('unsafe aliasing')) {
        setEngineError('Engine crashed — the hand cannot continue. Start a new game to recover.');
      }
    } finally {
      setThinking(false);
      busyRef.current = false;
    }
  }, [processAiTurns, setThinking, recordPlay, saveHand, game.decisions, game.totalWpc, game.totalEtd, game.handsPlayed]);

  const handleBid = useCallback(async (bidVal: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setThinking(true);

    try {
      const engine = getEngine();
      recordBid(HUMAN_SEAT, bidVal);

      // Add human bid to visible bid log
      bidLogRef.current = [...bidLogRef.current, { seat: HUMAN_SEAT, label: bidLabel(bidVal) }];
      dispatch({ type: 'SET_STATE', payload: { bidLog: [...bidLogRef.current] } });

      await engine.applyBid(bidVal);
      await processAiTurns();
    } catch (err) {
      console.error('Error during bid:', err);
    } finally {
      setThinking(false);
      busyRef.current = false;
    }
  }, [processAiTurns, setThinking, recordBid]);

  const handleDiscard = useCallback(async (card: CardData) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setThinking(true);

    try {
      const engine = getEngine();
      await engine.dealerDiscard(card);
      await processAiTurns();
    } catch (err) {
      console.error('Error during discard:', err);
    } finally {
      setThinking(false);
      busyRef.current = false;
    }
  }, [processAiTurns, setThinking]);

  const handleContinue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

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
      dispatch({ type: 'SET_STATE', payload: { decisions: [], totalWpc: 0, totalEtd: 0, bidLog: [], bidAnalysis: null } });
      await startRecording(seed);
      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing' } });
    } catch (err) {
      console.error('Error during continue:', err);
    } finally {
      busyRef.current = false;
    }
  }, [game.dealer, game.scores, difficulty, syncState, startRecording]);

  const handleNewGame = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      const engine = getEngine();
      const seed = Math.floor(Math.random() * 2 ** 32);
      await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });

      const gameId = await db.games.add({
        createdAt: new Date(),
        seed,
        difficulty,
        hands: [],
        finalScore: [0, 0],
        analysis: [],
      });

      dispatch({ type: 'RESET' });
      bidLogRef.current = [];
      await startRecording(seed);
      recording.current.gameId = gameId ?? null;
      await syncState();
      dispatch({ type: 'SET_STATE', payload: { phase: 'dealing', bidLog: [] } });
    } catch (err) {
      console.error('Error during new game:', err);
    } finally {
      busyRef.current = false;
    }
  }, [difficulty, syncState, startRecording]);

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
        <button onClick={() => {
          setEngineError(null);
          handleNewGame();
        }}>New Game</button>
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
        <DiscardPanel onDiscard={handleDiscard} />
      )}

      {(game.phase === 'bidding1' || game.phase === 'bidding2') && game.nextSeat === HUMAN_SEAT && (
        <BiddingPanel
          phase={game.phase === 'bidding1' ? 'round1' : 'round2'}
          upcard={game.upcard}
          isDealer={game.nextSeat === game.dealer}
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
          totalWpc={game.totalWpc}
          handsPlayed={game.handsPlayed}
          gameId={recording.current.gameId}
          onNewGame={handleNewGame}
        />
      )}
    </div>
  );
}
