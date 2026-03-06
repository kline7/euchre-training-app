use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use rand_chacha::ChaCha20Rng;
use rand::SeedableRng;

use crate::game::card::{Card, CardSet, Suit, Rank};
use crate::game::state::{GameState, GamePhase, BidAction, TrickCard, TrickBuf};
use crate::game::rules;
use crate::game::scoring;
use crate::ai::pimc;
use crate::ai::blunder;
use crate::ai::opponents::{Difficulty, choose_play, choose_bid_for};

// --- Serializable types for JS interop ---

#[derive(Serialize, Deserialize)]
pub struct JsCard {
    pub suit: u8,
    pub rank: u8,
}

#[derive(Serialize, Deserialize)]
pub struct JsTrickCard {
    pub seat: u8,
    pub card: JsCard,
}

#[derive(Serialize, Deserialize)]
pub struct JsEvalResult {
    pub card: JsCard,
    pub expected_tricks: f64,
    pub win_probability: f64,
    pub expected_points: f64,
}

#[derive(Serialize, Deserialize)]
pub struct JsPimcResult {
    pub evaluations: Vec<JsEvalResult>,
    pub total_determinizations: u32,
    pub total_nodes: u64,
}

#[derive(Serialize, Deserialize)]
pub struct JsDecisionAnalysis {
    pub played: JsCard,
    pub optimal: JsCard,
    pub wpc: f64,
    pub etd: f64,
    pub grade: String,
    pub evaluations: Vec<JsEvalResult>,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
pub struct JsHandAnalysis {
    pub decisions: Vec<JsDecisionAnalysis>,
    pub total_wpc: f64,
    pub total_etd: f64,
    pub worst_indices: Vec<usize>,
}

#[derive(Serialize, Deserialize)]
pub struct JsGameConfig {
    pub seed: u64,
    pub difficulty: u8, // 0-3
    pub dealer: u8,
    pub scores: [u8; 2],
}

// --- Conversion helpers ---

fn card_to_js(card: Card) -> JsCard {
    JsCard { suit: card.suit as u8, rank: card.rank as u8 }
}

fn js_to_card(js: &JsCard) -> Card {
    let suit = match js.suit {
        0 => Suit::Hearts,
        1 => Suit::Diamonds,
        2 => Suit::Clubs,
        _ => Suit::Spades,
    };
    let rank = match js.rank {
        0 => Rank::Nine,
        1 => Rank::Ten,
        2 => Rank::Jack,
        3 => Rank::Queen,
        4 => Rank::King,
        _ => Rank::Ace,
    };
    Card::new(suit, rank)
}

fn js_to_difficulty(d: u8) -> Difficulty {
    match d {
        0 => Difficulty::Novice,
        1 => Difficulty::Intermediate,
        2 => Difficulty::Advanced,
        _ => Difficulty::Expert,
    }
}

fn grade_to_string(grade: blunder::MoveGrade) -> String {
    match grade {
        blunder::MoveGrade::Best => "best".into(),
        blunder::MoveGrade::Good => "good".into(),
        blunder::MoveGrade::Inaccuracy => "inaccuracy".into(),
        blunder::MoveGrade::Mistake => "mistake".into(),
        blunder::MoveGrade::Blunder => "blunder".into(),
    }
}

/// Persistent engine state held in WASM memory.
#[wasm_bindgen]
pub struct Engine {
    state: GameState,
    rng: ChaCha20Rng,
    difficulty: Difficulty,
    /// Current bidding seat (cycles left of dealer → dealer)
    bid_seat: u8,
    /// How many players have passed this bidding round
    pass_count: u8,
    /// The turned-down suit (from round 1), cannot be called in round 2
    turned_down_suit: Option<Suit>,
    /// Snapshot of last completed trick (for UI to display before clearing)
    last_completed_trick: TrickBuf,
}

#[wasm_bindgen]
impl Engine {
    /// Create a new engine and deal a hand.
    #[wasm_bindgen(constructor)]
    pub fn new(config_js: JsValue) -> Result<Engine, JsError> {
        let config: JsGameConfig = serde_wasm_bindgen::from_value(config_js)
            .map_err(|e| JsError::new(&format!("Invalid config: {}", e)))?;

        console_error_panic_hook::set_once();

        let mut rng = ChaCha20Rng::seed_from_u64(config.seed);
        let hands = deal_hands(&mut rng);
        let upcard = pick_upcard(&hands, &mut rng);
        let state = GameState::new_hand(hands, upcard, config.dealer, config.scores);

        let bid_seat = (config.dealer + 1) % 4; // Left of dealer bids first
        Ok(Engine {
            state,
            rng,
            difficulty: js_to_difficulty(config.difficulty),
            bid_seat,
            pass_count: 0,
            turned_down_suit: None,
            last_completed_trick: TrickBuf::new(),
        })
    }

