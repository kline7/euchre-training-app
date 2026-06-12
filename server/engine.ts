import { createRequire } from 'node:module';

/**
 * Typed wrapper around the Rust euchre engine (wasm-pack nodejs build).
 * The server runs the SAME rules authority as the browser client, so every
 * client-submitted action is validated against identical logic.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require('../engine/pkg-node/euchre_engine.js');

export interface CardData {
  suit: number; // 0=H 1=D 2=C 3=S
  rank: number; // 0=9 1=10 2=J 3=Q 4=K 5=A
}

export interface TrickCardData {
  seat: number;
  card: CardData;
}

export enum Phase {
  Dealing = 0,
  BiddingRound1 = 1,
  BiddingRound2 = 2,
  DealerDiscard = 3,
  Playing = 4,
  HandScoring = 5,
  GameOver = 6,
}

/** Raw WASM engine class shape (generated types are `any`-heavy). */
interface WasmEngine {
  free(): void;
  phase(): number;
  get_hand(seat: number): CardData[];
  get_legal_plays(): CardData[];
  next_to_play(): number;
  play_card(card: CardData): void;
  has_completed_trick(): boolean;
  get_ai_play(): CardData;
  get_ai_bid(): number;
  is_alone(): boolean;
  sitting_out(): number;
  turned_down_suit(): number;
  apply_bid(bidVal: number): void;
  dealer_discard(card: CardData): void;
  get_ai_discard(): CardData;
  current_trick(): TrickCardData[];
  collect_trick(): void;
  tricks_won(): [number, number];
  scores(): [number, number];
  upcard(): CardData;
  trump(): number;
  dealer(): number;
  maker(): number;
  trick_number(): number;
  winner(): number;
  score_hand(): [number, boolean, boolean];
}

interface EngineConfig {
  seed: number;
  difficulty: number;
  dealer: number;
  scores: [number, number];
  /** House rule: trump may not be led until broken (default true). */
  trump_must_be_broken?: boolean;
}

export class HandEngine {
  private engine: WasmEngine;

  constructor(config: EngineConfig) {
    this.engine = new wasm.Engine(config) as WasmEngine;
  }

  free() {
    this.engine.free();
  }

  get phase(): Phase {
    return this.engine.phase() as Phase;
  }

  handOf(seat: number): CardData[] {
    return this.engine.get_hand(seat);
  }

  legalPlays(): CardData[] {
    return this.engine.get_legal_plays();
  }

  nextToPlay(): number {
    return this.engine.next_to_play();
  }

  playCard(card: CardData): void {
    this.engine.play_card(card);
  }

  hasCompletedTrick(): boolean {
    return this.engine.has_completed_trick();
  }

  collectTrick(): void {
    this.engine.collect_trick();
  }

  aiPlay(): CardData {
    return this.engine.get_ai_play();
  }

  aiBid(): number {
    return this.engine.get_ai_bid();
  }

  aiDiscard(): CardData {
    return this.engine.get_ai_discard();
  }

  applyBid(bidVal: number): void {
    this.engine.apply_bid(bidVal);
  }

  dealerDiscard(card: CardData): void {
    this.engine.dealer_discard(card);
  }

  currentTrick(): TrickCardData[] {
    return this.engine.current_trick();
  }

  scoreHand(): { points: number; isEuchre: boolean; isSweep: boolean } {
    const [points, isEuchre, isSweep] = this.engine.score_hand();
    return { points, isEuchre, isSweep };
  }

  snapshot() {
    return {
      phase: this.phase,
      nextToPlay: this.engine.next_to_play(),
      trump: this.engine.trump(),
      upcard: this.engine.upcard(),
      dealer: this.engine.dealer(),
      maker: this.engine.maker(),
      trickNumber: this.engine.trick_number(),
      currentTrick: this.engine.current_trick(),
      tricksWon: this.engine.tricks_won(),
      scores: this.engine.scores(),
      alone: this.engine.is_alone(),
      sittingOut: this.engine.sitting_out(),
      turnedDownSuit: this.engine.turned_down_suit(),
      winner: this.engine.winner(),
    };
  }
}
