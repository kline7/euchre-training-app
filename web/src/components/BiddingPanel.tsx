import { motion } from 'motion/react';

const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const SUIT_SYMBOLS = ['♥', '♦', '♣', '♠'];
const SUIT_COLORS = ['#e74c3c', '#e74c3c', '#2c3e50', '#2c3e50'];

interface BiddingPanelProps {
  phase: 'round1' | 'round2';
  upcardSuit: number;
  isDealer: boolean;
  onBid: (action: number) => void;
}

export default function BiddingPanel({ phase, upcardSuit, isDealer, onBid }: BiddingPanelProps) {
  return (
    <motion.div
      className="bidding-panel"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'rgba(0, 0, 0, 0.7)',
        borderRadius: 8,
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 300,
        margin: '12px auto',
      }}
    >
      <div style={{ color: '#e0e0e0', fontSize: '0.85rem', textAlign: 'center' }}>
        {phase === 'round1'
          ? `Order up ${SUIT_SYMBOLS[upcardSuit]} ${SUIT_NAMES[upcardSuit]}?`
          : 'Name trump suit'}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {phase === 'round1' ? (
          <>
            <BidButton label="Order Up" onClick={() => onBid(1)} color="#27ae60" />
            <BidButton label="Pass" onClick={() => onBid(0)} color="#7f8c8d" />
          </>
        ) : (
          <>
            {[0, 1, 2, 3].map((suit) =>
              suit !== upcardSuit ? (
                <BidButton
                  key={suit}
                  label={`${SUIT_SYMBOLS[suit]} ${SUIT_NAMES[suit]}`}
                  onClick={() => onBid(2 + suit)}
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

function BidButton({ label, onClick, color }: { label: string; onClick: () => void; color: string }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      style={{
        background: color,
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        padding: '6px 14px',
        fontSize: '0.8rem',
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </motion.button>
  );
}
