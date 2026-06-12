import type { GameRecord, HandRecord, HandAnalysisRecord } from './schema';
import { useAuth, loginAsGuest } from '../multiplayer/auth';

const BASE = '/api';
const TIMEOUT_MS = 5000;

export class ApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Game records are user-scoped on the server. Solo players who never opened
// the lobby get a frictionless guest account on first sync.
let guestLoginInFlight: Promise<void> | null = null;

async function authHeader(): Promise<Record<string, string>> {
  let token = useAuth.getState().token;
  if (!token) {
    try {
      guestLoginInFlight ??= loginAsGuest().finally(() => {
        guestLoginInFlight = null;
      });
      await guestLoginInFlight;
    } catch (err) {
      throw new ApiError(
        `Could not authenticate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    token = useAuth.getState().token;
  }
  if (!token) throw new ApiError('Not authenticated');
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeader();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...auth },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      `Network error for ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401) {
    // Stale/expired session — drop it so the next attempt re-authenticates
    useAuth.getState().clear();
    throw new ApiError('Session expired', 401);
  }
  if (!res.ok) {
    throw new ApiError(`Request failed (${res.status} ${res.statusText}) for ${path}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(`Invalid JSON response for ${path}`, res.status);
  }
}

export async function createGame(data: { seed: number; difficulty: number }): Promise<GameRecord> {
  return request<GameRecord>('/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function listGames(limit = 50): Promise<GameRecord[]> {
  return request<GameRecord[]>(`/games?limit=${limit}`);
}

export async function getGame(id: number): Promise<GameRecord | undefined> {
  try {
    return await request<GameRecord>(`/games/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

export async function updateGame(
  id: number,
  data: { hands?: unknown[]; finalScore?: [number, number]; analysis?: unknown[] },
): Promise<GameRecord> {
  return request<GameRecord>(`/games/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// --- Offline outbox ---------------------------------------------------------
// When the server is unreachable, finished game data is queued in
// localStorage and flushed opportunistically (at app start and after each
// hand save). The game itself never blocks on the network.

const OUTBOX_KEY = 'euchre-outbox';

export interface OutboxGame {
  /** Stable client-side id used to dedupe entries across retries. */
  localId: string;
  /** Server id, once known (createGame succeeded at some point). */
  serverId?: number;
  seed: number;
  difficulty: number;
  hands: HandRecord[];
  analysis: HandAnalysisRecord[];
  finalScore: [number, number];
}

function readOutbox(): OutboxGame[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxGame[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(games: OutboxGame[]): void {
  try {
    if (games.length === 0) {
      localStorage.removeItem(OUTBOX_KEY);
    } else {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(games));
    }
  } catch (err) {
    console.warn('Failed to persist outbox:', err);
  }
}

/** Insert or replace the outbox entry for entry.localId (preserving a known serverId). */
export function outboxPut(entry: OutboxGame): void {
  const items = readOutbox();
  const idx = items.findIndex((g) => g.localId === entry.localId);
  if (idx >= 0) {
    items[idx] = { ...entry, serverId: entry.serverId ?? items[idx].serverId };
  } else {
    items.push(entry);
  }
  writeOutbox(items);
}

export function outboxRemove(localId: string): void {
  const items = readOutbox();
  const next = items.filter((g) => g.localId !== localId);
  if (next.length !== items.length) writeOutbox(next);
}

let flushInFlight: Promise<Record<string, number>> | null = null;

/**
 * Attempt to push queued games to the server. Never throws.
 * Returns a map of localId -> serverId for entries synced (or partially
 * synced) during this flush, so callers can adopt the server id.
 */
export function flushOutbox(): Promise<Record<string, number>> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const synced: Record<string, number> = {};
    const items = readOutbox();
    if (items.length === 0) return synced;
    const remaining: OutboxGame[] = [];
    for (const g of items) {
      try {
        let id = g.serverId;
        if (id == null) {
          const created = await createGame({ seed: g.seed, difficulty: g.difficulty });
          id = created.id;
          // Remember the server id immediately so a failed PATCH below
          // doesn't create a duplicate game on the next flush.
          g.serverId = id;
          synced[g.localId] = id;
        }
        await updateGame(id, {
          hands: g.hands,
          analysis: g.analysis,
          finalScore: g.finalScore,
        });
        synced[g.localId] = id;
      } catch {
        remaining.push(g);
      }
    }
    writeOutbox(remaining);
    return synced;
  })().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}
