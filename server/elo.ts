/**
 * Team Elo for 2v2 euchre. Each team is rated as the average of its two
 * members; every member of a team receives the same (rounded) delta.
 */

export const DEFAULT_ELO = 1200;
export const K_FACTOR = 32;
/** Milk coins awarded to each winning player. */
export const WIN_COIN_REWARD = 25;

export function expectedScore(ownTeamElo: number, oppTeamElo: number): number {
  return 1 / (1 + Math.pow(10, (oppTeamElo - ownTeamElo) / 400));
}

export interface EloUpdate {
  /** Delta applied to each member of team 0 (negated for team 1). */
  team0Delta: number;
}

/**
 * Compute the per-player Elo delta for a finished match.
 * @param team0Elos ratings of the two players on team 0
 * @param team1Elos ratings of the two players on team 1
 * @param winningTeam 0 or 1
 */
export function computeEloDeltas(
  team0Elos: [number, number],
  team1Elos: [number, number],
  winningTeam: 0 | 1,
): EloUpdate {
  const t0 = (team0Elos[0] + team0Elos[1]) / 2;
  const t1 = (team1Elos[0] + team1Elos[1]) / 2;
  const expected0 = expectedScore(t0, t1);
  const actual0 = winningTeam === 0 ? 1 : 0;
  const delta = Math.round(K_FACTOR * (actual0 - expected0));
  return { team0Delta: delta };
}

/** Elo can never drop below the floor (keeps beginners in matchmaking range). */
export const ELO_FLOOR = 100;

export function applyDelta(elo: number, delta: number): number {
  return Math.max(ELO_FLOOR, elo + delta);
}

// --- Divisions ---
// One ladder shared by individual players and pre-made teams: any elo maps
// to a division. New accounts (1200) start in Silver.

export interface Division {
  name: string;
  minElo: number;
}

export const DIVISIONS: Division[] = [
  { name: 'Bronze', minElo: 0 },
  { name: 'Silver', minElo: 1100 },
  { name: 'Gold', minElo: 1300 },
  { name: 'Platinum', minElo: 1500 },
  { name: 'Diamond', minElo: 1700 },
  { name: 'Master', minElo: 1900 },
];

export function divisionFor(elo: number): string {
  let current = DIVISIONS[0].name;
  for (const d of DIVISIONS) {
    if (elo >= d.minElo) current = d.name;
  }
  return current;
}
