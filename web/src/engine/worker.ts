import * as Comlink from 'comlink';

// The Engine class is imported from the WASM module
// This will be set up once wasm-bindgen generates the JS glue
let Engine: any = null;
let engine: any = null;

const api = {
  async init(config: {
    seed: number;
    difficulty: number;
    dealer: number;
    scores: [number, number];
  }) {
    if (!Engine) {
      // Dynamic import of WASM module (built by wasm-bindgen CLI)
      const wasm = await import('@engine/euchre_engine');
      // Initialize the WASM runtime before using any exports
      await wasm.default();
      Engine = wasm.Engine;
    }
    engine = new Engine(config);
    return true;
  },

  phase(): number {
    return engine.phase();
  },

  getHand(seat: number) {
    return engine.get_hand(seat);
  },

  getLegalPlays() {
    return engine.get_legal_plays();
  },

  nextToPlay(): number {
    return engine.next_to_play();
  },

  playCard(card: { suit: number; rank: number }) {
    engine.play_card(card);
  },

  getAiPlay() {
    return engine.get_ai_play();
  },

  async getAiBid(): Promise<number> {
    return engine.get_ai_bid();
  },

  applyBid(bidVal: number) {
    engine.apply_bid(bidVal);
  },

  dealerDiscard(card: { suit: number; rank: number }) {
    engine.dealer_discard(card);
  },

  getAiDiscard() {
    return engine.get_ai_discard();
  },

  collectTrick() {
    engine.collect_trick();
  },

  hasCompletedTrick(): boolean {
    return engine.has_completed_trick();
  },

  evaluatePlays(numDeterminizations: number, seed: number) {
    return engine.evaluate_plays(numDeterminizations, BigInt(seed));
  },

  analyzeDecision(pimcResult: any, playedCard: { suit: number; rank: number }) {
    return engine.analyze_decision(pimcResult, playedCard);
  },

  currentTrick() {
    return engine.current_trick();
  },

  tricksWon() {
    return engine.tricks_won();
  },

  scores() {
    return engine.scores();
  },

  upcard() {
    return engine.upcard();
  },

  trump(): number {
    return engine.trump();
  },

  dealer(): number {
    return engine.dealer();
  },

  maker(): number {
    return engine.maker();
  },

  isAlone(): boolean {
    return engine.is_alone();
  },

  sittingOut(): number {
    return engine.sitting_out();
  },

  trickNumber(): number {
    return engine.trick_number();
  },

  scoreHand() {
    return engine.score_hand();
  },
};

export type EngineAPI = typeof api;

Comlink.expose(api);
