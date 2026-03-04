import Dexie, { type EntityTable } from 'dexie';

export interface CardRecord {
  suit: number;
  rank: number;
}

export interface PlayRecord {
  seat: number;
  card: CardRecord;
}

export interface BidRecord {
  seat: number;
  action: number; // 0=Pass, 1=OrderUp, 2-5=CallSuit, 6=GoAlone
}

export interface HandResult {
  tricks: [number, number];
  points: number;
  isEuchre: boolean;
  isSweep: boolean;
}

export interface HandRecord {
  deal: CardRecord[][];
  bids: BidRecord[];
  plays: PlayRecord[];
  result: HandResult;
}

export interface DecisionRecord {
  trickNumber: number;
  played: CardRecord;
  optimal: CardRecord;
  wpc: number;
  etd: number;
  grade: string;
}

export interface HandAnalysisRecord {
  decisions: DecisionRecord[];
  totalWpc: number;
  totalEtd: number;
}

export interface GameRecord {
  id?: number;
  createdAt: Date;
  seed: number;
  difficulty: number;
  hands: HandRecord[];
  finalScore: [number, number];
  analysis?: HandAnalysisRecord[];
}

export interface SettingRecord {
  key: string;
  value: string;
}

const db = new Dexie('euchre-trainer') as Dexie & {
  games: EntityTable<GameRecord, 'id'>;
  settings: EntityTable<SettingRecord, 'key'>;
};

db.version(1).stores({
  games: '++id, createdAt',
  settings: 'key',
});

export { db };
