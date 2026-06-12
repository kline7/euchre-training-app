import * as Comlink from 'comlink';

// --- Typed boundary for the wasm-bindgen Engine ---
// The generated .d.ts uses JsValue (= any) for serde-bridged values; this
// interface narrows them to the shapes the engine actually produces/accepts.

export interface EngineCard {
  suit: number;
  rank: number;
}

export interface EngineTrickCard {
  seat: number;
  card: EngineCard;
}

export interface EngineDecisionAnalysis {
  played: EngineCard;
  optimal: EngineCard;
  wpc: number;
  etd: number;
  grade: string;
}

export interface EngineConfig {
  seed: number;
  difficulty: number;
  dealer: number;
  scores: [number, number];
}

/** Opaque PIMC evaluation result — produced by evaluatePlays, consumed by analyzeDecision. */
export type PimcResult = unknown;

interface WasmEngine {
  free(): void;
  phase(): number;
  get_hand(seat: number): EngineCard[];
  get_legal_plays(): EngineCard[];
  next_to_play(): number;
  play_card(card: EngineCard): void;
  get_ai_play(): EngineCard;
  get_ai_bid(): number;
  apply_bid(bidVal: number): void;
  dealer_discard(card: EngineCard): void;
  get_ai_discard(): EngineCard;
  collect_trick(): void;
  has_completed_trick(): boolean;
  evaluate_plays(numDeterminizations: number, seed: bigint): PimcResult;
  analyze_decision(pimcResult: PimcResult, playedCard: EngineCard): EngineDecisionAnalysis;
  current_trick(): EngineTrickCard[];
  tricks_won(): [number, number];
  scores(): [number, number];
  upcard(): EngineCard | null;
  trump(): number;
  dealer(): number;
  maker(): number;
  is_alone(): boolean;
  sitting_out(): number;
  trick_number(): number;
  /** Returns [maker_points, is_euchre, is_sweep]. Throws if called twice or out of phase. */
  score_hand(): [number, boolean, boolean];
  /** Turned-down suit from round 1 (-1 if still in round 1). */
  turned_down_suit(): number;
  /** Winning team (0 or 1), or -1 if the game is not over. */
  winner(): number;
}

type WasmEngineCtor = new (config: EngineConfig) => WasmEngine;

let EngineCtor: WasmEngineCtor | null = null;
let engine: WasmEngine | null = null;

function requireEngine(): WasmEngine {
  if (!engine) throw new Error('Engine not initialized');
  return engine;
}

const api = {
  async init(config: EngineConfig): Promise<boolean> {
    let ctor = EngineCtor;
    if (!ctor) {
      // Dynamic import of WASM module (built by wasm-bindgen CLI)
      const wasm = await import('@engine/euchre_engine');
      // Initialize the WASM runtime before using any exports
      await wasm.default();
      ctor = wasm.Engine as unknown as WasmEngineCtor;
      EngineCtor = ctor;
    }
    // Free the previous instance to avoid leaking WASM memory
    if (engine) {
      engine.free();
      engine = null;
    }
    engine = new ctor(config);
    return true;
  },

  phase(): number {
    return requireEngine().phase();
  },

  getHand(seat: number): EngineCard[] {
    return requireEngine().get_hand(seat);
  },

  getLegalPlays(): EngineCard[] {
    return requireEngine().get_legal_plays();
  },

  nextToPlay(): number {
    return requireEngine().next_to_play();
  },

  playCard(card: EngineCard): void {
    requireEngine().play_card(card);
  },

  getAiPlay(): EngineCard {
    return requireEngine().get_ai_play();
  },

  getAiBid(): number {
    return requireEngine().get_ai_bid();
  },

  applyBid(bidVal: number): void {
    requireEngine().apply_bid(bidVal);
  },

  dealerDiscard(card: EngineCard): void {
    requireEngine().dealer_discard(card);
  },

  getAiDiscard(): EngineCard {
    return requireEngine().get_ai_discard();
  },

  collectTrick(): void {
    requireEngine().collect_trick();
  },

  hasCompletedTrick(): boolean {
    return requireEngine().has_completed_trick();
  },

  evaluatePlays(numDeterminizations: number, seed: number): PimcResult {
    return requireEngine().evaluate_plays(numDeterminizations, BigInt(seed));
  },

  analyzeDecision(pimcResult: PimcResult, playedCard: EngineCard): EngineDecisionAnalysis {
    return requireEngine().analyze_decision(pimcResult, playedCard);
  },

  currentTrick(): EngineTrickCard[] {
    return requireEngine().current_trick();
  },

  tricksWon(): [number, number] {
    return requireEngine().tricks_won();
  },

  scores(): [number, number] {
    return requireEngine().scores();
  },

  upcard(): EngineCard | null {
    return requireEngine().upcard();
  },

  trump(): number {
    return requireEngine().trump();
  },

  dealer(): number {
    return requireEngine().dealer();
  },

  maker(): number {
    return requireEngine().maker();
  },

  isAlone(): boolean {
    return requireEngine().is_alone();
  },

  sittingOut(): number {
    return requireEngine().sitting_out();
  },

  trickNumber(): number {
    return requireEngine().trick_number();
  },

  scoreHand(): [number, boolean, boolean] {
    return requireEngine().score_hand();
  },

  turnedDownSuit(): number {
    return requireEngine().turned_down_suit();
  },

  winner(): number {
    return requireEngine().winner();
  },
};

export type EngineAPI = typeof api;

Comlink.expose(api);
