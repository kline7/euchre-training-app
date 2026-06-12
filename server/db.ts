import Database from 'better-sqlite3';
import { DB_PATH } from './env.js';

/**
 * Database layer. All statements are prepared with placeholders (no string
 * interpolation), all multi-step writes run in transactions, and schema
 * changes go through the versioned migration runner below.
 */

export const sqlite = new Database(process.env.NODE_ENV === 'test' ? ':memory:' : DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// --- Migrations (PRAGMA user_version) ---

const MIGRATIONS: string[][] = [
  // v1: full schema. `games` may already exist from the pre-auth prototype;
  // user_id is added separately below for that case.
  [
    `CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      seed INTEGER NOT NULL,
      difficulty INTEGER NOT NULL,
      hands TEXT NOT NULL DEFAULT '[]',
      final_score TEXT NOT NULL DEFAULT '[0,0]',
      analysis TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ratings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      elo INTEGER NOT NULL DEFAULT 1200,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('active','complete','abandoned')) DEFAULT 'active',
      final_score TEXT,
      winning_team INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS match_players (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
      rating_before INTEGER,
      rating_after INTEGER,
      PRIMARY KEY (match_id, seat)
    )`,
    `CREATE TABLE IF NOT EXISTS match_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      seq INTEGER NOT NULL,
      seat INTEGER,
      action_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (match_id, seq)
    )`,
    `CREATE TABLE IF NOT EXISTS coin_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      match_id INTEGER REFERENCES matches(id),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id, match_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_user ON coin_ledger(user_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  ],
  // v2: friends, pre-made teams with their own elo, match modes
  [
    `CREATE TABLE IF NOT EXISTS friendships (
      user_lo INTEGER NOT NULL REFERENCES users(id),
      user_hi INTEGER NOT NULL REFERENCES users(id),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('pending','accepted')) DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_lo, user_hi),
      CHECK (user_lo < user_hi)
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_lo INTEGER NOT NULL REFERENCES users(id),
      user_hi INTEGER NOT NULL REFERENCES users(id),
      elo INTEGER NOT NULL,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_lo, user_hi),
      CHECK (user_lo < user_hi)
    )`,
    `ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'solo_rated'`,
    `CREATE INDEX IF NOT EXISTS idx_friendships_hi ON friendships(user_hi)`,
    `CREATE INDEX IF NOT EXISTS idx_teams_users ON teams(user_lo, user_hi)`,
  ],
];

function runMigrations() {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const apply = sqlite.transaction(() => {
      for (const stmt of MIGRATIONS[v]) sqlite.prepare(stmt).run();
      sqlite.pragma(`user_version = ${v + 1}`);
    });
    apply();
  }

  // Legacy prototype `games` table lacked user_id — add it if missing.
  const cols = sqlite.prepare(`SELECT name FROM pragma_table_info('games')`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'user_id')) {
    sqlite.prepare(`ALTER TABLE games ADD COLUMN user_id INTEGER REFERENCES users(id)`).run();
  }
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id, created_at)`).run();
}

runMigrations();

// --- Solo training games (user-scoped) ---

export interface GameRow {
  id: number;
  created_at: string;
  seed: number;
  difficulty: number;
  hands: string;
  final_score: string;
  analysis: string;
  user_id: number | null;
}

export interface GameRecord {
  id: number;
  createdAt: string;
  seed: number;
  difficulty: number;
  hands: unknown[];
  finalScore: [number, number];
  analysis: unknown[];
}

function toGameRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    seed: row.seed,
    difficulty: row.difficulty,
    hands: JSON.parse(row.hands),
    finalScore: JSON.parse(row.final_score),
    analysis: JSON.parse(row.analysis),
  };
}

