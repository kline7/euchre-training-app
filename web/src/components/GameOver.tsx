import { motion } from 'motion/react';
import { useLocation } from 'wouter';

interface GameOverProps {
  scores: [number, number];
  totalWpc: number;
  handsPlayed: number;
  gameId: number | null;
  onNewGame: () => void;
}

export default function GameOver({ scores, totalWpc, handsPlayed, gameId, onNewGame }: GameOverProps) {
  const [, navigate] = useLocation();
  const won = scores[0] >= 10;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{
        background: 'rgba(0, 0, 0, 0.9)',
        borderRadius: 16,
        padding: '24px 28px',
        maxWidth: 400,
        margin: '24px auto',
        color: '#e0e0e0',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '2rem', fontWeight: 700, marginBottom: 4 }}>
        {won ? 'Victory!' : 'Defeat'}
      </div>
      <div style={{ fontSize: '0.85rem', opacity: 0.6, marginBottom: 16 }}>
        {won ? 'Great game!' : 'Better luck next time'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 20 }}>
        <Stat label="Final Score" value={`${scores[0]} - ${scores[1]}`} color={won ? '#27ae60' : '#e74c3c'} />
        <Stat label="Hands Played" value={String(handsPlayed)} color="#3498db" />
        <Stat label="Win% Lost" value={`${(totalWpc * 100).toFixed(1)}%`} color={totalWpc > 0.5 ? '#e74c3c' : '#27ae60'} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <GameOverButton label="New Game" onClick={onNewGame} color="#2e7d32" />
        {gameId && (
          <GameOverButton label="Review" onClick={() => navigate(`/review/${gameId}`)} color="#2e86c1" />
        )}
        <GameOverButton label="History" onClick={() => navigate('/history')} color="#7f8c8d" />
      </div>
    </motion.div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{label}</div>
    </div>
  );
}

function GameOverButton({ label, onClick, color }: { label: string; onClick: () => void; color: string }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      style={{
        flex: 1,
        padding: '10px 8px',
        background: color,
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        fontSize: '0.85rem',
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </motion.button>
  );
}
