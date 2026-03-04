import { useSettings } from '../stores/store';

const DIFFICULTIES = ['Novice', 'Intermediate', 'Advanced', 'Expert'];

export default function SettingsPage() {
  const { difficulty, setDifficulty, showHints, setShowHints, autoAnalyze, setAutoAnalyze } =
    useSettings();

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <label>
        Difficulty
        <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))}>
          {DIFFICULTIES.map((name, i) => (
            <option key={i} value={i}>{name}</option>
          ))}
        </select>
      </label>

      <label>
        <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} />
        Show hints
      </label>

      <label>
        <input type="checkbox" checked={autoAnalyze} onChange={(e) => setAutoAnalyze(e.target.checked)} />
        Auto-analyze after each hand
      </label>
    </div>
  );
}
