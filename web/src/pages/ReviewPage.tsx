import { useEffect, useReducer, useState } from 'react';
import { useParams } from 'wouter';
import { getGame } from '../db/api';
import type { GameRecord, CardRecord, DecisionRecord } from '../db/schema';
import CardComponent from '../components/cards/Card';
import './ReviewPage.css';

const SUIT_SYMBOLS: Record<number, string> = { 0: '♥', 1: '♦', 2: '♣', 3: '♠' };
const RANK_LABELS: Record<number, string> = { 0: '9', 1: '10', 2: 'J', 3: 'Q', 4: 'K', 5: 'A' };

const GRADE_COLORS: Record<string, string> = {
  best: '#27ae60',
  good: '#27ae60',
  inaccuracy: '#f39c12',
  mistake: '#e67e22',
  blunder: '#e74c3c',
};

function formatCard(c: CardRecord): string {
  return `${RANK_LABELS[c.rank]}${SUIT_SYMBOLS[c.suit]}`;
}

// --- Review state machine ---

interface ReviewState {
  handIndex: number;
  playIndex: number; // which play within the hand we're viewing (0 = before first play)
}

type ReviewAction =
  | { type: 'GO_TO_START' }
  | { type: 'GO_BACK' }
  | { type: 'GO_FORWARD' }
  | { type: 'GO_TO_END' }
  | { type: 'JUMP_TO'; handIndex: number; playIndex: number };

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  // Bounds will be enforced externally since reducer doesn't know total plays
  switch (action.type) {
    case 'GO_TO_START':
      return { handIndex: 0, playIndex: 0 };
    case 'GO_BACK':
      if (state.playIndex > 0) return { ...state, playIndex: state.playIndex - 1 };
      if (state.handIndex > 0) return { handIndex: state.handIndex - 1, playIndex: -1 }; // -1 = end of prev hand
      return state;
    case 'GO_FORWARD':
      return { ...state, playIndex: state.playIndex + 1 }; // clamped externally
    case 'GO_TO_END':
      return { ...state, playIndex: Infinity }; // clamped externally
    case 'JUMP_TO':
      return { handIndex: action.handIndex, playIndex: action.playIndex };
    default:
      return state;
  }
}

