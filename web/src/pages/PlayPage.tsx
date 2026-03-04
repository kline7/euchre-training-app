import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useUI, useSettings } from '../stores/store';
import { getEngine } from '../engine/bridge';
import { db } from '../db/schema';
import type { HandRecord, BidRecord, DecisionRecord, HandAnalysisRecord } from '../db/schema';
import GameTable from '../components/GameTable';
import BiddingPanel from '../components/BiddingPanel';
import HandSummary from '../components/HandSummary';
import type { CardData } from '../components/cards/Card';

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

type GamePhase = 'loading' | 'bidding1' | 'bidding2' | 'playing' | 'scoring' | 'summary';

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
  upcardSuit: number;
  handPoints: number;
  decisions: Decision[];
  totalWpc: number;
  totalEtd: number;
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
  phase: 'loading',
  hands: [[], [], [], []],
  currentTrick: [],
  legalPlays: [],
  trumpSuit: 0,
  dealer: 0,
  tricksWon: [0, 0],
  scores: [0, 0],
  trickNumber: 1,
  nextSeat: 0,
  upcardSuit: 0,
  handPoints: 0,
  decisions: [],
  totalWpc: 0,
  totalEtd: 0,
};

const HUMAN_SEAT = 0;

export default function PlayPage() {
  const engineReady = useUI((s) => s.engineReady);
  const setEngineReady = useUI((s) => s.setEngineReady);
  const thinking = useUI((s) => s.thinking);
  const setThinking = useUI((s) => s.setThinking);
  const difficulty = useSettings((s) => s.difficulty);

  const [game, dispatch] = useReducer(gameReducer, initialState);

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

    let gamePhase: GamePhase;
    switch (phase) {
      case 1: gamePhase = 'bidding1'; break;
      case 2: gamePhase = 'bidding2'; break;
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
        upcardSuit: upcard.suit,
      },
    });

    return { gamePhase, nextSeat };
  }, []);

  // Process AI turns (bidding or playing) until it's the human's turn
  const processAiTurns = useCallback(async () => {
    const engine = getEngine();
    let { gamePhase, nextSeat } = await syncState();

    // AI bidding loop
    while ((gamePhase === 'bidding1' || gamePhase === 'bidding2') && nextSeat !== HUMAN_SEAT) {
      await new Promise((r) => setTimeout(r, 400));
      const aiBid = await engine.getAiBid();
      recordBid(nextSeat, aiBid);
      await engine.applyBid(aiBid);
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI playing loop (if AI leads after bidding resolves)
    while (gamePhase === 'playing' && nextSeat !== HUMAN_SEAT) {
      await new Promise((r) => setTimeout(r, 300));
      const aiCard = await engine.getAiPlay() as CardData;
      recordPlay(nextSeat, aiCard);
      await engine.playCard(aiCard);
      ({ gamePhase, nextSeat } = await syncState());
    }

    return { gamePhase, nextSeat };
  }, [syncState, recordBid, recordPlay]);

  // Initialize engine on mount
  useEffect(() => {
    async function init() {
      try {
        const engine = getEngine();
        const seed = Math.floor(Math.random() * 2 ** 32);
        await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });

        // Create game record in Dexie
        const gameId = await db.games.add({
          createdAt: new Date(),
          seed,
          difficulty,
          hands: [],
          finalScore: [0, 0],
          analysis: [],
        });
        await startRecording(seed);
        recording.current.gameId = gameId;

        setEngineReady(true);
        await processAiTurns();
      } catch (err) {
        console.error('Engine init failed:', err);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveHand = useCallback(async (handPoints: number) => {
    const rec = recording.current;
    if (!rec.gameId) return;

    const handRecord: HandRecord = {
      deal: rec.deal,
      bids: rec.bids,
      plays: rec.plays,
      result: {
        tricks: game.tricksWon,
        points: handPoints,
        isEuchre: handPoints < 0,
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

  const handlePlayCard = useCallback(async (card: CardData) => {
    const engine = getEngine();
    setThinking(true);

    // Run PIMC evaluation before playing (100 determinizations for training)
    const seed = Math.floor(Math.random() * 2 ** 32);
    const pimcResult = await engine.evaluatePlays(100, seed);

    // Record and play human card
    recordPlay(HUMAN_SEAT, card);
    await engine.playCard(card);

    // Analyze the decision
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

    const { gamePhase } = await processAiTurns();

    setThinking(false);

    if (gamePhase === 'scoring') {
      const result = await engine.scoreHand();
      const handPoints = (result as any)[0];
      await saveHand(handPoints);
      dispatch({
        type: 'SET_STATE',
        payload: { phase: 'summary', handPoints },
      });
    }
  }, [processAiTurns, setThinking, recordPlay, saveHand, game.decisions, game.totalWpc, game.totalEtd]);

  const handleBid = useCallback(async (bidVal: number) => {
    const engine = getEngine();
    setThinking(true);

    recordBid(HUMAN_SEAT, bidVal);
    await engine.applyBid(bidVal);
    await processAiTurns();

    setThinking(false);
  }, [processAiTurns, setThinking, recordBid]);

  const handleContinue = useCallback(async () => {
    const engine = getEngine();
    const seed = Math.floor(Math.random() * 2 ** 32);
    const newDealer = (game.dealer + 1) % 4;
    await engine.init({
      seed,
      difficulty,
      dealer: newDealer,
      scores: game.scores,
    });
    dispatch({ type: 'SET_STATE', payload: { decisions: [], totalWpc: 0, totalEtd: 0 } });
    await startRecording(seed);
    await processAiTurns();
  }, [game.dealer, game.scores, difficulty, processAiTurns, startRecording]);

  if (!engineReady) {
    return (
      <div className="loading">
        <p>Loading engine...</p>
      </div>
    );
  }

  return (
    <div className="play-page">
      <GameTable
        hands={game.hands}
        currentTrick={game.currentTrick}
        legalPlays={game.legalPlays}
        trumpSuit={game.trumpSuit}
        dealer={game.dealer}
        tricksWon={game.tricksWon}
        scores={game.scores}
        trickNumber={game.trickNumber}
        humanSeat={HUMAN_SEAT}
        onPlayCard={handlePlayCard}
        thinking={thinking}
      />

      {(game.phase === 'bidding1' || game.phase === 'bidding2') && game.nextSeat === HUMAN_SEAT && (
        <BiddingPanel
          phase={game.phase === 'bidding1' ? 'round1' : 'round2'}
          upcardSuit={game.upcardSuit}
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
          onContinue={handleContinue}
        />
      )}
    </div>
  );
}
