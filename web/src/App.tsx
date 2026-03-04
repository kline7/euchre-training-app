import { Route, Switch, Link } from 'wouter';
import PlayPage from './pages/PlayPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import WasmErrorBoundary from './components/WasmErrorBoundary';
import './App.css';

function App() {
  return (
    <WasmErrorBoundary>
      <div className="app">
        <nav className="nav">
          <Link href="/">Play</Link>
          <Link href="/history">History</Link>
          <Link href="/settings">Settings</Link>
        </nav>

        <main className="main">
          <Switch>
            <Route path="/" component={PlayPage} />
            <Route path="/history" component={HistoryPage} />
            <Route path="/review/:gameId" component={ReviewPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route>404 — Not Found</Route>
          </Switch>
        </main>
      </div>
    </WasmErrorBoundary>
  );
}

export default App;
