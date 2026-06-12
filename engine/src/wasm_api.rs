use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

use crate::game::card::{Card, Suit, Rank};
use crate::game::engine::CoreEngine;
use crate::game::state::{GamePhase, BidAction, TrickCard};
use crate::game::rules;
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

/// Strict card parsing — rejects out-of-range suit/rank instead of
/// silently coercing them.
fn js_to_card(js: &JsCard) -> Result<Card, JsError> {
    let suit = match js.suit {
        0 => Suit::Hearts,
        1 => Suit::Diamonds,
        2 => Suit::Clubs,
        3 => Suit::Spades,
        other => return Err(JsError::new(&format!("Invalid suit: {}", other))),
    };
    let rank = match js.rank {
        0 => Rank::Nine,
        1 => Rank::Ten,
        2 => Rank::Jack,
        3 => Rank::Queen,
        4 => Rank::King,
        5 => Rank::Ace,
        other => return Err(JsError::new(&format!("Invalid rank: {}", other))),
    };
    Ok(Card::new(suit, rank))
}

fn parse_card(card_js: JsValue) -> Result<Card, JsError> {
    let js_card: JsCard = serde_wasm_bindgen::from_value(card_js)
        .map_err(|e| JsError::new(&format!("Invalid card: {}", e)))?;
    js_to_card(&js_card)
}

fn js_to_difficulty(d: u8) -> Difficulty {
    match d {
        0 => Difficulty::Novice,
        1 => Difficulty::Intermediate,
        2 => Difficulty::Advanced,
        _ => Difficulty::Expert,
    }
}

fn suit_from_u8(v: u8) -> Suit {
    match v {
        0 => Suit::Hearts,
        1 => Suit::Diamonds,
        2 => Suit::Clubs,
        _ => Suit::Spades,
    }
}

