use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;

use crate::game::card::{Card, CardSet, Suit};
use crate::game::rules;
use crate::game::scoring::{self, HandScore};
use crate::game::state::{BidAction, GamePhase, GameState, Seat, TrickBuf, TrickCard};

/// Errors returned when a client submits an illegal action.
/// These are the rules-authority boundary: every action is validated here,
/// so untrusted clients (including future multiplayer clients) cannot
/// corrupt game state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineError {
    WrongPhase,
    BidNotAllowed(&'static str),
    CardNotInHand,
    MustFollowSuit,
    NotYourTurn,
    HandAlreadyScored,
    InvalidInput(&'static str),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::WrongPhase => write!(f, "action not allowed in current phase"),
            EngineError::BidNotAllowed(msg) => write!(f, "illegal bid: {}", msg),
            EngineError::CardNotInHand => write!(f, "card is not in player's hand"),
            EngineError::MustFollowSuit => write!(f, "must follow suit"),
            EngineError::NotYourTurn => write!(f, "not this seat's turn"),
            EngineError::HandAlreadyScored => write!(f, "hand has already been scored"),
            EngineError::InvalidInput(msg) => write!(f, "invalid input: {}", msg),
        }
    }
}

impl std::error::Error for EngineError {}

/// Pure-Rust euchre engine for a single hand. Acts as the rules authority:
/// all transitions are validated. Wrapped by `wasm_api::Engine` for the
/// browser and used directly (via the nodejs WASM build) on the server.
///
/// Variant decisions (standard North American euchre):
/// - Leading any card, including trump, is always legal.
/// - Stick the dealer: the dealer may not pass in round 2.
/// - The turned-down suit may not be named in round 2.
/// - When the maker's partner is the dealer and the maker goes alone in
///   round 1, the dealer sits out and the upcard is NOT picked up.
pub struct CoreEngine {
    pub state: GameState,
    pub rng: ChaCha20Rng,
    /// Current bidding seat (cycles left of dealer → dealer).
    pub bid_seat: Seat,
    /// How many players have passed this bidding round.
    pass_count: u8,
    /// The turned-down suit (from round 1); cannot be called in round 2.
    pub turned_down_suit: Option<Suit>,
    /// Snapshot of last completed trick (for UI to display before clearing).
    pub last_completed_trick: TrickBuf,
    /// Guards score_hand idempotency.
    hand_scored: bool,
}

impl CoreEngine {
    /// Create a new engine and deal a hand with the default house rules
    /// (trump leads require broken trump).
    pub fn new(seed: u64, dealer: Seat, scores: [u8; 2]) -> Result<CoreEngine, EngineError> {
        Self::with_rules(seed, dealer, scores, true)
    }

    /// Create a new engine with an explicit trump-lead rule:
    /// `trump_must_be_broken = false` plays standard euchre (lead anything).
    pub fn with_rules(
        seed: u64,
        dealer: Seat,
        scores: [u8; 2],
        trump_must_be_broken: bool,
    ) -> Result<CoreEngine, EngineError> {
        if dealer > 3 {
            return Err(EngineError::InvalidInput("dealer seat must be 0-3"));
        }
        if scores[0] >= 10 || scores[1] >= 10 {
            return Err(EngineError::InvalidInput("game is already over"));
        }
        let mut rng = ChaCha20Rng::seed_from_u64(seed);
        let hands = deal_hands(&mut rng);
        let upcard = pick_upcard(&hands, &mut rng);
        let mut state = GameState::new_hand(hands, upcard, dealer, scores);
        state.trump_must_be_broken = trump_must_be_broken;

        Ok(CoreEngine {
            state,
            rng,
            bid_seat: (dealer + 1) % 4,
            pass_count: 0,
            turned_down_suit: None,
            last_completed_trick: TrickBuf::new(),
            hand_scored: false,
        })
    }

    /// The seat that must act next (bidding-aware).
    pub fn next_actor(&self) -> Seat {
        match self.state.phase {
            GamePhase::BiddingRound1 | GamePhase::BiddingRound2 => self.bid_seat,
            GamePhase::DealerDiscard => self.state.dealer,
            _ => self.state.next_to_play(),
        }
    }

