import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Profile } from './protocol';

/** REST auth client + persisted session store for multiplayer. */

const BASE = '/api';

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

async function post(path: string, body?: unknown, token?: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new AuthError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data;
}

interface AuthResponse {
  token: string;
  profile: Profile;
}

interface AuthState {
  token: string | null;
  profile: Profile | null;
  setSession: (token: string, profile: Profile) => void;
  setProfile: (profile: Profile) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      profile: null,
      setSession: (token, profile) => set({ token, profile }),
      setProfile: (profile) => set({ profile }),
      clear: () => set({ token: null, profile: null }),
    }),
    { name: 'euchre-auth' },
  ),
);

export async function register(username: string, password: string): Promise<void> {
  const { token, profile } = (await post('/auth/register', { username, password })) as AuthResponse;
  useAuth.getState().setSession(token, profile);
}

export async function login(username: string, password: string): Promise<void> {
  const { token, profile } = (await post('/auth/login', { username, password })) as AuthResponse;
  useAuth.getState().setSession(token, profile);
}

export async function loginAsGuest(): Promise<void> {
  const { token, profile } = (await post('/auth/guest')) as AuthResponse;
  useAuth.getState().setSession(token, profile);
}

export async function logout(): Promise<void> {
  const token = useAuth.getState().token;
  useAuth.getState().clear();
  if (token) {
    await post('/auth/logout', undefined, token).catch(() => {});
  }
}

/** Refresh the profile (elo/coins) from the server. */
export async function refreshProfile(): Promise<Profile | null> {
  const token = useAuth.getState().token;
  if (!token) return null;
  try {
    const res = await fetch(`${BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      useAuth.getState().clear();
      return null;
    }
    if (!res.ok) return useAuth.getState().profile;
    const { profile } = (await res.json()) as { profile: Profile };
    useAuth.getState().setProfile(profile);
    return profile;
  } catch {
    return useAuth.getState().profile;
  }
}

export interface LeaderboardRow {
  username: string;
  elo: number;
  division: string;
  gamesPlayed: number;
  wins: number;
}

export async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const token = useAuth.getState().token;
  if (!token) return [];
  const res = await fetch(`${BASE}/leaderboard`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new AuthError('Could not load leaderboard', res.status);
  return (await res.json()) as LeaderboardRow[];
}
