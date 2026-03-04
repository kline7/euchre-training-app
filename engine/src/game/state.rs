use serde::{Deserialize, Serialize};
use crate::game::card::{Card, CardSet, Suit};

pub type Seat = u8; // 0-3
pub type Team = u8;  // 0 or 1

/// Team for a given seat: seats 0,2 are team 0; seats 1,3 are team 1.
pub fn team_of(seat: Seat) -> Team {
    seat & 1
}

/// Partner seat (across the table).
pub fn partner_of(seat: Seat) -> Seat {
    (seat + 2) % 4
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GamePhase {
    Dealing,
    BiddingRound1,
    BiddingRound2,
    DealerDiscard,
    Playing,
    HandScoring,
    GameOver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BidAction {
    Pass,
    OrderUp,            // Round 1: order dealer to pick up upcard
    CallSuit(Suit),     // Round 2: name trump suit
    GoAlone,            // Modifier: play without partner
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrickCard {
    pub seat: Seat,
    pub card: Card,
}

/// Full game state for a single hand of Euchre.
/// Designed to be cheaply cloned for DDS search.
#[derive(Debug, Clone)]
pub struct GameState {
    // Hands — one CardSet per seat (bitboard)
    pub hands: [CardSet; 4],

    // Trump and dealing
    pub trump: Suit,
    pub upcard: Card,
    pub dealer: Seat,
    pub maker: Seat,
    pub alone: bool,
    /// The partner of the alone player sits out. None if not going alone.
    pub sitting_out: Option<Seat>,

    // Game phase
    pub phase: GamePhase,

    // Current trick
    pub current_trick: Vec<TrickCard>,
    pub lead_seat: Seat,
    pub trick_number: u8, // 1-5

    // Scoring
    pub tricks_won: [u8; 2], // per team

    // Game-level scores (across hands, first to 10)
    pub scores: [u8; 2],

    // Tracking for AI: which suits each player is known void in
    pub known_voids: [CardSet; 4], // bits = suits voided (not cards — we reuse u32 for 4 suit bits)
}

impl GameState {
    /// Create a new game state ready for a hand.
    pub fn new_hand(hands: [CardSet; 4], upcard: Card, dealer: Seat, scores: [u8; 2]) -> Self {
        Self {
            hands,
            trump: upcard.suit, // Default — will be set by bidding
            upcard,
            dealer,
            maker: 0,
            alone: false,
            sitting_out: None,
            phase: GamePhase::BiddingRound1,
            current_trick: Vec::with_capacity(4),
            lead_seat: (dealer + 1) % 4,
            trick_number: 1,
            tricks_won: [0, 0],
            scores,
            known_voids: [CardSet::EMPTY; 4],
        }
    }

    /// Number of cards played in current trick.
    pub fn cards_in_trick(&self) -> usize {
        self.current_trick.len()
    }

    /// The suit that was led in the current trick (effective suit, accounting for Left Bower).
    pub fn led_suit(&self) -> Option<Suit> {
        self.current_trick.first().map(|tc| tc.card.effective_suit(self.trump))
    }

    /// Is this seat's turn to act in the current trick?
    /// Skips the sitting-out player.
    pub fn active_players_in_trick(&self) -> u8 {
        if self.alone { 3 } else { 4 }
    }

    /// Next seat to play in trick, skipping sitting_out.
    pub fn next_to_play(&self) -> Seat {
        let played = self.current_trick.len() as u8;
        let mut seat = self.lead_seat;
        let mut count = 0;
        loop {
            if Some(seat) != self.sitting_out.map(|s| s) {
                if count == played {
                    return seat;
                }
                count += 1;
            }
            seat = (seat + 1) % 4;
        }
    }

    /// Is the current trick complete?
    pub fn trick_complete(&self) -> bool {
        self.current_trick.len() as u8 == self.active_players_in_trick()
    }

    /// All cards that have been played so far (for card tracking).
    pub fn played_cards(&self) -> CardSet {
        let all_remaining = self.hands[0]
            .union(self.hands[1])
            .union(self.hands[2])
            .union(self.hands[3]);
        CardSet::FULL_DECK.difference(all_remaining)
    }
}