    /// Get the current game phase as a number.
    pub fn phase(&self) -> u8 {
        match self.state.phase {
            GamePhase::Dealing => 0,
            GamePhase::BiddingRound1 => 1,
            GamePhase::BiddingRound2 => 2,
            GamePhase::DealerDiscard => 3,
            GamePhase::Playing => 4,
            GamePhase::HandScoring => 5,
            GamePhase::GameOver => 6,
        }
    }

    /// Get the hand for a specific seat as an array of JsCard.
    pub fn get_hand(&self, seat: u8) -> JsValue {
        let cards: Vec<JsCard> = self.state.hands[seat as usize].iter()
            .map(card_to_js)
            .collect();
        serde_wasm_bindgen::to_value(&cards).unwrap()
    }

    /// Get legal plays for the current player.
    pub fn get_legal_plays(&self) -> JsValue {
        let seat = self.state.next_to_play();
        let hand = self.state.hands[seat as usize];
        let legal = rules::legal_plays(hand, &self.state);
        let cards: Vec<JsCard> = legal.iter().map(card_to_js).collect();
        serde_wasm_bindgen::to_value(&cards).unwrap()
    }

    /// Get the seat index of the next player to act.
    pub fn next_to_play(&self) -> u8 {
        match self.state.phase {
            GamePhase::BiddingRound1 | GamePhase::BiddingRound2 => self.bid_seat,
            _ => self.state.next_to_play(),
        }
    }

    /// Play a card for the current player.
    pub fn play_card(&mut self, card_js: JsValue) -> Result<(), JsError> {
        let js_card: JsCard = serde_wasm_bindgen::from_value(card_js)
            .map_err(|e| JsError::new(&format!("Invalid card: {}", e)))?;
        let card = js_to_card(&js_card);
        let seat = self.state.next_to_play();

        // Add card to trick first to capture the complete trick snapshot
        let mut preview = self.state;
        preview.current_trick.push(TrickCard { seat, card });
        if preview.trick_complete() {
            self.last_completed_trick = preview.current_trick;
        } else {
            self.last_completed_trick.clear();
        }

        self.state = rules::play_card(&self.state, seat, card);
        Ok(())
    }

    /// Whether a completed trick snapshot is waiting to be displayed.
    pub fn has_completed_trick(&self) -> bool {
        !self.last_completed_trick.is_empty()
    }

    /// Get AI's chosen play for the current position.
    pub fn get_ai_play(&mut self) -> JsValue {
        let card = choose_play(&self.state, self.difficulty, &mut self.rng);
        serde_wasm_bindgen::to_value(&card_to_js(card)).unwrap()
    }

    /// Get AI's chosen bid for the current position.
    /// Returns: 0=Pass, 1=OrderUp, 2-5=CallSuit(H/D/C/S),
    ///          6=OrderUpAlone(R1), 7-10=CallSuitAlone(H/D/C/S)(R2)
    pub fn get_ai_bid(&mut self) -> u8 {
        let bid = choose_bid_for(&self.state, self.difficulty, &mut self.rng, self.bid_seat);
        match bid {
            BidAction::Pass => 0,
            BidAction::OrderUp => 1,
            BidAction::CallSuit(suit) => 2 + suit as u8,
            BidAction::GoAlone => {
                // Map GoAlone to the right value based on bidding round
                if self.state.phase == GamePhase::BiddingRound1 {
                    6 // Order up alone
                } else {
                    // AI chose GoAlone in round 2 — shouldn't happen with current AI
                    // (AI returns GoAlone only from R1 path), but handle gracefully
                    6
                }
            }
            BidAction::GoAloneCall(suit) => 7 + suit as u8,
        }
    }

    /// Is this hand being played alone?
    pub fn is_alone(&self) -> bool {
        self.state.alone
    }

    /// Get the seat that is sitting out (-1 if none).
    pub fn sitting_out(&self) -> i8 {
        match self.state.sitting_out {
            Some(seat) => seat as i8,
            None => -1,
        }
    }

