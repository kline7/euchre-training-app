import { useState, useRef, useEffect } from 'react';
import { Route, Switch, Link, useLocation, useRoute } from 'wouter';
import PlayPage from './pages/PlayPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import WasmErrorBoundary from './components/WasmErrorBoundary';
import { useUI } from './stores/store';
import './App.css';

function PlayNavItem() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const requestRestart = useUI((s) => s.requestRestart);
  const [, navigate] = useLocation();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="nav-dropdown">
      <Link href="/" onClick={() => setOpen(false)}>Play</Link>
      <button
        className="nav-dropdown-toggle"
        onClick={(e) => { e.preventDefault(); setOpen(!open); }}
        aria-label="Play menu"
      >
        &#9662;
      </button>
      {open && (
        <div className="nav-dropdown-menu">
          <button
            onClick={() => {
              setOpen(false);
              navigate('/');
              requestRestart();
            }}
          >
            New Game
          </button>
        </div>
      )}
    </div>
  );
}

/** PlayPage wrapper — always mounted, hidden when not on "/" */
function PersistentPlayPage() {
  const [isPlay] = useRoute('/');
  return (
    <div style={{ display: isPlay ? undefined : 'none' }}>
      <PlayPage />
    </div>
  );
}

function App() {
  return (
    <WasmErrorBoundary>
      <div className="app">
        <nav className="nav">
          <PlayNavItem />
          <Link href="/history">History</Link>
          <Link href="/settings">Settings</Link>
        </nav>

        <main className="main">
          {/* PlayPage stays mounted to preserve game state */}
          <PersistentPlayPage />

          {/* Other pages mount/unmount normally */}
          <Switch>
            <Route path="/history" component={HistoryPage} />
            <Route path="/review/:gameId" component={ReviewPage} />
            <Route path="/settings" component={SettingsPage} />
          </Switch>
        </main>
      </div>
    </WasmErrorBoundary>
  );
}

export default App;
