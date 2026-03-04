import { useSettings } from '../stores/store';

const DIFFICULTIES = [
  { name: 'Novice', desc: 'Random play — great for learning the basics' },
  { name: 'Intermediate', desc: 'Follows trump and basic strategy' },
  { name: 'Advanced', desc: 'Solid play with card counting' },
  { name: 'Expert', desc: 'Near-optimal play using PIMC search' },
];

export default function SettingsPage() {
  const { difficulty, setDifficulty, showHints, setShowHints, autoAnalyze, setAutoAnalyze } =
    useSettings();

  return (
    <div className="settings-page">
      <h2 style={{ color: '#e0e0e0', marginBottom: 16 }}>Settings</h2>

      <div className="settings-group">
        <label className="settings-label">Difficulty</label>
        <div className="difficulty-options">
          {DIFFICULTIES.map((d, i) => (
            <button
              key={i}
              className={`difficulty-btn ${difficulty === i ? 'active' : ''}`}
              onClick={() => setDifficulty(i)}
            >
              <span className="difficulty-name">{d.name}</span>
              <span className="difficulty-desc">{d.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Gameplay</label>
        <label className="toggle-label">
          <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} />
          <span>Show hints during play</span>
        </label>
        <label className="toggle-label">
          <input type="checkbox" checked={autoAnalyze} onChange={(e) => setAutoAnalyze(e.target.checked)} />
          <span>Auto-analyze after each hand</span>
        </label>
      </div>
    </div>
  );
}