export default function ReviewPage() {
  const params = useParams<{ gameId: string }>();
  const gameId = Number(params.gameId);

  const [game, setGame] = useState<GameRecord | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGame(gameId)
      .then((g) => {
        if (cancelled) return;
        setGame(g);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load game');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [gameId, reloadKey]);

  const [nav, dispatch] = useReducer(reviewReducer, { handIndex: 0, playIndex: 0 });

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      switch (e.key) {
        case 'ArrowLeft': dispatch({ type: 'GO_BACK' }); break;
        case 'ArrowRight': dispatch({ type: 'GO_FORWARD' }); break;
        case 'Home': dispatch({ type: 'GO_TO_START' }); break;
        case 'End': dispatch({ type: 'GO_TO_END' }); break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error) {
    return (
      <div className="review-page">
        <p>Could not load game: {error}</p>
        <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
      </div>
    );
  }

  if (loading) {
    return <div className="loading"><p>Loading game...</p></div>;
  }

  if (!game) {
    return <div className="review-page"><p>Game not found.</p></div>;
  }

  if (game.hands.length === 0) {
    return <div className="review-page"><p>No hands recorded in this game.</p></div>;
  }

  const hand = game.hands[Math.min(nav.handIndex, game.hands.length - 1)];
  const totalPlays = hand.plays.length;
  const playIndex = Math.max(0, Math.min(nav.playIndex === -1 ? totalPlays : nav.playIndex, totalPlays));

  // Reconstruct visible state: deal + plays up to playIndex
  const visiblePlays = hand.plays.slice(0, playIndex);

  // Build hands remaining at this point
  const currentHands = hand.deal.map((cards) => [...cards]);
  for (const play of visiblePlays) {
    const seatHand = currentHands[play.seat];
    const idx = seatHand.findIndex((c) => c.suit === play.card.suit && c.rank === play.card.rank);
    if (idx >= 0) seatHand.splice(idx, 1);
  }

  // Current trick: plays since last complete trick (3 per trick when alone)
  const playsPerTrick = hand.alone ? 3 : 4;
  const completeTricks = Math.floor(visiblePlays.length / playsPerTrick);
  const trickStart = completeTricks * playsPerTrick;
  const currentTrickPlays = visiblePlays.slice(trickStart);

  // Find the analysis for the play we just stepped past. Decisions exist only
  // for human plays with >1 legal option, so match by recorded playIndex.
  // Old records without playIndex simply never match (panel stays hidden).
  const analysis = game.analysis?.[nav.handIndex];
  const currentDecision = analysis?.decisions.find(
    (d) => d.playIndex != null && d.playIndex === playIndex - 1
  );

  return (
    <div className="review-page">
      <div className="review-header">
        <h2>Game #{gameId} — Hand {nav.handIndex + 1}/{game.hands.length}</h2>
        <div className="review-score">
          Final: {game.finalScore[0]} - {game.finalScore[1]}
          {analysis && (
            <span className="review-wpc">
              {' '}| Win% Lost: {(analysis.totalWpc * 100).toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* Mini table showing current state */}
      <div className="review-table">
        <div className="review-hands">
          {currentHands.map((cards, seat) => (
            <div key={seat} className={`review-hand review-hand-${seat}`}>
              <div className="review-hand-label">
                {seat === 0 ? 'You' : seat === 2 ? 'Partner' : `Opp ${seat === 1 ? 'L' : 'R'}`}
              </div>
              <div className="review-hand-cards">
                {cards.map((card, i) => (
                  <CardComponent key={i} card={card} size="sm" />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="review-trick">
          {currentTrickPlays.map((play, i) => (
            <div key={i} className="review-trick-card">
              <CardComponent card={play.card} size="sm" />
              <span className="review-trick-seat">S{play.seat}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Decision analysis */}
      {currentDecision && (
        <DecisionPanel decision={currentDecision} />
      )}

      {/* Navigation controls */}
      <div className="review-nav">
        <button onClick={() => dispatch({ type: 'GO_TO_START' })} title="Home">|◀</button>
        <button onClick={() => dispatch({ type: 'GO_BACK' })} title="←">◀</button>
        <span className="review-nav-pos">
          Play {playIndex}/{totalPlays}
          {' '}(Trick {completeTricks + 1})
        </span>
        <button onClick={() => dispatch({ type: 'GO_FORWARD' })} title="→">▶</button>
        <button onClick={() => dispatch({ type: 'GO_TO_END' })} title="End">▶|</button>
      </div>

      {/* Hand selector */}
      {game.hands.length > 1 && (
        <div className="review-hand-selector">
          {game.hands.map((_, i) => (
            <button
              key={i}
              className={i === nav.handIndex ? 'active' : ''}
              onClick={() => dispatch({ type: 'JUMP_TO', handIndex: i, playIndex: 0 })}
            >
              Hand {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* All decisions summary */}
      {analysis && analysis.decisions.length > 0 && (
        <div className="review-decisions-list">
          <h3>Decisions</h3>
          {analysis.decisions.map((d, i) => (
            <div
              key={i}
              className={`review-decision-row ${d.playIndex != null && d.playIndex === playIndex - 1 ? 'active' : ''}`}
              onClick={() => {
                if (d.playIndex != null) {
                  dispatch({ type: 'JUMP_TO', handIndex: nav.handIndex, playIndex: d.playIndex + 1 });
                }
              }}
            >
              <span
                className="review-grade-badge"
                style={{ background: GRADE_COLORS[d.grade] || '#666' }}
              >
                {d.grade}
              </span>
              <span>
                {formatCard(d.played)}
                {d.grade !== 'best' && d.grade !== 'good' && (
                  <span className="review-optimal"> → {formatCard(d.optimal)}</span>
                )}
              </span>
              <span className="review-wpc-val">
                {d.wpc > 0 ? `-${(d.wpc * 100).toFixed(1)}%` : '✓'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionPanel({ decision }: { decision: DecisionRecord }) {
  return (
    <div className="decision-panel">
      <div className="decision-header">
        <span
          className="decision-grade"
          style={{ background: GRADE_COLORS[decision.grade] || '#666' }}
        >
          {decision.grade}
        </span>
        <span>
          Played {formatCard(decision.played)}
          {decision.grade !== 'best' && decision.grade !== 'good' && (
            <> — Better: {formatCard(decision.optimal)}</>
          )}
        </span>
      </div>
      <div className="decision-stats">
        <span>WPC: -{(decision.wpc * 100).toFixed(1)}%</span>
        <span>ETD: {decision.etd > 0 ? '-' : ''}{Math.abs(decision.etd).toFixed(2)} tricks</span>
      </div>
    </div>
  );
}
