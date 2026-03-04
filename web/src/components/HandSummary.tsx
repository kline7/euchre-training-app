import { motion } from 'motion/react';
import type { CardData } from './cards/Card';

const SUIT_SYMBOLS: Record<number, string> = { 0: '♥', 1: '♦', 2: '♣', 3: '♠' };
const RANK_LABELS: Record<number, string> = { 0: '9', 1: '10', 2: 'J', 3: 'Q', 4: 'K', 5: 'A' };

const GRADE_COLORS: Record<string, string> = {
  best: '#27ae60',
  good: '#27ae60',
  inaccuracy: '#f39c12',
  mistake: '#e67e22',
  blunder: '#e74c3c',
};

interface Decision {
  played: CardData;
  optimal: CardData;
  wpc: number;
  etd: number;
  grade: string;
}

interface HandSummaryProps {
  decisions: Decision[];
  totalWpc: number;
  totalEtd: number;
  tricksWon: [number, number];
  handPoints: number;
  onContinue: () => void;
}

function formatCard(card: CardData): string {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[card.suit]}`;
}

export default function HandSummary({
  decisions,
  totalWpc,
  totalEtd,
  tricksWon,
  handPoints,
  onContinue,
}: HandSummaryProps) {
  const errors = decisions.filter((d) => d.grade !== 'best' && d.grade !== 'good');
  const topErrors = errors
    .sort((a, b) => b.wpc - a.wpc)
    .slice(0, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'rgba(0, 0, 0, 0.85)',
        borderRadius: 12,
        padding: '16px 20px',
        maxWidth: 420,
        margin: '16px auto',
        color: '#e0e0e0',
      }}
    >
      <h3 style={{ margin: '0 0 12px', textAlign: 'center' }}>Hand Summary</h3>

      <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{tricksWon[0]} - {tricksWon[1]}</div>
          <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Tricks</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: handPoints > 0 ? '#27ae60' : '#e74c3c' }}>
            {handPoints > 0 ? '+' : ''}{handPoints}
          </div>
          <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Points</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: totalWpc > 0.1 ? '#e74c3c' : '#27ae60' }}>
            {(totalWpc * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Win% Lost</div>
        </div>
      </div>

      {topErrors.length > 0 ? (
        <div>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 6 }}>Top Errors:</div>
          {topErrors.map((d, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                borderBottom: '1px solid #333',
                fontSize: '0.8rem',
              }}
            >
              <span
                style={{
                  background: GRADE_COLORS[d.grade],
                  color: '#fff',
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                {d.grade}
              </span>
              <span>
                Played {formatCard(d.played)} instead of {formatCard(d.optimal)}
              </span>
              <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                -{(d.wpc * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ textAlign: 'center', color: '#27ae60', fontSize: '0.9rem' }}>
          Perfect play! No errors detected.
        </div>
      )}

      <motion.button
        onClick={onContinue}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        style={{
          width: '100%',
          marginTop: 12,
          padding: '8px',
          background: '#2e86c1',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: '0.85rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Continue
      </motion.button>
    </motion.div>
  );
}
