import { useEffect, useState } from 'react';
import { useMp } from '../multiplayer/connection';
import type { PresenceStats } from '../multiplayer/protocol';

/**
 * Live player counts. Uses the WebSocket feed when connected; otherwise
 * (e.g. the login screen) falls back to polling the public REST endpoint.
 */
export default function PresenceBar() {
  const live = useMp((s) => s.presence);
  const status = useMp((s) => s.status);
  const [polled, setPolled] = useState<PresenceStats | null>(null);

  useEffect(() => {
    if (status === 'connected') return; // WS feed is authoritative
    let cancelled = false;
    const fetchOnce = () => {
      fetch('/api/presence', { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) setPolled(data as PresenceStats);
        })
        .catch(() => {});
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status]);

  const presence = status === 'connected' ? live : (polled ?? live);
  if (!presence) return null;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 16,
        fontSize: '0.8rem',
        color: '#9aa4b2',
        padding: '4px 0',
      }}
    >
      <span>
        <span style={{ color: '#27ae60' }}>●</span> {presence.online} online
      </span>
      <span>⏳ {presence.inQueue} in matchmaking</span>
      <span>🎴 {presence.inGame} in games</span>
    </div>
  );
}