    /// Apply a bid action.
    /// bid_val: 0=Pass, 1=OrderUp, 2-5=CallSuit(H/D/C/S),
    ///          6=OrderUpAlone(R1), 7-10=CallSuitAlone(H/D/C/S)(R2)
    pub fn apply_bid(&mut self, bid_val: u8) {
        let seat = self.bid_seat;
        match bid_val {
            0 => {
                // Pass — advance to next bidder
                self.pass_count += 1;

                if self.state.phase == GamePhase::BiddingRound1 && self.pass_count >= 4 {
                    // All 4 passed in round 1 → move to round 2
                    self.turned_down_suit = Some(self.state.upcard.suit);
                    self.state.phase = GamePhase::BiddingRound2;
                    self.bid_seat = (self.state.dealer + 1) % 4;
                    self.pass_count = 0;
                } else if self.state.phase == GamePhase::BiddingRound2 && self.pass_count >= 4 {
                    // All passed round 2 — shouldn't happen with stuck dealer,
                    // but handle gracefully: re-deal (reset)
                    self.state.phase = GamePhase::BiddingRound1;
                    self.pass_count = 0;
                    self.bid_seat = (self.state.dealer + 1) % 4;
                } else {
                    self.bid_seat = (seat + 1) % 4;
                }
            }
            1 => {
                // Order up — dealer picks up upcard, set trump
                self.state.trump = self.state.upcard.suit;
                self.state.maker = seat;
                // Add upcard to dealer's hand; enter DealerDiscard phase
                let dealer = self.state.dealer as usize;
                self.state.hands[dealer].insert(self.state.upcard);
                self.state.phase = GamePhase::DealerDiscard;
                self.state.lead_seat = (self.state.dealer + 1) % 4;
            }
            2..=5 => {
                // Call suit in round 2
                let suit = match bid_val - 2 {
                    0 => Suit::Hearts,
                    1 => Suit::Diamonds,
                    2 => Suit::Clubs,
                    _ => Suit::Spades,
                };
                self.state.trump = suit;
                self.state.maker = seat;
                self.state.phase = GamePhase::Playing;
                self.state.lead_seat = (self.state.dealer + 1) % 4;
            }
            6 => {
                // GoAlone in Round 1 — order up alone
                self.state.alone = true;
                let partner = (seat + 2) % 4;
                self.state.sitting_out = Some(partner);
                self.state.maker = seat;
                self.state.trump = self.state.upcard.suit;
                let dealer = self.state.dealer as usize;
                self.state.hands[dealer].insert(self.state.upcard);
                self.state.phase = GamePhase::DealerDiscard;
                self.state.lead_seat = (self.state.dealer + 1) % 4;
            }
            7..=10 => {
                // GoAlone in Round 2 — call suit alone
                let suit_idx = (bid_val - 7) as usize;
                let suit = [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades][suit_idx];
                self.state.trump = suit;
                self.state.alone = true;
                let partner = (seat + 2) % 4;
                self.state.sitting_out = Some(partner);
                self.state.maker = seat;
                self.state.phase = GamePhase::Playing;
                self.state.lead_seat = (self.state.dealer + 1) % 4;
            }
            _ => {}
        }
    }

    /// Dealer discards a specific card (called by UI after human chooses).
    /// Transitions from DealerDiscard → Playing.
    pub fn dealer_discard(&mut self, card_js: JsValue) {
        let js_card: JsCard = serde_wasm_bindgen::from_value(card_js).unwrap();
        let card = Card::new(
            Suit::ALL[js_card.suit as usize],
            Rank::ALL[js_card.rank as usize],
        );
        let dealer = self.state.dealer as usize;
        self.state.hands[dealer].remove(card);
        self.state.phase = GamePhase::Playing;
    }

    /// AI chooses the weakest card to discard. Returns it as JsValue.
    pub fn get_ai_discard(&self) -> JsValue {
        let dealer = self.state.dealer as usize;
        let hand = self.state.hands[dealer];
        let trump = self.state.trump;

        let mut weakest: Option<Card> = None;
        let mut weakest_power: u8 = u8::MAX;
        let mut weakest_is_trump = true;

        for card in hand.iter() {
            let is_trump = card.effective_suit(trump) == trump;
            let power = card.trick_power(trump);

            let beats_weakest = match (is_trump, weakest_is_trump) {
                (false, true) => true,     // Non-trump weaker than trump
                (true, false) => false,    // Trump stronger than non-trump
                _ => power < weakest_power, // Same category: lower power = weaker
            };

            if weakest.is_none() || beats_weakest {
                weakest = Some(card);
                weakest_power = power;
                weakest_is_trump = is_trump;
            }
        }

        serde_wasm_bindgen::to_value(&card_to_js(weakest.unwrap())).unwrap()
    }

    /// Run PIMC evaluation for the current position.
    pub fn evaluate_plays(&self, num_determinizations: u32, seed: u64) -> JsValue {
        let result = pimc::evaluate_plays(&self.state, num_determinizations, seed);
        let js_result = JsPimcResult {
            evaluations: result.evaluations.iter().map(|e| JsEvalResult {
                card: card_to_js(e.card),
                expected_tricks: e.expected_tricks,
                win_probability: e.win_probability,
                expected_points: e.expected_points,
            }).collect(),
            total_determinizations: result.total_determinizations,
            total_nodes: result.total_nodes,
        };
        serde_wasm_bindgen::to_value(&js_result).unwrap()
    }

