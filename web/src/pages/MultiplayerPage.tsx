import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import GameTable from '../components/GameTable';
import BiddingPanel from '../components/BiddingPanel';
import DivisionBadge from '../components/DivisionBadge';
import PresenceBar from '../components/PresenceBar';
import { useAuth } from '../multiplayer/auth';
import { ensureConnection, useMp, mp } from '../multiplayer/connection';
import type { CardData, MatchState } from '../multiplayer/protocol';

const SUIT_SYMBOLS = ['♥', '♦', '♣', '♠'];
const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];

function bidLabel(bid: number): string {
  if (bid === 0) return 'Pass';
  if (bid === 1) return 'Order Up';
  if (bid >= 2 && bid <= 5) return `${SUIT_SYMBOLS[bid - 2]} ${SUIT_NAMES[bid - 2]}`;
  if (bid === 6) return 'Alone!';
  if (bid >= 7 && bid <= 10) return `${SUIT_SYMBOLS[bid - 7]} Alone!`;
  return '?';
}

const PHASE_NAMES: Record<number, string> = {
  1: 'bidding1',
  2: 'bidding2',
  3: 'discard',
  4: 'playing',
  5: 'scoring',
  6: 'gameover',
};

/** Synthesize hidden hands for the table from public card counts. */
function buildHands(match: MatchState): CardData[][] {
  return [0, 1, 2, 3].map((seat) => {
    if (seat === match.yourSeat) return match.hand;
    return Array.from({ length: match.handCounts[seat] }, (_, i) => ({
      suit: i % 4,
      rank: Math.floor(i / 4),
    }));
  });
}