    /// Apply a bid for the current bidding seat. Validates phase, bid kind,
    /// turned-down suit, and stick-the-dealer.
    pub fn apply_bid(&mut self, bid: BidAction) -> Result<(), EngineError> {
        let seat = self.bid_seat;
        let round1 = match self.state.phase {
            GamePhase::BiddingRound1 => true,
            GamePhase::BiddingRound2 => false,
            _ => return Err(EngineError::WrongPhase),
        };

        match bid {
            BidAction::Pass => {
                if !round1 && seat == self.state.dealer {
                    return Err(EngineError::BidNotAllowed(
                        "stick the dealer: dealer must name a suit in round 2",
                    ));
                }
                self.pass_count += 1;
                if round1 && self.pass_count >= 4 {
                    // All 4 passed in round 1 → turn down the upcard, start round 2
                    self.turned_down_suit = Some(self.state.upcard.suit);
                    self.state.phase = GamePhase::BiddingRound2;
                    self.bid_seat = (self.state.dealer + 1) % 4;
                    self.pass_count = 0;
                } else {
                    self.bid_seat = (seat + 1) % 4;
                }
                Ok(())
            }
            BidAction::OrderUp => {
                if !round1 {
                    return Err(EngineError::BidNotAllowed("cannot order up in round 2"));
                }
                self.set_maker(seat, self.state.upcard.suit, false);
                self.enter_dealer_pickup();
                Ok(())
            }
            BidAction::GoAlone => {
                if !round1 {
                    return Err(EngineError::BidNotAllowed("cannot order up alone in round 2"));
                }
                self.set_maker(seat, self.state.upcard.suit, true);
                // If the sitting-out partner IS the dealer, the dealer's hand is
                // dead: the upcard stays down and play begins immediately.
                if self.state.sitting_out == Some(self.state.dealer) {
                    self.start_play();
                } else {
                    self.enter_dealer_pickup();
                }
                Ok(())
            }
            BidAction::CallSuit(suit) | BidAction::GoAloneCall(suit) => {
                if round1 {
                    return Err(EngineError::BidNotAllowed("cannot name a suit in round 1"));
                }
                if Some(suit) == self.turned_down_suit {
                    return Err(EngineError::BidNotAllowed(
                        "cannot name the turned-down suit",
                    ));
                }
                let alone = matches!(bid, BidAction::GoAloneCall(_));
                self.set_maker(seat, suit, alone);
                self.start_play();
                Ok(())
            }
        }
    }

    fn set_maker(&mut self, seat: Seat, trump: Suit, alone: bool) {
        self.state.trump = trump;
        self.state.maker = seat;
        if alone {
            self.state.alone = true;
            self.state.sitting_out = Some((seat + 2) % 4);
        }
    }

    fn enter_dealer_pickup(&mut self) {
        let dealer = self.state.dealer as usize;
        self.state.hands[dealer].insert(self.state.upcard);
        self.state.phase = GamePhase::DealerDiscard;
        self.state.lead_seat = (self.state.dealer + 1) % 4;
    }

    fn start_play(&mut self) {
        self.state.phase = GamePhase::Playing;
        self.state.lead_seat = (self.state.dealer + 1) % 4;
    }

    /// Dealer discards a card after picking up the upcard.
    pub fn dealer_discard(&mut self, card: Card) -> Result<(), EngineError> {
        if self.state.phase != GamePhase::DealerDiscard {
            return Err(EngineError::WrongPhase);
        }
        let dealer = self.state.dealer as usize;
        if !self.state.hands[dealer].contains(card) {
            return Err(EngineError::CardNotInHand);
        }
        self.state.hands[dealer].remove(card);
        self.state.discard = Some(card);
        self.start_play();
        Ok(())
    }

