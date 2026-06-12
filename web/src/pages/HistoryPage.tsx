import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { listGames } from '../db/api';
import type { GameRecord } from '../db/schema';

export default function HistoryPage() {
  const [, navigate] = useLocation();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setGames(null);
    setError(null);
    listGames(50)
      .then((g) => { if (!cancelled) setGames(g); })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load games');
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return (
    <div className="history-page">
      <h1>Game History</h1>
      {error ? (
        <div>
          <p>Could not load game history: {error}</p>
          <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      ) : !games ? (
        <p>Loading...</p>
      ) : games.length === 0 ? (
        <p>No games played yet. Start a game to see your history.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <li key={game.id} onClick={() => navigate(`/review/${game.id}`)}>
              <span className="game-date">
                {new Date(game.createdAt).toLocaleDateString()}
              </span>
              <span className="game-score">
                {game.finalScore[0]} - {game.finalScore[1]}
              </span>
              <span className="game-difficulty">
                {['Novice', 'Intermediate', 'Advanced', 'Expert'][game.difficulty]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