    /// Analyze a decision: given PIMC results and the card played.
    pub fn analyze_decision(&mut self, pimc_js: JsValue, played_js: JsValue) -> JsValue {
        let pimc_result: JsPimcResult = serde_wasm_bindgen::from_value(pimc_js).unwrap();
        let played_card: JsCard = serde_wasm_bindgen::from_value(played_js).unwrap();

        // Convert back to internal types
        let pimc = pimc::PimcResult {
            evaluations: pimc_result.evaluations.iter().map(|e| pimc::EvalResult {
                card: js_to_card(&e.card),
                expected_tricks: e.expected_tricks,
                win_probability: e.win_probability,
                expected_points: e.expected_points,
                determinizations: pimc_result.total_determinizations,
            }).collect(),
            total_determinizations: pimc_result.total_determinizations,
            total_nodes: pimc_result.total_nodes,
        };

        let analysis = blunder::analyze_decision(&pimc, js_to_card(&played_card));

        let js_analysis = JsDecisionAnalysis {
            played: card_to_js(analysis.played),
            optimal: card_to_js(analysis.optimal),
            wpc: analysis.wpc,
            etd: analysis.etd,
            grade: grade_to_string(analysis.grade),
            evaluations: analysis.all_evals.iter().map(|e| JsEvalResult {
                card: card_to_js(e.card),
                expected_tricks: e.expected_tricks,
                win_probability: e.win_probability,
                expected_points: e.expected_points,
            }).collect(),
        };
        serde_wasm_bindgen::to_value(&js_analysis).unwrap()
    }

    /// Get the current trick cards as [{seat, card}, ...].
    /// If a trick just completed, returns the completed trick snapshot instead.
    pub fn current_trick(&self) -> JsValue {
        let source: &[TrickCard] = if !self.last_completed_trick.is_empty() {
            &self.last_completed_trick
        } else {
            &self.state.current_trick
        };
        let trick: Vec<JsTrickCard> = source.iter()
            .map(|tc| JsTrickCard { seat: tc.seat, card: card_to_js(tc.card) })
            .collect();
        serde_wasm_bindgen::to_value(&trick).unwrap()
    }

    /// Clear the completed trick snapshot so the next syncState shows fresh state.
    pub fn collect_trick(&mut self) {
        self.last_completed_trick.clear();
    }

    /// Get trick scores [team0, team1].
    pub fn tricks_won(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.state.tricks_won).unwrap()
    }

    /// Get game scores [team0, team1].
    pub fn scores(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.state.scores).unwrap()
    }

    /// Get the upcard.
    pub fn upcard(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&card_to_js(self.state.upcard)).unwrap()
    }

    /// Get trump suit (0-3).
    pub fn trump(&self) -> u8 {
        self.state.trump as u8
    }

    /// Get dealer seat.
    pub fn dealer(&self) -> u8 {
        self.state.dealer
    }

    /// Get maker seat.
    pub fn maker(&self) -> u8 {
        self.state.maker
    }

    /// Get the current trick number (1-5).
    pub fn trick_number(&self) -> u8 {
        self.state.trick_number
    }

    /// Score the completed hand, apply to game scores. Returns [maker_points, is_euchre, is_sweep].
    pub fn score_hand(&mut self) -> JsValue {
        let score = scoring::score_hand(&self.state);
        self.state.scores = scoring::apply_score(self.state.scores, &score);
        let result = (score.points, score.is_euchre, score.is_sweep);
        serde_wasm_bindgen::to_value(&result).unwrap()
    }
}

// --- Deal helpers ---

fn deal_hands(rng: &mut ChaCha20Rng) -> [CardSet; 4] {
    use rand::prelude::*;

    let mut deck = crate::game::card::euchre_deck();
    deck.shuffle(rng);

    let mut hands = [CardSet::EMPTY; 4];
    for (i, card) in deck.iter().enumerate().take(20) {
        hands[i / 5].insert(*card);
    }
    hands
}

fn pick_upcard(hands: &[CardSet; 4], rng: &mut ChaCha20Rng) -> Card {
    use rand::prelude::*;

    // Upcard is from the remaining 4 cards (indices 20-23)
    let mut all = CardSet::FULL_DECK;
    for hand in hands {
        all = all.difference(*hand);
    }
    let remaining: Vec<Card> = all.iter().collect();
    *remaining.choose(rng).unwrap()
}