    /// Play a card for the seat whose turn it is. Enforces phase, card
    /// ownership, and follow-suit legality.
    pub fn play_card(&mut self, card: Card) -> Result<(), EngineError> {
        if self.state.phase != GamePhase::Playing {
            return Err(EngineError::WrongPhase);
        }
        let seat = self.state.next_to_play();
        let hand = self.state.hands[seat as usize];
        if !hand.contains(card) {
            return Err(EngineError::CardNotInHand);
        }
        let legal = rules::legal_plays(hand, &self.state);
        if !legal.contains(card) {
            return Err(EngineError::MustFollowSuit);
        }

        // Capture the completed-trick snapshot before rules::play_card clears it
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

    /// Clear the completed trick snapshot.
    pub fn collect_trick(&mut self) {
        self.last_completed_trick.clear();
    }

    /// Score the completed hand exactly once, apply to game scores, and
    /// transition to GameOver when a team reaches 10.
    pub fn score_hand(&mut self) -> Result<HandScore, EngineError> {
        if self.state.phase != GamePhase::HandScoring {
            return Err(EngineError::WrongPhase);
        }
        if self.hand_scored {
            return Err(EngineError::HandAlreadyScored);
        }
        self.hand_scored = true;
        let score = scoring::score_hand(&self.state);
        self.state.scores = scoring::apply_score(self.state.scores, &score);
        if scoring::is_game_over(self.state.scores).is_some() {
            self.state.phase = GamePhase::GameOver;
        }
        Ok(score)
    }

    /// Winning team (0 or 1) if the game is over.
    pub fn winner(&self) -> Option<u8> {
        scoring::is_game_over(self.state.scores)
    }
}

// --- Deal helpers ---

fn deal_hands(rng: &mut ChaCha20Rng) -> [CardSet; 4] {
    let mut deck = crate::game::card::euchre_deck();
    deck.shuffle(rng);

    let mut hands = [CardSet::EMPTY; 4];
    for (i, card) in deck.iter().enumerate().take(20) {
        hands[i / 5].insert(*card);
    }
    hands
}

fn pick_upcard(hands: &[CardSet; 4], rng: &mut ChaCha20Rng) -> Card {
    // Upcard is from the remaining 4 cards (the kitty)
    let mut all = CardSet::FULL_DECK;
    for hand in hands {
        all = all.difference(*hand);
    }
    let remaining: Vec<Card> = all.iter().collect();
    *remaining.choose(rng).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_with_dealer(dealer: Seat) -> CoreEngine {
        CoreEngine::new(42, dealer, [0, 0]).unwrap()
    }

    fn pass_round_1(engine: &mut CoreEngine) {
        for _ in 0..4 {
            engine.apply_bid(BidAction::Pass).unwrap();
        }
        assert_eq!(engine.state.phase, GamePhase::BiddingRound2);
    }

    /// Order up, complete dealer discard, ready to play.
    fn order_up_and_discard(engine: &mut CoreEngine) {
        engine.apply_bid(BidAction::OrderUp).unwrap();
        assert_eq!(engine.state.phase, GamePhase::DealerDiscard);
        let dealer_hand = engine.state.hands[engine.state.dealer as usize];
        let discard = dealer_hand.iter().next().unwrap();
        engine.dealer_discard(discard).unwrap();
        assert_eq!(engine.state.phase, GamePhase::Playing);
    }

    // --- Construction ---

    #[test]
    fn new_rejects_bad_dealer() {
        assert!(CoreEngine::new(1, 4, [0, 0]).is_err());
    }

    #[test]
    fn new_rejects_finished_game_scores() {
        assert!(CoreEngine::new(1, 0, [10, 0]).is_err());
    }

    #[test]
    fn deal_is_deterministic_for_seed() {
        let a = CoreEngine::new(123, 0, [0, 0]).unwrap();
        let b = CoreEngine::new(123, 0, [0, 0]).unwrap();
        assert_eq!(a.state.hands, b.state.hands);
        assert_eq!(a.state.upcard, b.state.upcard);
    }

    #[test]
    fn deal_gives_five_cards_each_plus_upcard() {
        let engine = engine_with_dealer(0);
        for hand in &engine.state.hands {
            assert_eq!(hand.count(), 5);
        }
        // Upcard must not be in any hand
        for hand in &engine.state.hands {
            assert!(!hand.contains(engine.state.upcard));
        }
    }

    // --- Bidding round 1 ---

    #[test]
    fn bidding_starts_left_of_dealer() {
        let engine = engine_with_dealer(2);
        assert_eq!(engine.next_actor(), 3);
    }

    #[test]
    fn four_passes_moves_to_round_2_and_records_turned_down_suit() {
        let mut engine = engine_with_dealer(0);
        let upcard_suit = engine.state.upcard.suit;
        pass_round_1(&mut engine);
        assert_eq!(engine.turned_down_suit, Some(upcard_suit));
        assert_eq!(engine.bid_seat, 1); // left of dealer starts round 2
    }

    #[test]
    fn order_up_sets_trump_maker_and_dealer_pickup() {
        let mut engine = engine_with_dealer(0);
        let upcard = engine.state.upcard;
        engine.apply_bid(BidAction::OrderUp).unwrap();
        assert_eq!(engine.state.trump, upcard.suit);
        assert_eq!(engine.state.maker, 1);
        assert_eq!(engine.state.phase, GamePhase::DealerDiscard);
        assert!(engine.state.hands[0].contains(upcard));
        assert_eq!(engine.state.hands[0].count(), 6);
    }

    #[test]
    fn cannot_call_suit_in_round_1() {
        let mut engine = engine_with_dealer(0);
        let err = engine.apply_bid(BidAction::CallSuit(Suit::Hearts)).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
        let err = engine.apply_bid(BidAction::GoAloneCall(Suit::Hearts)).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
    }

    // --- Bidding round 2 ---

    #[test]
    fn cannot_order_up_in_round_2() {
        let mut engine = engine_with_dealer(0);
        pass_round_1(&mut engine);
        let err = engine.apply_bid(BidAction::OrderUp).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
        let err = engine.apply_bid(BidAction::GoAlone).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
    }

    #[test]
    fn cannot_call_turned_down_suit() {
        let mut engine = engine_with_dealer(0);
        let turned_down = engine.state.upcard.suit;
        pass_round_1(&mut engine);
        let err = engine.apply_bid(BidAction::CallSuit(turned_down)).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
        let err = engine.apply_bid(BidAction::GoAloneCall(turned_down)).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
    }

    #[test]
    fn stick_the_dealer_dealer_cannot_pass_round_2() {
        let mut engine = engine_with_dealer(0);
        pass_round_1(&mut engine);
        // Seats 1, 2, 3 pass round 2
        engine.apply_bid(BidAction::Pass).unwrap();
        engine.apply_bid(BidAction::Pass).unwrap();
        engine.apply_bid(BidAction::Pass).unwrap();
        assert_eq!(engine.bid_seat, 0); // dealer is stuck
        let err = engine.apply_bid(BidAction::Pass).unwrap_err();
        assert!(matches!(err, EngineError::BidNotAllowed(_)));
        // Dealer can still name a non-turned-down suit
        let turned_down = engine.turned_down_suit.unwrap();
        let suit = [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades]
            .into_iter()
            .find(|&s| s != turned_down)
            .unwrap();
        engine.apply_bid(BidAction::CallSuit(suit)).unwrap();
        assert_eq!(engine.state.phase, GamePhase::Playing);
        assert_eq!(engine.state.trump, suit);
        assert_eq!(engine.state.maker, 0);
    }

    #[test]
    fn call_suit_round_2_starts_play_left_of_dealer() {
        let mut engine = engine_with_dealer(2);
        let turned_down = engine.state.upcard.suit;
        pass_round_1(&mut engine);
        let suit = [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades]
            .into_iter()
            .find(|&s| s != turned_down)
            .unwrap();
        engine.apply_bid(BidAction::CallSuit(suit)).unwrap();
        assert_eq!(engine.state.phase, GamePhase::Playing);
        assert_eq!(engine.state.lead_seat, 3);
        assert_eq!(engine.next_actor(), 3);
    }

    // --- Bid phase guards ---

    #[test]
    fn cannot_bid_during_play() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        let err = engine.apply_bid(BidAction::Pass).unwrap_err();
        assert_eq!(err, EngineError::WrongPhase);
        let err = engine.apply_bid(BidAction::OrderUp).unwrap_err();
        assert_eq!(err, EngineError::WrongPhase);
    }

