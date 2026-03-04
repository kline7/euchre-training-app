import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation } from 'wouter';
import { db } from '../db/schema';

export default function HistoryPage() {
  const [, navigate] = useLocation();
  const games = useLiveQuery(() => db.games.orderBy('createdAt').reverse().limit(50).toArray());

  return (
    <div className="history-page">
      <h1>Game History</h1>
      {!games ? (
        <p>Loading...</p>
      ) : games.length === 0 ? (
        <p>No games played yet. Start a game to see your history.</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => (
            <li key={game.id} onClick={() => navigate(`/review/${game.id}`)}>
              <span className="game-date">
                {game.createdAt.toLocaleDateString()}
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
