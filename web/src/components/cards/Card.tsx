import { memo } from 'react';
import { motion } from 'motion/react';

const SUIT_SYMBOLS: Record<number, string> = {
  0: '♥', // Hearts
  1: '♦', // Diamonds
  2: '♣', // Clubs
  3: '♠', // Spades
};

const SUIT_COLORS: Record<number, string> = {
  0: '#e74c3c',
  1: '#e74c3c',
  2: '#2c3e50',
  3: '#2c3e50',
};

const RANK_LABELS: Record<number, string> = {
  0: '9',
  1: '10',
  2: 'J',
  3: 'Q',
  4: 'K',
  5: 'A',
};

export interface CardData {
  suit: number;
  rank: number;
}

interface CardProps {
  card: CardData;
  faceUp?: boolean;
  selected?: boolean;
  playable?: boolean;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: { width: 48, height: 72, fontSize: 12 },
  md: { width: 64, height: 96, fontSize: 16 },
  lg: { width: 80, height: 120, fontSize: 20 },
};

function CardComponent({ card, faceUp = true, selected = false, playable = false, onClick, size = 'md' }: CardProps) {
  const dim = SIZES[size];
  const color = SUIT_COLORS[card.suit];
  const symbol = SUIT_SYMBOLS[card.suit];
  const rank = RANK_LABELS[card.rank];

  if (!faceUp) {
    return (
      <motion.div
        className="card card-back"
        style={{
          width: dim.width,
          height: dim.height,
          borderRadius: 6,
          background: 'linear-gradient(135deg, #1a5276, #2e86c1)',
          border: '2px solid #154360',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: dim.fontSize * 1.5, color: '#d4e6f1' }}>♠</span>
      </motion.div>
    );
  }

  return (
    <motion.div
      className={`card ${playable ? 'card-playable' : ''} ${selected ? 'card-selected' : ''}`}
      onClick={playable ? onClick : undefined}
      style={{
        width: dim.width,
        height: dim.height,
        borderRadius: 6,
        background: '#fff',
        border: `2px solid ${selected ? '#f39c12' : playable ? '#27ae60' : '#bbb'}`,
        cursor: playable ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 4,
        boxShadow: selected ? '0 0 8px rgba(243, 156, 18, 0.6)' : '0 1px 3px rgba(0,0,0,0.2)',
        userSelect: 'none',
      }}
      whileHover={playable ? { y: -8, transition: { duration: 0.15 } } : undefined}
      whileTap={playable ? { scale: 0.95 } : undefined}
    >
      <div style={{ color, fontSize: dim.fontSize, fontWeight: 700, lineHeight: 1 }}>
        {rank}
        <span style={{ fontSize: dim.fontSize * 0.8 }}>{symbol}</span>
      </div>
      <div style={{ color, fontSize: dim.fontSize * 1.8, textAlign: 'center', lineHeight: 1 }}>
        {symbol}
      </div>
      <div style={{ color, fontSize: dim.fontSize, fontWeight: 700, lineHeight: 1, textAlign: 'right', transform: 'rotate(180deg)' }}>
        {rank}
        <span style={{ fontSize: dim.fontSize * 0.8 }}>{symbol}</span>
      </div>
    </motion.div>
  );
}

export default memo(CardComponent);
