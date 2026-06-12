import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  useAuth,
  login,
  register,
  loginAsGuest,
  logout,
  refreshProfile,
  fetchLeaderboard,
  type LeaderboardRow,
} from '../multiplayer/auth';
import {
  listFriends,
  requestFriend,
  respondFriend,
  removeFriend,
  teamLeaderboard,
  type FriendView,
  type TeamLeaderboardRow,
} from '../multiplayer/social';
import { ensureConnection, closeConnection, useMp, mp } from '../multiplayer/connection';
import { useSettings } from '../stores/store';
import DivisionBadge from '../components/DivisionBadge';
import PresenceBar from '../components/PresenceBar';

function RuleStyleNote() {
  const broken = useSettings((s) => s.trumpMustBeBroken);
  return (
    <p style={{ fontSize: '0.72rem', color: '#9aa4b2', textAlign: 'center', margin: '6px 0 0' }}>
      Style:{' '}
      <span style={{ color: broken ? '#f1c40f' : '#5dade2', fontWeight: 600 }}>
        {broken ? 'Broken trump (house rule)' : 'Open trump (standard)'}
      </span>{' '}
      — you'll match with same-style players. Change it in Settings.
    </p>
  );
}

const panel: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 12,
  padding: 20,
  maxWidth: 460,
  margin: '16px auto',
  color: '#e0e0e0',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #444',
  background: '#1b2330',
  color: '#e0e0e0',
  fontSize: '0.95rem',
  boxSizing: 'border-box',
};

const buttonStyle: React.CSSProperties = {
  padding: '10px 18px',
  borderRadius: 8,
  border: 'none',
  fontWeight: 700,
  fontSize: '0.95rem',
  cursor: 'pointer',
};

const smallBtn: React.CSSProperties = {
  ...buttonStyle,
  padding: '4px 10px',
  fontSize: '0.75rem',
};

export default function LobbyPage() {
  const { token, profile } = useAuth();
  return token && profile ? <Lobby /> : <AuthForm />;
}

function AuthForm() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(username, password);
      else await register(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginAsGuest();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panel}>
      <h2 style={{ marginTop: 0, textAlign: 'center' }}>Play Online</h2>
      <PresenceBar />
      <p style={{ fontSize: '0.85rem', color: '#9aa4b2', textAlign: 'center' }}>
        Matchmaking pairs you with players near your skill rating. Win rated
        games to climb the divisions and earn milk coins. 🥛
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          style={inputStyle}
          placeholder="Username"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          style={inputStyle}
          placeholder="Password (8+ characters)"
          type="password"
          value={password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div style={{ color: '#ff6b6b', fontSize: '0.85rem' }}>{error}</div>}
        <button
          type="submit"
          disabled={busy || username.length < 3 || password.length < 8}
          style={{ ...buttonStyle, background: '#27ae60', color: '#fff', opacity: busy ? 0.6 : 1 }}
        >
          {mode === 'login' ? 'Log In' : 'Create Account'}
        </button>
      </form>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          style={{ ...buttonStyle, background: 'transparent', color: '#5dade2', padding: 4 }}
        >
          {mode === 'login' ? 'Need an account?' : 'Have an account?'}
        </button>
        <button
          onClick={guest}
          disabled={busy}
          style={{ ...buttonStyle, background: 'transparent', color: '#f1c40f', padding: 4 }}
        >
          Play as Guest
        </button>
      </div>
    </div>
  );
}