/// Decode the JS bid encoding into a BidAction.
/// 0=Pass, 1=OrderUp, 2-5=CallSuit(H/D/C/S), 6=OrderUpAlone(R1),
/// 7-10=CallSuitAlone(H/D/C/S)(R2)
fn decode_bid(bid_val: u8) -> Result<BidAction, JsError> {
    match bid_val {
        0 => Ok(BidAction::Pass),
        1 => Ok(BidAction::OrderUp),
        2..=5 => Ok(BidAction::CallSuit(suit_from_u8(bid_val - 2))),
        6 => Ok(BidAction::GoAlone),
        7..=10 => Ok(BidAction::GoAloneCall(suit_from_u8(bid_val - 7))),
        other => Err(JsError::new(&format!("Invalid bid value: {}", other))),
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

/// Persistent engine state held in WASM memory. Thin validated wrapper
/// over `CoreEngine`, which is the rules authority.
#[wasm_bindgen]
pub struct Engine {
    core: CoreEngine,
    difficulty: Difficulty,
}

#[wasm_bindgen]
impl Engine {
    /// Create a new engine and deal a hand.
    #[wasm_bindgen(constructor)]
    pub fn new(config_js: JsValue) -> Result<Engine, JsError> {
        let config: JsGameConfig = serde_wasm_bindgen::from_value(config_js)
            .map_err(|e| JsError::new(&format!("Invalid config: {}", e)))?;

        console_error_panic_hook::set_once();

        let core = CoreEngine::new(config.seed, config.dealer, config.scores)
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(Engine {
            core,
            difficulty: js_to_difficulty(config.difficulty),
        })
    }

    /// Get the current game phase as a number.
    pub fn phase(&self) -> u8 {
        match self.core.state.phase {
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
    pub fn get_hand(&self, seat: u8) -> Result<JsValue, JsError> {
        if seat > 3 {
            return Err(JsError::new(&format!("Invalid seat: {}", seat)));
        }
        let cards: Vec<JsCard> = self.core.state.hands[seat as usize].iter()
            .map(card_to_js)
            .collect();
        Ok(serde_wasm_bindgen::to_value(&cards).unwrap())
    }

    /// Get legal plays for the current player.
    pub fn get_legal_plays(&self) -> JsValue {
        let seat = self.core.state.next_to_play();
        let hand = self.core.state.hands[seat as usize];
        let legal = rules::legal_plays(hand, &self.core.state);
        let cards: Vec<JsCard> = legal.iter().map(card_to_js).collect();
        serde_wasm_bindgen::to_value(&cards).unwrap()
    }

    /// Get the seat index of the next player to act.
    pub fn next_to_play(&self) -> u8 {
        self.core.next_actor()
    }

    /// Play a card for the current player. Rejects plays out of phase,
    /// cards not held, and follow-suit violations.
    pub fn play_card(&mut self, card_js: JsValue) -> Result<(), JsError> {
        let card = parse_card(card_js)?;
        self.core.play_card(card).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Whether a completed trick snapshot is waiting to be displayed.
    pub fn has_completed_trick(&self) -> bool {
        !self.core.last_completed_trick.is_empty()
    }

    /// Get AI's chosen play for the current position.
    pub fn get_ai_play(&mut self) -> JsValue {
        let card = choose_play(&self.core.state, self.difficulty, &mut self.core.rng);
        serde_wasm_bindgen::to_value(&card_to_js(card)).unwrap()
    }

    /// Get AI's chosen bid for the current position.
    /// Returns: 0=Pass, 1=OrderUp, 2-5=CallSuit(H/D/C/S),
    ///          6=OrderUpAlone(R1), 7-10=CallSuitAlone(H/D/C/S)(R2)
    pub fn get_ai_bid(&mut self) -> u8 {
        let bid = choose_bid_for(
            &self.core.state,
            self.difficulty,
            &mut self.core.rng,
            self.core.bid_seat,
        );
        match bid {
            BidAction::Pass => 0,
            BidAction::OrderUp => 1,
            BidAction::CallSuit(suit) => 2 + suit as u8,
            BidAction::GoAlone => {
                if self.core.state.phase == GamePhase::BiddingRound1 {
                    6 // Order up alone
                } else {
                    // AI never returns bare GoAlone in round 2; pass defensively
                    // rather than emitting an order-up that the engine would reject.
                    0
                }
            }
            BidAction::GoAloneCall(suit) => 7 + suit as u8,
        }
    }

    /// Is this hand being played alone?
    pub fn is_alone(&self) -> bool {
        self.core.state.alone
    }

    /// Get the seat that is sitting out (-1 if none).
    pub fn sitting_out(&self) -> i8 {
        match self.core.state.sitting_out {
            Some(seat) => seat as i8,
            None => -1,
        }
    }

    /// The turned-down suit from round 1 (-1 if still in round 1).
    pub fn turned_down_suit(&self) -> i8 {
        match self.core.turned_down_suit {
            Some(suit) => suit as i8,
            None => -1,
        }
    }

    /// Apply a bid action. Enforces phase, stick-the-dealer, and the
    /// turned-down suit rule.
    /// bid_val: 0=Pass, 1=OrderUp, 2-5=CallSuit(H/D/C/S),
    ///          6=OrderUpAlone(R1), 7-10=CallSuitAlone(H/D/C/S)(R2)
    pub fn apply_bid(&mut self, bid_val: u8) -> Result<(), JsError> {
        let bid = decode_bid(bid_val)?;
        self.core.apply_bid(bid).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Dealer discards a specific card (called by UI after human chooses).
    /// Transitions from DealerDiscard → Playing.
    pub fn dealer_discard(&mut self, card_js: JsValue) -> Result<(), JsError> {
        let card = parse_card(card_js)?;
        self.core.dealer_discard(card).map_err(|e| JsError::new(&e.to_string()))
    }

    /// AI chooses the weakest card to discard. Returns it as JsValue.
    pub fn get_ai_discard(&self) -> JsValue {
        let dealer = self.core.state.dealer as usize;
        let hand = self.core.state.hands[dealer];
        let trump = self.core.state.trump;

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
        let result = pimc::evaluate_plays(&self.core.state, num_determinizations, seed);
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
    pub fn analyze_decision(&mut self, pimc_js: JsValue, played_js: JsValue) -> Result<JsValue, JsError> {
        let pimc_result: JsPimcResult = serde_wasm_bindgen::from_value(pimc_js)
            .map_err(|e| JsError::new(&format!("Invalid PIMC result: {}", e)))?;
        let played_card: JsCard = serde_wasm_bindgen::from_value(played_js)
            .map_err(|e| JsError::new(&format!("Invalid card: {}", e)))?;
        let played = js_to_card(&played_card)?;

        // Convert back to internal types
        let mut evaluations = Vec::with_capacity(pimc_result.evaluations.len());
        for e in &pimc_result.evaluations {
            evaluations.push(pimc::EvalResult {
                card: js_to_card(&e.card)?,
                expected_tricks: e.expected_tricks,
                win_probability: e.win_probability,
                expected_points: e.expected_points,
                determinizations: pimc_result.total_determinizations,
            });
        }
        let pimc = pimc::PimcResult {
            evaluations,
            total_determinizations: pimc_result.total_determinizations,
            total_nodes: pimc_result.total_nodes,
        };

        let analysis = blunder::analyze_decision(&pimc, played);

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
        Ok(serde_wasm_bindgen::to_value(&js_analysis).unwrap())
    }

    /// Get the current trick cards as [{seat, card}, ...].
    /// If a trick just completed, returns the completed trick snapshot instead.
    pub fn current_trick(&self) -> JsValue {
        let source: &[TrickCard] = if !self.core.last_completed_trick.is_empty() {
            &self.core.last_completed_trick
        } else {
            &self.core.state.current_trick
        };
        let trick: Vec<JsTrickCard> = source.iter()
            .map(|tc| JsTrickCard { seat: tc.seat, card: card_to_js(tc.card) })
            .collect();
        serde_wasm_bindgen::to_value(&trick).unwrap()
    }

    /// Clear the completed trick snapshot so the next syncState shows fresh state.
    pub fn collect_trick(&mut self) {
        self.core.collect_trick();
    }

    /// Get trick scores [team0, team1].
    pub fn tricks_won(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.core.state.tricks_won).unwrap()
    }

    /// Get game scores [team0, team1].
    pub fn scores(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.core.state.scores).unwrap()
    }

    /// Get the upcard.
    pub fn upcard(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&card_to_js(self.core.state.upcard)).unwrap()
    }

    /// Get trump suit (0-3).
    pub fn trump(&self) -> u8 {
        self.core.state.trump as u8
    }

    /// Get dealer seat.
    pub fn dealer(&self) -> u8 {
        self.core.state.dealer
    }

    /// Get maker seat.
    pub fn maker(&self) -> u8 {
        self.core.state.maker
    }

    /// Get the current trick number (1-5).
    pub fn trick_number(&self) -> u8 {
        self.core.state.trick_number
    }

    /// Winning team (0 or 1), or -1 if the game is not over.
    pub fn winner(&self) -> i8 {
        match self.core.winner() {
            Some(team) => team as i8,
            None => -1,
        }
    }

    /// Score the completed hand exactly once, apply to game scores.
    /// Returns [maker_points, is_euchre, is_sweep]. Transitions the phase
    /// to GameOver when a team reaches 10.
    pub fn score_hand(&mut self) -> Result<JsValue, JsError> {
        let score = self.core.score_hand().map_err(|e| JsError::new(&e.to_string()))?;
        let result = (score.points, score.is_euchre, score.is_sweep);
        Ok(serde_wasm_bindgen::to_value(&result).unwrap())
    }
}