const insertGame = sqlite.prepare(
  `INSERT INTO games (seed, difficulty, user_id) VALUES (?, ?, ?) RETURNING *`,
);
const getGameById = sqlite.prepare(`SELECT * FROM games WHERE id = ? AND user_id = ?`);
const listGamesStmt = sqlite.prepare(
  `SELECT * FROM games WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
);
const updateGameStmt = sqlite.prepare(
  `UPDATE games SET hands = ?, final_score = ?, analysis = ? WHERE id = ? AND user_id = ? RETURNING *`,
);

export function createGame(userId: number, seed: number, difficulty: number): GameRecord {
  const row = insertGame.get(seed, difficulty, userId) as GameRow;
  return toGameRecord(row);
}

export function getGame(userId: number, id: number): GameRecord | undefined {
  const row = getGameById.get(id, userId) as GameRow | undefined;
  return row ? toGameRecord(row) : undefined;
}

export function listRecentGames(userId: number, limit: number): GameRecord[] {
  const rows = listGamesStmt.all(userId, limit) as GameRow[];
  return rows.map(toGameRecord);
}

export const updateGame = sqlite.transaction(
  (
    userId: number,
    id: number,
    data: { hands?: unknown[]; finalScore?: [number, number]; analysis?: unknown[] },
  ): GameRecord | undefined => {
    const existing = getGameById.get(id, userId) as GameRow | undefined;
    if (!existing) return undefined;

    const hands = data.hands !== undefined ? JSON.stringify(data.hands) : existing.hands;
    const finalScore =
      data.finalScore !== undefined ? JSON.stringify(data.finalScore) : existing.final_score;
    const analysis =
      data.analysis !== undefined ? JSON.stringify(data.analysis) : existing.analysis;

    const row = updateGameStmt.get(hands, finalScore, analysis, id, userId) as GameRow;
    return toGameRecord(row);
  },
);

// --- Users / sessions ---

export interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  is_guest: number;
  created_at: string;
}

export const insertUser = sqlite.prepare(
  `INSERT INTO users (username, password_hash, is_guest) VALUES (?, ?, ?) RETURNING *`,
);
export const getUserByName = sqlite.prepare(
  `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
);
export const getUserById = sqlite.prepare(`SELECT * FROM users WHERE id = ?`);
export const insertSession = sqlite.prepare(
  `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
);
export const getSession = sqlite.prepare(
  `SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`,
);
export const deleteSession = sqlite.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
export const insertRating = sqlite.prepare(
  `INSERT OR IGNORE INTO ratings (user_id) VALUES (?)`,
);

// --- Ratings / coins ---

export interface RatingRow {
  user_id: number;
  elo: number;
  games_played: number;
  wins: number;
  updated_at: string;
}

export const getRating = sqlite.prepare(`SELECT * FROM ratings WHERE user_id = ?`);
export const updateRatingStmt = sqlite.prepare(
  `UPDATE ratings SET elo = ?, games_played = games_played + 1, wins = wins + ?, updated_at = datetime('now') WHERE user_id = ?`,
);
export const insertLedgerEntry = sqlite.prepare(
  `INSERT OR IGNORE INTO coin_ledger (user_id, amount, reason, match_id, idempotency_key) VALUES (?, ?, ?, ?, ?)`,
);
export const coinBalanceStmt = sqlite.prepare(
  `SELECT COALESCE(SUM(amount), 0) AS balance FROM coin_ledger WHERE user_id = ?`,
);

export function coinBalance(userId: number): number {
  return (coinBalanceStmt.get(userId) as { balance: number }).balance;
}

// --- Friendships ---

export interface FriendshipRow {
  user_lo: number;
  user_hi: number;
  requested_by: number;
  status: 'pending' | 'accepted';
  created_at: string;
}

export const insertFriendship = sqlite.prepare(
  `INSERT INTO friendships (user_lo, user_hi, requested_by) VALUES (?, ?, ?)`,
);
export const getFriendship = sqlite.prepare(
  `SELECT * FROM friendships WHERE user_lo = ? AND user_hi = ?`,
);
export const acceptFriendship = sqlite.prepare(
  `UPDATE friendships SET status = 'accepted' WHERE user_lo = ? AND user_hi = ? AND status = 'pending'`,
);
export const deleteFriendship = sqlite.prepare(
  `DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?`,
);
export const listFriendships = sqlite.prepare(
  `SELECT f.*, ulo.username AS lo_username, uhi.username AS hi_username
   FROM friendships f
   JOIN users ulo ON ulo.id = f.user_lo
   JOIN users uhi ON uhi.id = f.user_hi
   WHERE f.user_lo = ? OR f.user_hi = ?
   ORDER BY f.created_at DESC`,
);

/** Normalize a user pair to (lo, hi) for the symmetric tables. */
export function pairKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function areFriends(a: number, b: number): boolean {
  const [lo, hi] = pairKey(a, b);
  const row = getFriendship.get(lo, hi) as FriendshipRow | undefined;
  return row?.status === 'accepted';
}

// --- Teams (persistent duo with its own rating) ---

export interface TeamRow {
  id: number;
  user_lo: number;
  user_hi: number;
  elo: number;
  games_played: number;
  wins: number;
  created_at: string;
  updated_at: string;
}

export const getTeamByPair = sqlite.prepare(
  `SELECT * FROM teams WHERE user_lo = ? AND user_hi = ?`,
);
const getTeamByIdStmt = sqlite.prepare(`SELECT * FROM teams WHERE id = ?`);

export function getTeamById(id: number): TeamRow {
  const row = getTeamByIdStmt.get(id) as TeamRow | undefined;
  if (!row) throw new Error(`team ${id} not found`);
  return row;
}
export const insertTeam = sqlite.prepare(
  `INSERT INTO teams (user_lo, user_hi, elo) VALUES (?, ?, ?) RETURNING *`,
);
export const updateTeamRating = sqlite.prepare(
  `UPDATE teams SET elo = ?, games_played = games_played + 1, wins = wins + ?, updated_at = datetime('now') WHERE id = ?`,
);
export const listTeamsForUser = sqlite.prepare(
  `SELECT t.*, ulo.username AS lo_username, uhi.username AS hi_username
   FROM teams t
   JOIN users ulo ON ulo.id = t.user_lo
   JOIN users uhi ON uhi.id = t.user_hi
   WHERE t.user_lo = ? OR t.user_hi = ?
   ORDER BY t.elo DESC`,
);
export const topTeams = sqlite.prepare(
  `SELECT t.elo, t.games_played AS gamesPlayed, t.wins,
          ulo.username AS member1, uhi.username AS member2
   FROM teams t
   JOIN users ulo ON ulo.id = t.user_lo
   JOIN users uhi ON uhi.id = t.user_hi
   WHERE t.games_played > 0
   ORDER BY t.elo DESC, t.wins DESC
   LIMIT ?`,
);

/**
 * Get or create the persistent team row for a duo. A new team starts at the
 * average of the two members' CURRENT individual ratings ("combined" rating),
 * and from then on the team's elo evolves independently.
 */
export function getOrCreateTeam(a: number, b: number): TeamRow {
  const [lo, hi] = pairKey(a, b);
  const existing = getTeamByPair.get(lo, hi) as TeamRow | undefined;
  if (existing) return existing;
  const eloLo = (getRating.get(lo) as RatingRow | undefined)?.elo ?? 1200;
  const eloHi = (getRating.get(hi) as RatingRow | undefined)?.elo ?? 1200;
  const startElo = Math.round((eloLo + eloHi) / 2);
  return insertTeam.get(lo, hi, startElo) as TeamRow;
}

// --- Matches ---

export const insertMatch = sqlite.prepare(
  `INSERT INTO matches (mode) VALUES (?) RETURNING id`,
);
export const insertMatchPlayer = sqlite.prepare(
  `INSERT INTO match_players (match_id, user_id, seat, rating_before) VALUES (?, ?, ?, ?)`,
);
export const insertMatchAction = sqlite.prepare(
  `INSERT INTO match_actions (match_id, seq, seat, action_json) VALUES (?, ?, ?, ?)`,
);
export const completeMatchStmt = sqlite.prepare(
  `UPDATE matches SET status = 'complete', final_score = ?, winning_team = ?, completed_at = datetime('now') WHERE id = ? AND status = 'active'`,
);
export const abandonMatchStmt = sqlite.prepare(
  `UPDATE matches SET status = 'abandoned', completed_at = datetime('now') WHERE id = ? AND status = 'active'`,
);
export const setPlayerRatingAfter = sqlite.prepare(
  `UPDATE match_players SET rating_after = ? WHERE match_id = ? AND seat = ?`,
);
export const getMatchStmt = sqlite.prepare(`SELECT * FROM matches WHERE id = ?`);
export const getMatchPlayersStmt = sqlite.prepare(
  `SELECT mp.*, u.username FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY mp.seat`,
);
export const getMatchActionsStmt = sqlite.prepare(
  `SELECT * FROM match_actions WHERE match_id = ? ORDER BY seq`,
);

/**
 * Live matches exist only in process memory: any row still 'active' at boot
 * belonged to a previous process and can never finish. Abandoning them keeps
 * the table truthful (abandoned matches settle no elo and no coins).
 * Returns the number of rows cleaned up.
 */
export function abandonStaleMatches(): number {
  const result = sqlite
    .prepare(
      `UPDATE matches SET status = 'abandoned', completed_at = datetime('now') WHERE status = 'active'`,
    )
    .run();
  return result.changes;
}
