import { useAuth, AuthError } from './auth';

/** Friends + teams REST client. */

const BASE = '/api';

export interface FriendView {
  username: string;
  elo: number;
  division: string;
  status: 'friends' | 'incoming' | 'outgoing';
}

export interface TeamView {
  id: number;
  members: [string, string];
  elo: number;
  division: string;
  gamesPlayed: number;
  wins: number;
}

export interface TeamLeaderboardRow {
  member1: string;
  member2: string;
  elo: number;
  division: string;
  gamesPlayed: number;
  wins: number;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAuth.getState().token;
  if (!token) throw new AuthError('Not signed in', 401);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AuthError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export function listFriends(): Promise<FriendView[]> {
  return call<FriendView[]>('/friends');
}

export function requestFriend(username: string): Promise<unknown> {
  return call('/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
}

export function respondFriend(username: string, accept: boolean): Promise<unknown> {
  return call('/friends/respond', {
    method: 'POST',
    body: JSON.stringify({ username, accept }),
  });
}

export function removeFriend(username: string): Promise<unknown> {
  return call(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' });
}

export function myTeams(): Promise<TeamView[]> {
  return call<TeamView[]>('/teams/mine');
}

export function teamLeaderboard(): Promise<TeamLeaderboardRow[]> {
  return call<TeamLeaderboardRow[]>('/leaderboard?type=teams');
}