function Lobby() {
  const [, navigate] = useLocation();
  const profile = useAuth((s) => s.profile)!;
  const party = useMp((s) => s.party);
  const inviteFrom = useMp((s) => s.inviteFrom);
  const notice = useMp((s) => s.notice);
  const match = useMp((s) => s.match);
  const teamQueue = useMp((s) => s.teamQueue);

  // Keep the shared connection alive so party invites arrive in the lobby
  useEffect(() => {
    ensureConnection();
    refreshProfile();
  }, []);

  // A match started (e.g. our party leader queued us) — go play
  useEffect(() => {
    if (match || teamQueue) navigate('/online');
  }, [match, teamQueue, navigate]);

  // Auto-dismiss notices
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => mp.clearNotice(), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const losses = profile.gamesPlayed - profile.wins;

  return (
    <div>
      <PresenceBar />
      {inviteFrom && (
        <div
          style={{
            ...panel,
            border: '1px solid #f1c40f',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span>
            🎴 <strong>{inviteFrom}</strong> invited you to their team
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => mp.partyRespond(true)} style={{ ...smallBtn, background: '#27ae60', color: '#fff' }}>
              Accept
            </button>
            <button onClick={() => mp.partyRespond(false)} style={{ ...smallBtn, background: '#7f8c8d', color: '#fff' }}>
              Decline
            </button>
          </span>
        </div>
      )}

      {notice && (
        <div style={{ textAlign: 'center', color: '#f1c40f', fontSize: '0.85rem' }}>{notice}</div>
      )}

      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>
            {profile.username} <DivisionBadge division={profile.division} />
          </h2>
          <button
            onClick={() => {
              closeConnection();
              logout();
            }}
            style={{ ...buttonStyle, background: 'transparent', color: '#7f8c8d', padding: 4, fontSize: '0.8rem' }}
          >
            Log out
          </button>
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
          <Stat label="Rating" value={String(profile.elo)} />
          <Stat label="Record" value={`${profile.wins}W – ${losses}L`} />
          <Stat label="Milk Coins" value={`🥛 ${profile.coins}`} />
        </div>
        {profile.isGuest && (
          <p style={{ fontSize: '0.75rem', color: '#9aa4b2', marginBottom: 0 }}>
            Guest account — progress is tied to this device.
          </p>
        )}
        {!party && (
          <>
            <button
              onClick={() => navigate('/online')}
              style={{
                ...buttonStyle,
                background: '#27ae60',
                color: '#fff',
                width: '100%',
                marginTop: 16,
                padding: '14px 18px',
                fontSize: '1.05rem',
              }}
            >
              Find Match (Solo)
            </button>
            <RuleStyleNote />
          </>
        )}
      </div>

      <PartyPanel />
      <FriendsPanel />
      <LeaderboardPanel />
    </div>
  );
}

function PartyPanel() {
  const party = useMp((s) => s.party);
  const profile = useAuth((s) => s.profile)!;
  const [difficulty, setDifficulty] = useState(3);

  if (!party) return null;

  const isLeader = party.members.find((m) => m.username === profile.username)?.leader ?? false;

  return (
    <div style={{ ...panel, border: '1px solid #5dade2' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Your Team</h3>
        <button onClick={() => mp.partyLeave()} style={{ ...smallBtn, background: '#7f8c8d', color: '#fff' }}>
          Leave
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        {party.members.map((m) => (
          <div key={m.username} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>
              {m.leader ? '⭐ ' : ''}
              {m.username}
            </span>
            <span>
              {m.elo} <DivisionBadge division={m.division} compact />
            </span>
          </div>
        ))}
        {!party.full && <div style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>Waiting for a friend to join…</div>}
      </div>

      {party.full && party.teamElo !== null && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: 'rgba(93,173,226,0.1)',
            borderRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            Team rating: <strong>{party.teamElo}</strong>{' '}
            {party.teamDivision && <DivisionBadge division={party.teamDivision} />}
          </span>
          {party.teamRecord && (
            <span style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
              {party.teamRecord.wins}W – {party.teamRecord.gamesPlayed - party.teamRecord.wins}L
            </span>
          )}
        </div>
      )}

      {party.full && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => mp.teamQueueJoin()}
            disabled={!isLeader}
            title={isLeader ? '' : 'Only the team leader can queue'}
            style={{
              ...buttonStyle,
              background: '#27ae60',
              color: '#fff',
              opacity: isLeader ? 1 : 0.5,
            }}
          >
            Queue as Team (Rated)
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => mp.teamPlayAi(difficulty)}
              disabled={!isLeader}
              title={isLeader ? '' : 'Only the team leader can start'}
              style={{
                ...buttonStyle,
                background: '#8e44ad',
                color: '#fff',
                flex: 1,
                opacity: isLeader ? 1 : 0.5,
              }}
            >
              Play vs AI (Practice)
            </button>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(Number(e.target.value))}
              style={{ ...inputStyle, width: 'auto' }}
            >
              <option value={0}>Novice</option>
              <option value={1}>Intermediate</option>
              <option value={2}>Advanced</option>
              <option value={3}>Expert</option>
            </select>
          </div>
          <RuleStyleNote />
        </div>
      )}
    </div>
  );
}

