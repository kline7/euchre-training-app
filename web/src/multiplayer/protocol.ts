/** Wire protocol shared with the server (mirror of server/ws.ts + match.ts). */

export interface CardData {
  suit: number; // 0=H 1=D 2=C 3=S
  rank: number; // 0=9 1=10 2=J 3=Q 4=K 5=A
}

export interface TrickCardData {
  seat: number;
  card: CardData;
}

export interface Profile {
  id: number;
  username: string;
  isGuest: boolean;
  elo: number;
  division: string;
  gamesPlayed: number;
  wins: number;
  coins: number;
}

export interface PartyMemberView {
  username: string;
  elo: number;
  division: string;
  leader: boolean;
}

export interface PartyView {
  members: PartyMemberView[];
  teamElo: number | null;
  teamDivision: string | null;
  teamRecord: { gamesPlayed: number; wins: number } | null;
  full: boolean;
}

export interface MatchPlayerView {
  seat: number;
  username: string;
  elo: number;
  connected: boolean;
}

export interface BidLogEntry {
  seat: number;
  bid: number;
}

export interface MatchState {
  type: 'state';
  matchId: number;
  yourSeat: number;
  handNumber: number;
  phase: number;
  players: MatchPlayerView[];
  hand: CardData[];
  handCounts: number[];
  legalPlays: CardData[];
  nextToPlay: number;
  trump: number;
  upcard: CardData;
  dealer: number;
  maker: number;
  trickNumber: number;
  currentTrick: TrickCardData[];
  tricksWon: [number, number];
  scores: [number, number];
  alone: boolean;
  sittingOut: number;
  turnedDownSuit: number;
  bidLog: BidLogEntry[];
  turnDeadline: number | null;
  paused: boolean;
}

export interface HandResultMsg {
  type: 'hand_result';
  points: number;
  isEuchre: boolean;
  isSweep: boolean;
  makerTeam: number;
  scores: [number, number];
}

export interface GameOverResult {
  seat: number;
  username: string;
  eloBefore: number;
  eloAfter: number;
  eloDelta: number;
  coinsAwarded: number;
}

export interface GameOverMsg {
  type: 'game_over';
  winningTeam: number;
  scores: [number, number];
  results: GameOverResult[];
}

export interface PresenceStats {
  online: number;
  inQueue: number;
  inGame: number;
}

export type ServerMessage =
  | { type: 'auth_ok'; profile: Profile }
  | ({ type: 'presence' } & PresenceStats)
  | { type: 'queue_status'; position: number; waitedMs: number }
  | { type: 'queue_left' }
  | { type: 'team_queue_joined' }
  | { type: 'match_found'; matchId: number; seat: number }
  | { type: 'party_update'; party: PartyView | null }
  | { type: 'party_invite_received'; from: string }
  | { type: 'party_invite_sent'; to: string }
  | { type: 'party_invite_declined'; by: string }
  | MatchState
  | HandResultMsg
  | GameOverMsg
  | { type: 'error'; message: string }
  | { type: 'opponent_connection'; seat: number; connected: boolean }
  | { type: 'pong' };

export type ClientAction =
  | { type: 'bid'; bid: number }
  | { type: 'play'; card: CardData }
  | { type: 'discard'; card: CardData };

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'queue_join' }
  | { type: 'queue_leave' }
  | { type: 'action'; action: ClientAction }
  | { type: 'party_invite'; username: string }
  | { type: 'party_respond'; accept: boolean }
  | { type: 'party_leave' }
  | { type: 'team_queue_join' }
  | { type: 'team_queue_leave' }
  | { type: 'team_play_ai'; difficulty: number }
  | { type: 'ping' };
