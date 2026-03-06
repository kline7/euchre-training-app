import { motion } from 'motion/react';

interface DiscardPanelProps {
  onDiscard: (card: never) => void;
}

export default function DiscardPanel({ onDiscard: _onDiscard }: DiscardPanelProps) {
  return (
    <motion.div
      className="discard-panel"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'rgba(0, 0, 0, 0.8)',
        borderRadius: 12,
        padding: '12px 20px',
        maxWidth: 320,
        margin: '12px auto',
        textAlign: 'center',
        color: '#ffd700',
        fontSize: '0.9rem',
        fontWeight: 600,
      }}
    >
      Pick up the card! Select a card from your hand to discard.
    </motion.div>
  );
}
