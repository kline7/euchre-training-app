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
  /** True if the maker played alone (3 plays per trick). Absent in old records. */
  alone?: boolean;
  result: HandResult;
}

export interface DecisionRecord {
  trickNumber: number;
  /**
   * Index within HandRecord.plays of the play this decision corresponds to.
   * Decisions exist only for human plays with >1 legal option.
   * Absent in records saved before this field existed.
   */
  playIndex?: number;
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
  id: number;
  createdAt: string;
  seed: number;
  difficulty: number;
  hands: HandRecord[];
  finalScore: [number, number];
  analysis?: HandAnalysisRecord[];
}
