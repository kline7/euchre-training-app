import { type CardData } from './cards/Card';
import CardComponent from './cards/Card';
import { AnimatePresence, motion } from 'motion/react';
import './GameTable.css';

const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];

interface TrickCard {
  seat: number;
  card: CardData;
}

interface GameTableProps {
  hands: CardData[][];         // 4 hands
  currentTrick: TrickCard[];   // cards played in current trick
  legalPlays: CardData[];      // cards the human can play
  trumpSuit: number;
  dealer: number;
  tricksWon: [number, number];
  scores: [number, number];
  trickNumber: number;
  humanSeat: number;           // which seat is the human (0)
  onPlayCard: (card: CardData) => void;
  thinking: boolean;
}

function isCardPlayable(card: CardData, legalPlays: CardData[]): boolean {
  return legalPlays.some((lp) => lp.suit === card.suit && lp.rank === card.rank);
}

// Map seat to position relative to human (always at bottom)
function seatPosition(seat: number, humanSeat: number): 'bottom' | 'left' | 'top' | 'right' {
  const relative = (seat - humanSeat + 4) % 4;
  return (['bottom', 'left', 'top', 'right'] as const)[relative];
}

const TRICK_OFFSETS: Record<string, { x: number; y: number }> = {
  bottom: { x: 0, y: 40 },
  left: { x: -60, y: 0 },
  top: { x: 0, y: -40 },
  right: { x: 60, y: 0 },
};

export default function GameTable({
  hands,
  currentTrick,
  legalPlays,
  trumpSuit,
  dealer,
  tricksWon,
  scores,
  trickNumber,
  humanSeat,
  onPlayCard,
  thinking,
}: GameTableProps) {
  return (
    <div className="game-table">
      {/* Score display */}
      <div className="score-panel">
        <div className="score-row">
          <span>Us: {scores[0]}</span>
          <span>Them: {scores[1]}</span>
        </div>
        <div className="tricks-row">
          Tricks: {tricksWon[0]} - {tricksWon[1]} | Hand {trickNumber}/5
        </div>
        <div className="trump-row">
          Trump: <span style={{ color: trumpSuit < 2 ? '#e74c3c' : '#2c3e50' }}>
            {SUIT_NAMES[trumpSuit]}
          </span>
        </div>
      </div>

      {/* Dealer marker */}
      <div className={`dealer-marker dealer-${seatPosition(dealer, humanSeat)}`}>D</div>

      {/* Trick area (center) */}
      <div className="trick-area">
        <AnimatePresence>
          {currentTrick.map((tc) => {
            const pos = seatPosition(tc.seat, humanSeat);
            const offset = TRICK_OFFSETS[pos];
            return (
              <motion.div
                key={`${tc.card.suit}-${tc.card.rank}`}
                className={`trick-card trick-${pos}`}
                initial={{ scale: 0.5, opacity: 0, x: offset.x * 2, y: offset.y * 2 }}
                animate={{ scale: 1, opacity: 1, x: offset.x, y: offset.y }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              >
                <CardComponent card={tc.card} size="sm" />
              </motion.div>
            );
          })}
        </AnimatePresence>
        {thinking && <div className="thinking-indicator">Thinking...</div>}
      </div>

      {/* Player hands */}
      {[0, 1, 2, 3].map((seat) => {
        const pos = seatPosition(seat, humanSeat);
        const isHuman = seat === humanSeat;
        const hand = hands[seat] || [];

        return (
          <div key={seat} className={`hand hand-${pos}`}>
            <div className="hand-cards">
              {hand.map((card, i) => (
                <motion.div
                  key={`${card.suit}-${card.rank}`}
                  className="hand-card-wrapper"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  style={{
                    marginLeft: i > 0 ? (pos === 'bottom' ? -16 : -28) : 0,
                  }}
                >
                  <CardComponent
                    card={card}
                    faceUp={isHuman}
                    playable={isHuman && isCardPlayable(card, legalPlays)}
                    onClick={() => onPlayCard(card)}
                    size={pos === 'bottom' ? 'md' : 'sm'}
                  />
                </motion.div>
              ))}
            </div>
            <div className="hand-label">
              {pos === 'bottom' ? 'You' : pos === 'top' ? 'Partner' : `Opponent ${pos === 'left' ? 'L' : 'R'}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}