    // --- Going alone ---

    #[test]
    fn go_alone_partner_sits_out() {
        let mut engine = engine_with_dealer(0);
        // Seat 1 orders up alone — partner is seat 3
        engine.apply_bid(BidAction::GoAlone).unwrap();
        assert!(engine.state.alone);
        assert_eq!(engine.state.sitting_out, Some(3));
        assert_eq!(engine.state.maker, 1);
        // Dealer (seat 0) is not sitting out, so pickup happens
        assert_eq!(engine.state.phase, GamePhase::DealerDiscard);
    }

    #[test]
    fn go_alone_when_dealer_is_sitting_out_skips_pickup() {
        // Dealer 0; bidding starts at seat 1; pass to seat 2, whose partner IS the dealer
        let mut engine = engine_with_dealer(0);
        engine.apply_bid(BidAction::Pass).unwrap();
        let dealer_hand_before = engine.state.hands[0];
        engine.apply_bid(BidAction::GoAlone).unwrap();
        assert_eq!(engine.state.maker, 2);
        assert_eq!(engine.state.sitting_out, Some(0));
        // No pickup: dealer hand unchanged, no discard phase, straight to play
        assert_eq!(engine.state.hands[0], dealer_hand_before);
        assert_eq!(engine.state.phase, GamePhase::Playing);
        assert!(!engine.state.hands[0].contains(engine.state.upcard));
    }

