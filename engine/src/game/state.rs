use serde::{Deserialize, Serialize};
use crate::game::card::{Card, CardSet, Suit, Rank};

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
    GoAlone,            // Round 1: order up alone
    GoAloneCall(Suit),  // Round 2: call suit alone
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrickCard {
    pub seat: Seat,
    pub card: Card,
}

const EMPTY_TC: TrickCard = TrickCard { seat: 0, card: Card::new(Suit::Hearts, Rank::Nine) };

/// Fixed-size trick buffer (max 4 cards). Drop-in replacement for Vec<TrickCard>
/// that eliminates heap allocations — critical for DDS search performance.
#[derive(Debug, Clone, Copy)]
pub struct TrickBuf {
    cards: [TrickCard; 4],
    len: u8,
}

impl TrickBuf {
    pub const fn new() -> Self {
        Self { cards: [EMPTY_TC; 4], len: 0 }
    }

    pub fn push(&mut self, tc: TrickCard) {
        self.cards[self.len as usize] = tc;
        self.len += 1;
    }

    pub fn clear(&mut self) {
        self.len = 0;
    }

    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn first(&self) -> Option<&TrickCard> {
        if self.len > 0 { Some(&self.cards[0]) } else { None }
    }
}

impl std::ops::Deref for TrickBuf {
    type Target = [TrickCard];
    fn deref(&self) -> &[TrickCard] {
        &self.cards[..self.len as usize]
    }
}

/// Full game state for a single hand of Euchre.
/// Designed to be cheaply copied for DDS search (no heap allocations).
#[derive(Debug, Clone, Copy)]
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

    // Current trick — fixed-size buffer, zero heap allocations
    pub current_trick: TrickBuf,
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
            current_trick: TrickBuf::new(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Card, Rank, Suit};

    fn make_card(suit: Suit, rank: Rank) -> Card {
        Card::new(suit, rank)
    }

    fn hand_from(cards: &[(Suit, Rank)]) -> CardSet {
        let mut set = CardSet::EMPTY;
        for &(suit, rank) in cards {
            set.insert(Card::new(suit, rank));
        }
        set
    }

    #[test]
    fn team_of_assignments() {
        assert_eq!(team_of(0), 0);
        assert_eq!(team_of(1), 1);
        assert_eq!(team_of(2), 0);
        assert_eq!(team_of(3), 1);
    }

    #[test]
    fn partner_of_assignments() {
        assert_eq!(partner_of(0), 2);
        assert_eq!(partner_of(1), 3);
        assert_eq!(partner_of(2), 0);
        assert_eq!(partner_of(3), 1);
    }

    #[test]
    fn new_hand_defaults() {
        let state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            2, // Dealer is seat 2
            [5, 3],
        );
        assert_eq!(state.phase, GamePhase::BiddingRound1);
        assert_eq!(state.dealer, 2);
        assert_eq!(state.lead_seat, 3); // Left of dealer
        assert_eq!(state.trick_number, 1);
        assert_eq!(state.tricks_won, [0, 0]);
        assert_eq!(state.scores, [5, 3]);
        assert!(!state.alone);
        assert!(state.sitting_out.is_none());
    }

    #[test]
    fn next_to_play_normal() {
        let mut state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );
        state.lead_seat = 1;
        state.phase = GamePhase::Playing;

        // No cards played — next is lead seat
        assert_eq!(state.next_to_play(), 1);

        // After 1 card played
        state.current_trick.push(TrickCard { seat: 1, card: make_card(Suit::Hearts, Rank::Ace) });
        assert_eq!(state.next_to_play(), 2);

        // After 2 cards
        state.current_trick.push(TrickCard { seat: 2, card: make_card(Suit::Hearts, Rank::King) });
        assert_eq!(state.next_to_play(), 3);

        // After 3 cards
        state.current_trick.push(TrickCard { seat: 3, card: make_card(Suit::Hearts, Rank::Queen) });
        assert_eq!(state.next_to_play(), 0);
    }

    #[test]
    fn next_to_play_skips_sitting_out() {
        let mut state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );
        state.lead_seat = 0;
        state.alone = true;
        state.sitting_out = Some(2); // Seat 2 sits out
        state.phase = GamePhase::Playing;

        assert_eq!(state.next_to_play(), 0);

        state.current_trick.push(TrickCard { seat: 0, card: make_card(Suit::Hearts, Rank::Ace) });
        assert_eq!(state.next_to_play(), 1); // Seat 1

        state.current_trick.push(TrickCard { seat: 1, card: make_card(Suit::Hearts, Rank::King) });
        assert_eq!(state.next_to_play(), 3); // Skips seat 2, goes to 3
    }

    #[test]
    fn trick_complete_normal_vs_alone() {
        let mut state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );

        // Normal mode: 4 players needed
        assert!(!state.trick_complete());
        state.current_trick.push(TrickCard { seat: 0, card: make_card(Suit::Hearts, Rank::Ace) });
        state.current_trick.push(TrickCard { seat: 1, card: make_card(Suit::Hearts, Rank::King) });
        state.current_trick.push(TrickCard { seat: 2, card: make_card(Suit::Hearts, Rank::Queen) });
        assert!(!state.trick_complete());
        state.current_trick.push(TrickCard { seat: 3, card: make_card(Suit::Hearts, Rank::Nine) });
        assert!(state.trick_complete());

        // Alone mode: 3 players
        let mut alone_state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );
        alone_state.alone = true;
        alone_state.sitting_out = Some(2);
        alone_state.current_trick.push(TrickCard { seat: 0, card: make_card(Suit::Hearts, Rank::Ace) });
        alone_state.current_trick.push(TrickCard { seat: 1, card: make_card(Suit::Hearts, Rank::King) });
        assert!(!alone_state.trick_complete());
        alone_state.current_trick.push(TrickCard { seat: 3, card: make_card(Suit::Hearts, Rank::Nine) });
        assert!(alone_state.trick_complete());
    }

    #[test]
    fn led_suit_tracks_effective_suit() {
        let mut state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );
        state.trump = Suit::Hearts;

        // No cards — no led suit
        assert!(state.led_suit().is_none());

        // Left Bower leads — led suit should be Hearts (trump), not Diamonds
        let left_bower = make_card(Suit::Diamonds, Rank::Jack);
        state.current_trick.push(TrickCard { seat: 0, card: left_bower });
        assert_eq!(state.led_suit(), Some(Suit::Hearts));
    }

    #[test]
    fn played_cards_tracks_removed_cards() {
        let h0 = hand_from(&[(Suit::Hearts, Rank::Ace), (Suit::Clubs, Rank::Nine)]);
        let h1 = hand_from(&[(Suit::Spades, Rank::King)]);
        let state = GameState::new_hand(
            [h0, h1, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );

        let played = state.played_cards();
        // 24 total - 3 in hands = 21 "played" (or rather, not in any hand)
        assert_eq!(played.count(), 21);
        assert!(!played.contains(make_card(Suit::Hearts, Rank::Ace)));
        assert!(!played.contains(make_card(Suit::Clubs, Rank::Nine)));
        assert!(!played.contains(make_card(Suit::Spades, Rank::King)));
    }
}
