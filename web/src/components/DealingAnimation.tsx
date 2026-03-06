import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import CardComponent, { type CardData } from './cards/Card';

interface DealingAnimationProps {
  dealer: number;
  humanSeat: number;
  upcard: CardData | null;
  onComplete: () => void;
}

// Map seat to position relative to human (matches GameTable logic)
function seatPosition(seat: number, humanSeat: number): 'bottom' | 'left' | 'top' | 'right' {
  const relative = (seat - humanSeat + 4) % 4;
  return (['bottom', 'left', 'top', 'right'] as const)[relative];
}

// Target pixel offsets from center for each seat position
const SEAT_TARGETS: Record<string, { x: number; y: number }> = {
  bottom: { x: 0, y: 160 },
  left: { x: -220, y: 0 },
  top: { x: 0, y: -160 },
  right: { x: 220, y: 0 },
};

const TOTAL_CARDS = 20;
const DEAL_INTERVAL_MS = 80;
const POST_DEAL_PAUSE_MS = 400;

export default function DealingAnimation({ dealer, humanSeat, upcard, onComplete }: DealingAnimationProps) {
  const [dealtCount, setDealtCount] = useState(0);
  const [showUpcard, setShowUpcard] = useState(false);

  // Build dealing order: start left of dealer, clockwise, 5 cards each
  const dealOrder = useCallback(() => {
    const order: number[] = [];
    for (let i = 0; i < TOTAL_CARDS; i++) {
      order.push((dealer + 1 + i) % 4);
    }
    return order;
  }, [dealer]);

  const seats = dealOrder();

  useEffect(() => {
    if (dealtCount < TOTAL_CARDS) {
      const timer = setTimeout(() => setDealtCount((c) => c + 1), DEAL_INTERVAL_MS);
      return () => clearTimeout(timer);
    }

    // All cards dealt — pause then show upcard
    const upcardTimer = setTimeout(() => setShowUpcard(true), POST_DEAL_PAUSE_MS);
    return () => clearTimeout(upcardTimer);
  }, [dealtCount]);

  useEffect(() => {
    if (!showUpcard) return;
    // After upcard appears, brief pause then complete
    const timer = setTimeout(onComplete, 600);
    return () => clearTimeout(timer);
  }, [showUpcard, onComplete]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        pointerEvents: 'none',
      }}
    >
      {/* Deck in center */}
      {dealtCount < TOTAL_CARDS && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        >
          <CardComponent card={{ suit: 3, rank: 5 }} faceUp={false} size="sm" />
        </div>
      )}

      {/* Dealt cards flying to positions */}
      <AnimatePresence>
        {seats.slice(0, dealtCount).map((seat, i) => {
          const pos = seatPosition(seat, humanSeat);
          const target = SEAT_TARGETS[pos];
          // Stack cards slightly offset at destination
          const cardInSeat = seats.slice(0, i + 1).filter((s) => s === seat).length;
          const stackOffset = pos === 'left' || pos === 'right'
            ? { x: 0, y: (cardInSeat - 1) * -8 }
            : { x: (cardInSeat - 1) * 12, y: 0 };

          return (
            <motion.div
              key={`deal-${i}`}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                marginTop: -36,
                marginLeft: -24,
              }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 0.8 }}
              animate={{
                x: target.x + stackOffset.x,
                y: target.y + stackOffset.y,
                opacity: 1,
                scale: 1,
              }}
              transition={{ type: 'spring', stiffness: 400, damping: 30, duration: 0.3 }}
            >
              <CardComponent card={{ suit: 3, rank: 5 }} faceUp={false} size="sm" />
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Upcard flip in center */}
      {showUpcard && upcard && (
        <motion.div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 25,
          }}
          initial={{ rotateY: 180, scale: 0.8 }}
          animate={{ rotateY: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <CardComponent card={upcard} size="sm" />
        </motion.div>
      )}
    </div>
  );
}
