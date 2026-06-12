import { create } from 'zustand';
import { MatchClient, type ConnectionStatus } from './client';
import { useAuth, refreshProfile } from './auth';
import { useSettings } from '../stores/store';
import type {
  GameOverMsg,
  HandResultMsg,
  MatchState,
  PartyView,
  PresenceStats,
  ServerMessage,
} from './protocol';

/**
 * One shared WebSocket connection + state store for the whole app.
 * The lobby needs it for party invites; the match page for gameplay —
 * keeping it as a singleton means parties survive page navigation and
 * invites arrive while browsing the lobby.
 */

export interface MpState {
  status: ConnectionStatus;
  queue: { position: number; waitedMs: number } | null;
  /** Whether the current queue is the team (duo) queue. */
  teamQueue: boolean;
  match: MatchState | null;
  handResult: HandResultMsg | null;
  gameOver: GameOverMsg | null;
  notice: string | null;
  party: PartyView | null;
  /** Username of a player who invited us to a party (pending). */
  inviteFrom: string | null;
  /** Live player counts (online / queueing / playing). */
  presence: PresenceStats | null;
}

const initial: MpState = {
  status: 'disconnected',
  queue: null,
  teamQueue: false,
  match: null,
  handResult: null,
  gameOver: null,
  notice: null,
  party: null,
  inviteFrom: null,
  presence: null,
};

export const useMp = create<MpState>(() => ({ ...initial }));

let client: MatchClient | null = null;
let clientToken: string | null = null;

function handleMessage(msg: ServerMessage) {
  const s = useMp.getState();
  switch (msg.type) {
    case 'auth_ok':
      useAuth.getState().setProfile(msg.profile);
      break;
    case 'presence':
      useMp.setState({
        presence: { online: msg.online, inQueue: msg.inQueue, inGame: msg.inGame },
      });
      break;
    case 'queue_status':
      useMp.setState({ queue: { position: msg.position, waitedMs: msg.waitedMs } });
      break;
    case 'queue_left':
      useMp.setState({ queue: null, teamQueue: false });
      break;
    case 'team_queue_joined':
      useMp.setState({ teamQueue: true, queue: { position: 1, waitedMs: 0 } });
      break;
    case 'match_found':
      useMp.setState({ queue: null, teamQueue: false, handResult: null, gameOver: null });
      break;
    case 'state': {
      const handResult =
        s.match && msg.handNumber !== s.match.handNumber ? null : s.handResult;
      useMp.setState({ match: msg, handResult, queue: null });
      break;
    }
    case 'hand_result':
      useMp.setState({ handResult: msg });
      break;
    case 'game_over':
      useMp.setState({ gameOver: msg });
      void refreshProfile();
      break;
    case 'party_update':
      useMp.setState({ party: msg.party });
      break;
    case 'party_invite_received':
      useMp.setState({ inviteFrom: msg.from });
      break;
    case 'party_invite_sent':
      useMp.setState({ notice: `Invite sent to ${msg.to}` });
      break;
    case 'party_invite_declined':
      useMp.setState({ notice: `${msg.by} declined the invite` });
      break;
    case 'error':
      useMp.setState({ notice: msg.message });
      break;
    case 'opponent_connection':
      useMp.setState({
        notice: msg.connected
          ? `Seat ${msg.seat} reconnected`
          : `Seat ${msg.seat} disconnected — the table plays on for them`,
      });
      break;
    default:
      break;
  }
}

/** Connect (or reuse the existing connection) for the given auth token. */
export function ensureConnection(): MatchClient | null {
  const token = useAuth.getState().token;
  if (!token) return null;
  if (client && clientToken === token) return client;
  client?.close();
  useMp.setState({ ...initial });
  clientToken = token;
  client = new MatchClient(token, {
    onMessage: handleMessage,
    onStatus: (status) => useMp.setState({ status }),
  });
  client.connect();
  return client;
}

export function getConnection(): MatchClient | null {
  return client;
}

/** Tear down on logout. */
export function closeConnection() {
  client?.close();
  client = null;
  clientToken = null;
  useMp.setState({ ...initial });
}

// --- Convenience actions ---

/** The player's preferred lead rule (Settings → House Rules). */
function preferredRule(): boolean {
  return useSettings.getState().trumpMustBeBroken;
}

export const mp = {
  joinQueue: () => ensureConnection()?.joinQueue(preferredRule()),
  leaveQueue: () => {
    const c = ensureConnection();
    if (useMp.getState().teamQueue) c?.teamQueueLeave();
    else c?.leaveQueue();
  },
  sendAction: (...args: Parameters<MatchClient['sendAction']>) =>
    ensureConnection()?.sendAction(...args),
  partyInvite: (username: string) => ensureConnection()?.partyInvite(username),
  partyRespond: (accept: boolean) => {
    useMp.setState({ inviteFrom: null });
    ensureConnection()?.partyRespond(accept);
  },
  partyLeave: () => {
    useMp.setState({ party: null });
    ensureConnection()?.partyLeave();
  },
  teamQueueJoin: () => ensureConnection()?.teamQueueJoin(preferredRule()),
  teamPlayAi: (difficulty: number) => ensureConnection()?.teamPlayAi(difficulty, preferredRule()),
  clearNotice: () => useMp.setState({ notice: null }),
  resetForRequeue: () =>
    useMp.setState({ match: null, handResult: null, gameOver: null, queue: null }),
};
