import { useCallback, useEffect, useReducer } from 'react';
import { useUI, useSettings } from '../stores/store';
import { getEngine } from '../engine/bridge';
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

  // Process AI turns (bidding or playing) until it's the human's turn
  const processAiTurns = useCallback(async () => {
    const engine = getEngine();
    let { gamePhase, nextSeat } = await syncState();

    // AI bidding loop
    while ((gamePhase === 'bidding1' || gamePhase === 'bidding2') && nextSeat !== HUMAN_SEAT) {
      await new Promise((r) => setTimeout(r, 400));
      const aiBid = await engine.getAiBid();
      await engine.applyBid(aiBid);
      ({ gamePhase, nextSeat } = await syncState());
    }

    // AI playing loop (if AI leads after bidding resolves)
    while (gamePhase === 'playing' && nextSeat !== HUMAN_SEAT) {
      await new Promise((r) => setTimeout(r, 300));
      const aiCard = await engine.getAiPlay();
      await engine.playCard(aiCard);
      ({ gamePhase, nextSeat } = await syncState());
    }

    return { gamePhase, nextSeat };
  }, [syncState]);

  // Initialize engine on mount
  useEffect(() => {
    async function init() {
      try {
        const engine = getEngine();
        const seed = Math.floor(Math.random() * 2 ** 32);
        await engine.init({ seed, difficulty, dealer: 0, scores: [0, 0] });
        setEngineReady(true);
        await processAiTurns();
      } catch (err) {
        console.error('Engine init failed:', err);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handlePlayCard = useCallback(async (card: CardData) => {
    const engine = getEngine();
    setThinking(true);

    await engine.playCard(card);
    const { gamePhase } = await processAiTurns();

    setThinking(false);

    if (gamePhase === 'scoring') {
      const result = await engine.scoreHand();
      dispatch({
        type: 'SET_STATE',
        payload: { phase: 'summary', handPoints: (result as any)[0] },
      });
    }
  }, [processAiTurns, setThinking]);

  const handleBid = useCallback(async (bidVal: number) => {
    const engine = getEngine();
    setThinking(true);

    await engine.applyBid(bidVal);
    await processAiTurns();

    setThinking(false);
  }, [processAiTurns, setThinking]);

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
    await processAiTurns();
  }, [game.dealer, game.scores, difficulty, processAiTurns]);

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