    // --- Dealer discard ---

    #[test]
    fn dealer_discard_requires_phase() {
        let mut engine = engine_with_dealer(0);
        let card = engine.state.hands[0].iter().next().unwrap();
        assert_eq!(engine.dealer_discard(card).unwrap_err(), EngineError::WrongPhase);
    }

    #[test]
    fn dealer_discard_requires_card_in_dealer_hand() {
        let mut engine = engine_with_dealer(0);
        engine.apply_bid(BidAction::OrderUp).unwrap();
        // Find a card NOT in the dealer's hand
        let dealer_hand = engine.state.hands[0];
        let outside = CardSet::FULL_DECK.difference(dealer_hand).iter().next().unwrap();
        assert_eq!(
            engine.dealer_discard(outside).unwrap_err(),
            EngineError::CardNotInHand
        );
        // Dealer still has 6 cards
        assert_eq!(engine.state.hands[0].count(), 6);
    }

    #[test]
    fn dealer_discard_leaves_five_cards_and_starts_play() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        assert_eq!(engine.state.hands[0].count(), 5);
        assert_eq!(engine.state.lead_seat, 1);
    }

    // --- Play validation ---

    #[test]
    fn play_card_rejects_wrong_phase() {
        let mut engine = engine_with_dealer(0);
        let card = engine.state.hands[1].iter().next().unwrap();
        assert_eq!(engine.play_card(card).unwrap_err(), EngineError::WrongPhase);
    }

    #[test]
    fn play_card_rejects_card_not_in_hand() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        let actor = engine.state.next_to_play();
        let not_held = CardSet::FULL_DECK
            .difference(engine.state.hands[actor as usize])
            .iter()
            .next()
            .unwrap();
        assert_eq!(engine.play_card(not_held).unwrap_err(), EngineError::CardNotInHand);
    }

    #[test]
    fn play_card_enforces_follow_suit() {
        // Construct a position where the second player can follow but tries not to
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        // Play whole tricks until we find a player who holds the led suit
        // and another card; then try the illegal one.
        let leader = engine.state.next_to_play();
        let lead_card = rules::legal_plays(engine.state.hands[leader as usize], &engine.state)
            .iter()
            .next()
            .unwrap();
        engine.play_card(lead_card).unwrap();
        let follower = engine.state.next_to_play();
        let hand = engine.state.hands[follower as usize];
        let legal = rules::legal_plays(hand, &engine.state);
        let illegal = hand.difference(legal);
        if let Some(card) = illegal.iter().next() {
            assert_eq!(engine.play_card(card).unwrap_err(), EngineError::MustFollowSuit);
        }
        // A legal card is always accepted
        engine.play_card(legal.iter().next().unwrap()).unwrap();
    }

    #[test]
    fn with_rules_standard_allows_trump_leads() {
        let mut engine = CoreEngine::with_rules(42, 0, [0, 0], false).unwrap();
        order_up_and_discard(&mut engine);
        let leader = engine.state.next_to_play();
        let hand = engine.state.hands[leader as usize];
        // Standard euchre: every card is a legal lead, trump included
        assert_eq!(rules::legal_plays(hand, &engine.state), hand);
    }

    #[test]
    fn trump_lead_blocked_until_broken() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        let leader = engine.state.next_to_play();
        let hand = engine.state.hands[leader as usize];
        let trump_mask =
            CardSet::effective_suit_mask(engine.state.trump, engine.state.trump);
        let non_trump = hand.difference(trump_mask);
        let legal = rules::legal_plays(hand, &engine.state);
        if non_trump.is_empty() {
            // All-trump hand must lead trump
            assert_eq!(legal, hand);
        } else {
            // Trump unbroken: only non-trump leads are legal
            assert_eq!(legal, non_trump);
        }
    }

    // --- Full hand + scoring ---

    /// Play out a full hand with arbitrary legal moves.
    fn play_out_hand(engine: &mut CoreEngine) {
        let mut guard = 0;
        while engine.state.phase == GamePhase::Playing {
            engine.collect_trick();
            let seat = engine.state.next_to_play();
            let legal = rules::legal_plays(engine.state.hands[seat as usize], &engine.state);
            engine.play_card(legal.iter().next().unwrap()).unwrap();
            guard += 1;
            assert!(guard <= 20, "hand did not terminate");
        }
        assert_eq!(engine.state.phase, GamePhase::HandScoring);
    }

    #[test]
    fn full_hand_reaches_scoring_and_scores_once() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        play_out_hand(&mut engine);

        let before = engine.state.scores;
        let score = engine.score_hand().unwrap();
        let after = engine.state.scores;
        assert_ne!(before, after);
        assert_eq!(score.maker_tricks + score.defender_tricks, 5);

        // Second scoring attempt is rejected and does not change scores
        assert_eq!(engine.score_hand().unwrap_err(), EngineError::HandAlreadyScored);
        assert_eq!(engine.state.scores, after);
    }

    #[test]
    fn score_hand_rejected_during_play() {
        let mut engine = engine_with_dealer(0);
        order_up_and_discard(&mut engine);
        assert_eq!(engine.score_hand().unwrap_err(), EngineError::WrongPhase);
    }

    #[test]
    fn game_over_transition_at_10_points() {
        // Start at 9-9 so any hand result ends the game
        let mut engine = CoreEngine::new(7, 0, [9, 9]).unwrap();
        order_up_and_discard(&mut engine);
        play_out_hand(&mut engine);
        engine.score_hand().unwrap();
        assert_eq!(engine.state.phase, GamePhase::GameOver);
        assert!(engine.winner().is_some());
        // No further actions allowed
        let any_card = engine.state.hands.iter().flat_map(|h| h.iter()).next();
        if let Some(card) = any_card {
            assert_eq!(engine.play_card(card).unwrap_err(), EngineError::WrongPhase);
        }
        assert_eq!(engine.apply_bid(BidAction::Pass).unwrap_err(), EngineError::WrongPhase);
    }

    #[test]
    fn alone_hand_plays_with_three_and_terminates() {
        // Find a seed/dealer where going alone via round 1 works with dealer pickup
        let mut engine = engine_with_dealer(0);
        engine.apply_bid(BidAction::GoAlone).unwrap(); // seat 1 alone, seat 3 out
        let dealer_hand = engine.state.hands[0];
        engine.dealer_discard(dealer_hand.iter().next().unwrap()).unwrap();
        play_out_hand(&mut engine);
        // Sitting-out hand untouched: still has 5 cards
        assert_eq!(engine.state.hands[3].count(), 5);
        let score = engine.score_hand().unwrap();
        assert_eq!(score.maker_tricks + score.defender_tricks, 5);
    }

    #[test]
    fn alone_lead_skips_sitting_out_leader() {
        // Dealer 3: lead seat would be 0. If seat 2 goes alone, partner 0 sits
        // out and the first lead must skip to seat 1.
        let mut engine = engine_with_dealer(3);
        engine.apply_bid(BidAction::Pass).unwrap(); // seat 0
        engine.apply_bid(BidAction::Pass).unwrap(); // seat 1
        engine.apply_bid(BidAction::GoAlone).unwrap(); // seat 2 alone, seat 0 out
        assert_eq!(engine.state.sitting_out, Some(0));
        let dealer_hand = engine.state.hands[3];
        engine.dealer_discard(dealer_hand.iter().next().unwrap()).unwrap();
        assert_eq!(engine.state.lead_seat, 0); // nominal lead
        assert_eq!(engine.state.next_to_play(), 1); // actual first player skips 0
        play_out_hand(&mut engine);
        assert_eq!(engine.state.hands[0].count(), 5); // never played
    }
}