export default function MultiplayerPage() {
  const [, navigate] = useLocation();
  const token = useAuth((s) => s.token);
  const profile = useAuth((s) => s.profile);
  const state = useMp();
  const [now, setNow] = useState(Date.now());
  const queuedOnMount = useRef(false);

  // Redirect to the lobby when not signed in
  useEffect(() => {
    if (!token) navigate('/lobby');
  }, [token, navigate]);

  // Connect, and join the SOLO queue when arriving with nothing in flight.
  // (Team queueing and matches are started from the lobby's party panel.)
  useEffect(() => {
    if (!token) return;
    ensureConnection();
    if (queuedOnMount.current) return;
    queuedOnMount.current = true;
    const s = useMp.getState();
    if (!s.match && !s.gameOver && !s.queue && !s.party) {
      mp.joinQueue();
    }
  }, [token]);

  // Tick for the turn-clock countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-dismiss notices
  useEffect(() => {
    if (!state.notice) return;
    const id = setTimeout(() => mp.clearNotice(), 4000);
    return () => clearTimeout(id);
  }, [state.notice]);

  const match = state.match;
  const myTurn =
    !!match && !match.paused && match.nextToPlay === match.yourSeat && match.phase >= 1 && match.phase <= 4;

  const handleCardClick = useCallback(
    (card: CardData) => {
      if (!match || match.paused) return;
      if (match.phase === 4) {
        const legal = match.legalPlays.some((c) => c.suit === card.suit && c.rank === card.rank);
        if (legal && match.nextToPlay === match.yourSeat) {
          mp.sendAction({ type: 'play', card });
        }
      } else if (match.phase === 3 && match.nextToPlay === match.yourSeat) {
        mp.sendAction({ type: 'discard', card });
      }
    },
    [match],
  );

  const handleBid = useCallback((bid: number) => {
    mp.sendAction({ type: 'bid', bid });
  }, []);

  const requeue = useCallback(() => {
    mp.resetForRequeue();
    mp.joinQueue();
  }, []);

  const leaveToLobby = useCallback(() => {
    mp.leaveQueue();
    navigate('/lobby');
  }, [navigate]);

  if (!token || !profile) return null;

  // --- Game over screen ---
  if (state.gameOver) {
    const over = state.gameOver;
    const mine = over.results.find((r) => r.seat === state.match?.yourSeat);
    const won = state.match ? state.match.yourSeat % 2 === over.winningTeam : false;
    const rated = !!mine && (mine.eloDelta !== 0 || mine.coinsAwarded > 0);
    return (
      <div style={{ maxWidth: 460, margin: '40px auto', textAlign: 'center', color: '#e0e0e0' }}>
        <h1 style={{ color: won ? '#27ae60' : '#e74c3c' }}>
          {won ? 'Victory!' : 'Defeat'}
        </h1>
        <p style={{ fontSize: '1.1rem' }}>
          Final score {over.scores[0]} – {over.scores[1]}
        </p>
        {mine && rated && (
          <div style={{ background: 'rgba(0,0,0,0.55)', borderRadius: 12, padding: 16, margin: '16px 0' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>
              {mine.eloBefore} → {mine.eloAfter}{' '}
              <span style={{ color: mine.eloDelta >= 0 ? '#27ae60' : '#e74c3c' }}>
                ({mine.eloDelta >= 0 ? '+' : ''}{mine.eloDelta})
              </span>
            </div>
            {mine.coinsAwarded > 0 && (
              <div style={{ color: '#f1c40f', marginTop: 6 }}>+{mine.coinsAwarded} milk coins 🥛</div>
            )}
          </div>
        )}
        {mine && !rated && (
          <p style={{ color: '#9aa4b2' }}>Practice match vs AI — no rating change.</p>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', marginBottom: 20 }}>
          <tbody>
            {over.results.map((r) => (
              <tr key={r.seat} style={{ color: r.seat % 2 === over.winningTeam ? '#27ae60' : '#9aa4b2' }}>
                <td style={{ padding: 4, textAlign: 'left' }}>{r.username}</td>
                <td style={{ padding: 4 }}>
                  {r.eloDelta === 0 ? r.eloAfter : `${r.eloAfter} (${r.eloDelta >= 0 ? '+' : ''}${r.eloDelta})`}
                </td>
                <td style={{ padding: 4 }}>{r.coinsAwarded > 0 ? `🥛 +${r.coinsAwarded}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          {!state.party && <button onClick={requeue} style={btn('#27ae60')}>Play Again</button>}
          <button onClick={leaveToLobby} style={btn('#7f8c8d')}>Back to Lobby</button>
        </div>
      </div>
    );
  }

  // --- Queueing screen ---
  if (!match) {
    return (
      <div style={{ maxWidth: 380, margin: '60px auto', textAlign: 'center', color: '#e0e0e0' }}>
        <h2>{state.teamQueue ? 'Finding an opposing team…' : 'Finding a match…'}</h2>
        <p style={{ color: '#9aa4b2' }}>
          {state.status !== 'connected'
            ? 'Connecting to server…'
            : state.queue
              ? `In queue — ${Math.floor(state.queue.waitedMs / 1000)}s. The rating range widens as you wait.`
              : 'Joining the queue…'}
        </p>
        <div className="spinner" style={{ margin: '24px auto' }} />
        <PresenceBar />
        <button onClick={leaveToLobby} style={{ ...btn('#7f8c8d'), marginTop: 12 }}>Cancel</button>
        {state.notice && <p style={{ color: '#f1c40f' }}>{state.notice}</p>}
      </div>
    );
  }

  // --- Live match ---
  const phaseName = PHASE_NAMES[match.phase] ?? 'playing';
  const isBidding = (match.phase === 1 || match.phase === 2) && myTurn;
  const isDiscarding = match.phase === 3 && myTurn;
  const seconds =
    match.turnDeadline && myTurn ? Math.max(0, Math.ceil((match.turnDeadline - now) / 1000)) : null;
  // GameTable displays index 0 as "Us" — flip team-indexed tuples for seats 1/3
  const myTeam = match.yourSeat % 2;
  const displayScores: [number, number] =
    myTeam === 0 ? match.scores : [match.scores[1], match.scores[0]];
  const displayTricks: [number, number] =
    myTeam === 0 ? match.tricksWon : [match.tricksWon[1], match.tricksWon[0]];

  return (
    <div>
      {/* Opponent bar */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 14, padding: '6px 0', flexWrap: 'wrap' }}>
        {match.players.map((p) => (
          <span
            key={p.seat}
            style={{
              color: p.seat === match.yourSeat ? '#f1c40f' : p.connected ? '#e0e0e0' : '#777',
              fontSize: '0.8rem',
            }}
          >
            {p.seat % 2 === match.yourSeat % 2 ? '🤝' : '⚔️'} {p.username} ({p.elo})
            {!p.connected && ' ⚠︎'}
          </span>
        ))}
      </div>

      {state.notice && (
        <div style={{ textAlign: 'center', color: '#f1c40f', fontSize: '0.85rem' }}>{state.notice}</div>
      )}
      {seconds !== null && seconds <= 15 && (
        <div style={{ textAlign: 'center', color: seconds <= 5 ? '#e74c3c' : '#f1c40f', fontWeight: 700 }}>
          ⏱ {seconds}s
        </div>
      )}

      <GameTable
        hands={buildHands(match)}
        currentTrick={match.currentTrick}
        legalPlays={
          isDiscarding ? match.hand : match.phase === 4 && myTurn ? match.legalPlays : []
        }
        trumpSuit={match.trump}
        dealer={match.dealer}
        maker={match.maker}
        tricksWon={displayTricks}
        scores={displayScores}
        trickNumber={match.trickNumber}
        humanSeat={match.yourSeat}
        onPlayCard={handleCardClick}
        thinking={!myTurn && match.phase === 4 && !match.paused}
        active
        upcard={match.upcard}
        phase={phaseName}
        sittingOut={match.sittingOut}
        bidLog={match.bidLog.map((b) => ({ seat: b.seat, label: bidLabel(b.bid) }))}
      />

      {isDiscarding && (
        <div style={{ textAlign: 'center', color: '#f1c40f', fontWeight: 600, padding: 8 }}>
          You picked up the {SUIT_SYMBOLS[match.upcard.suit]} upcard — select a card to discard
        </div>
      )}

      {isBidding && (
        <BiddingPanel
          phase={match.phase === 1 ? 'round1' : 'round2'}
          upcard={match.upcard}
          isDealer={match.dealer === match.yourSeat}
          turnedDownSuit={match.turnedDownSuit}
          onBid={handleBid}
        />
      )}

      {state.handResult && (
        <div
          style={{
            textAlign: 'center',
            background: 'rgba(0,0,0,0.7)',
            borderRadius: 10,
            padding: 12,
            margin: '10px auto',
            maxWidth: 360,
            color: '#e0e0e0',
          }}
        >
          {(() => {
            const r = state.handResult;
            const winners = r.isEuchre ? 1 - r.makerTeam : r.makerTeam;
            const wonHand = winners === myTeam;
            return (
              <>
                <strong style={{ color: wonHand ? '#27ae60' : '#e74c3c' }}>
                  {r.isEuchre ? 'Euchred!' : r.isSweep ? 'March!' : 'Hand over'}
                </strong>{' '}
                {wonHand ? 'Your team' : 'They'} scored {Math.abs(r.points)} point
                {Math.abs(r.points) === 1 ? '' : 's'} — next hand dealing…
              </>
            );
          })()}
        </div>
      )}

      {match.paused && !state.handResult && (
        <div style={{ textAlign: 'center', color: '#9aa4b2', fontSize: '0.8rem' }}>…</div>
      )}

      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <DivisionBadge division={profile.division} compact />
      </div>
    </div>
  );
}

function btn(background: string): React.CSSProperties {
  return {
    background,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontWeight: 700,
    fontSize: '0.95rem',
    cursor: 'pointer',
  };
}