function FriendsPanel() {
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const party = useMp((s) => s.party);

  const reload = useCallback(() => {
    listFriends()
      .then((f) => {
        setFriends(f);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load friends'));
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000); // pick up new requests
    return () => clearInterval(id);
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const canInvite = !party || (!party.full && party.members.length === 1);

  return (
    <div style={panel}>
      <h3 style={{ marginTop: 0 }}>Friends</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length >= 3) {
            act(() => requestFriend(name.trim()));
            setName('');
          }
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Add friend by username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" style={{ ...buttonStyle, background: '#5dade2', color: '#fff' }}>
          Add
        </button>
      </form>
      {error && <div style={{ color: '#ff6b6b', fontSize: '0.85rem', marginTop: 8 }}>{error}</div>}
      <div style={{ marginTop: 10 }}>
        {friends === null && !error && <div style={{ color: '#9aa4b2' }}>Loading…</div>}
        {friends && friends.length === 0 && (
          <div style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
            No friends yet — add someone by username to team up.
          </div>
        )}
        {friends?.map((f) => (
          <div
            key={f.username}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span>
              {f.username}{' '}
              <span style={{ color: '#9aa4b2', fontSize: '0.8rem' }}>
                {f.elo} <DivisionBadge division={f.division} compact />
              </span>
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {f.status === 'incoming' && (
                <>
                  <button
                    onClick={() => act(() => respondFriend(f.username, true))}
                    style={{ ...smallBtn, background: '#27ae60', color: '#fff' }}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => act(() => respondFriend(f.username, false))}
                    style={{ ...smallBtn, background: '#7f8c8d', color: '#fff' }}
                  >
                    Decline
                  </button>
                </>
              )}
              {f.status === 'outgoing' && (
                <span style={{ color: '#9aa4b2', fontSize: '0.75rem' }}>Pending…</span>
              )}
              {f.status === 'friends' && (
                <>
                  {canInvite && (
                    <button
                      onClick={() => mp.partyInvite(f.username)}
                      style={{ ...smallBtn, background: '#5dade2', color: '#fff' }}
                    >
                      Invite to Team
                    </button>
                  )}
                  <button
                    onClick={() => act(() => removeFriend(f.username))}
                    style={{ ...smallBtn, background: 'transparent', color: '#7f8c8d' }}
                  >
                    ✕
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LeaderboardPanel() {
  const profile = useAuth((s) => s.profile)!;
  const [tab, setTab] = useState<'players' | 'teams'>('players');
  const [players, setPlayers] = useState<LeaderboardRow[] | null>(null);
  const [teams, setTeams] = useState<TeamLeaderboardRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchLeaderboard()
      .then(setPlayers)
      .catch(() => setError(true));
    teamLeaderboard()
      .then(setTeams)
      .catch(() => setError(true));
  }, []);

  const rows = tab === 'players' ? players : teams;

  return (
    <div style={panel}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ margin: 0, flex: 1 }}>Leaderboard</h3>
        <button
          onClick={() => setTab('players')}
          style={{
            ...smallBtn,
            background: tab === 'players' ? '#5dade2' : 'transparent',
            color: tab === 'players' ? '#fff' : '#9aa4b2',
          }}
        >
          Players
        </button>
        <button
          onClick={() => setTab('teams')}
          style={{
            ...smallBtn,
            background: tab === 'teams' ? '#5dade2' : 'transparent',
            color: tab === 'teams' ? '#fff' : '#9aa4b2',
          }}
        >
          Teams
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        {error && <div style={{ color: '#9aa4b2' }}>Could not load the leaderboard.</div>}
        {!error && rows === null && <div style={{ color: '#9aa4b2' }}>Loading…</div>}
        {rows && rows.length === 0 && (
          <div style={{ color: '#9aa4b2' }}>
            {tab === 'players' ? 'No rated games yet — be the first!' : 'No rated team games yet.'}
          </div>
        )}
        {rows && rows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ color: '#9aa4b2', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px' }}>#</th>
                <th style={{ padding: '4px 8px' }}>{tab === 'players' ? 'Player' : 'Team'}</th>
                <th style={{ padding: '4px 8px' }}>Division</th>
                <th style={{ padding: '4px 8px' }}>Elo</th>
                <th style={{ padding: '4px 8px' }}>W/L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const name =
                  'username' in row ? row.username : `${row.member1} & ${row.member2}`;
                const isMe =
                  'username' in row
                    ? row.username === profile.username
                    : row.member1 === profile.username || row.member2 === profile.username;
                const division = (row as { division?: string }).division ?? 'Bronze';
                return (
                  <tr
                    key={name}
                    style={{ background: isMe ? 'rgba(241,196,15,0.12)' : undefined }}
                  >
                    <td style={{ padding: '4px 8px' }}>{i + 1}</td>
                    <td style={{ padding: '4px 8px' }}>{name}</td>
                    <td style={{ padding: '4px 8px' }}>
                      <DivisionBadge division={division} compact />
                    </td>
                    <td style={{ padding: '4px 8px' }}>{row.elo}</td>
                    <td style={{ padding: '4px 8px' }}>
                      {row.wins}/{row.gamesPlayed - row.wins}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', color: '#9aa4b2', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{value}</div>
    </div>
  );
}
