import { useState } from 'react';
import { motion } from 'motion/react';
import CardComponent, { type CardData } from './cards/Card';

const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const SUIT_SYMBOLS = ['♥', '♦', '♣', '♠'];
const SUIT_COLORS = ['#e74c3c', '#e74c3c', '#2c3e50', '#2c3e50'];

interface BiddingPanelProps {
  phase: 'round1' | 'round2';
  upcard: CardData | null;
  isDealer: boolean;
  onBid: (action: number) => void;
}

export default function BiddingPanel({ phase, upcard, isDealer, onBid }: BiddingPanelProps) {
  const upcardSuit = upcard?.suit ?? 0;
  const [goAlone, setGoAlone] = useState(false);

  return (
    <motion.div
      className="bidding-panel"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'rgba(0, 0, 0, 0.8)',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 320,
        margin: '12px auto',
      }}
    >
      {/* Upcard display */}
      {phase === 'round1' && upcard && (
        <div style={{ textAlign: 'center' }}>
          <CardComponent card={upcard} size="md" />
        </div>
      )}

      <div style={{ color: '#e0e0e0', fontSize: '0.85rem', textAlign: 'center' }}>
        {phase === 'round1'
          ? `Order up ${SUIT_SYMBOLS[upcardSuit]} ${SUIT_NAMES[upcardSuit]}?`
          : 'Name trump suit'}
      </div>

      {/* Go Alone toggle for Round 2 */}
      {phase === 'round2' && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            cursor: 'pointer',
            color: goAlone ? '#f1c40f' : '#999',
            fontSize: '0.8rem',
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={goAlone}
            onChange={(e) => setGoAlone(e.target.checked)}
            style={{ accentColor: '#f1c40f' }}
          />
          Go Alone
        </label>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {phase === 'round1' ? (
          <>
            <BidButton label="Order Up" onClick={() => onBid(1)} color="#27ae60" />
            <BidButton label="Go Alone" onClick={() => onBid(6)} color="#f1c40f" textColor="#000" />
            <BidButton label="Pass" onClick={() => onBid(0)} color="#7f8c8d" />
          </>
        ) : (
          <>
            {[0, 1, 2, 3].map((suit) =>
              suit !== upcardSuit ? (
                <BidButton
                  key={suit}
                  label={`${SUIT_SYMBOLS[suit]} ${SUIT_NAMES[suit]}`}
                  onClick={() => onBid(goAlone ? 7 + suit : 2 + suit)}
                  color={SUIT_COLORS[suit]}
                />
              ) : null,
            )}
            {!isDealer && (
              <BidButton label="Pass" onClick={() => onBid(0)} color="#7f8c8d" />
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}

function BidButton({ label, onClick, color, textColor = '#fff' }: {
  label: string;
  onClick: () => void;
  color: string;
  textColor?: string;
}) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      style={{
        background: color,
        color: textColor,
        border: 'none',
        borderRadius: 6,
        padding: '8px 16px',
        fontSize: '0.85rem',
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </motion.button>
  );
}
