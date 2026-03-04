use rand::prelude::*;
use rand_chacha::ChaCha20Rng;

use crate::game::card::{Card, CardSet, Suit, Rank};
use crate::game::rules::legal_plays;
use crate::game::state::{GameState, GamePhase, Seat, team_of, BidAction};

/// AI difficulty tiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Difficulty {
    Novice,
    Intermediate,
    Advanced,
    Expert,
}

/// Choose a card to play for the given AI difficulty.
pub fn choose_play(state: &GameState, difficulty: Difficulty, rng: &mut ChaCha20Rng) -> Card {
    let seat = state.next_to_play();
    let hand = state.hands[seat as usize];
    let legal = legal_plays(hand, state);
    let cards: Vec<Card> = legal.iter().collect();

    if cards.len() == 1 {
        return cards[0];
    }

    match difficulty {
        Difficulty::Novice => novice_play(&cards, state, rng),
        Difficulty::Intermediate => intermediate_play(&cards, state, seat, rng),
        Difficulty::Advanced => advanced_play(&cards, state, seat, rng),
        Difficulty::Expert => expert_play(&cards, state, seat, rng),
    }
}

/// Choose a bid action for the given AI difficulty. Uses state.next_to_play() for seat.
pub fn choose_bid(state: &GameState, difficulty: Difficulty, rng: &mut ChaCha20Rng) -> BidAction {
    choose_bid_for(state, difficulty, rng, state.next_to_play())
}

/// Choose a bid action for a specific seat.
pub fn choose_bid_for(state: &GameState, difficulty: Difficulty, _rng: &mut ChaCha20Rng, seat: Seat) -> BidAction {
    let hand = state.hands[seat as usize];
    let trump_if_ordered = state.upcard.suit;

    match state.phase {
        GamePhase::BiddingRound1 => {
            let trump_count = count_trump(hand, trump_if_ordered);
            let has_right = has_bower(hand, trump_if_ordered, true);
            let has_left = has_bower(hand, trump_if_ordered, false);

            match difficulty {
                Difficulty::Novice => {
                    if trump_count >= 3 { BidAction::OrderUp } else { BidAction::Pass }
                }
                Difficulty::Intermediate => {
                    if trump_count >= 2 && (has_right || has_left) {
                        BidAction::OrderUp
                    } else if trump_count >= 3 {
                        BidAction::OrderUp
                    } else {
                        BidAction::Pass
                    }
                }
                Difficulty::Advanced => {
                    let is_dealer = seat == state.dealer;
                    let strength = trump_strength(hand, trump_if_ordered);
                    if strength >= 5 { BidAction::OrderUp }
                    else if strength >= 4 && is_dealer { BidAction::OrderUp }
                    else { BidAction::Pass }
                }
                Difficulty::Expert => {
                    let is_dealer = seat == state.dealer;
                    let is_partner = (seat + 2) % 4 == state.dealer;
                    let strength = trump_strength(hand, trump_if_ordered);
                    let score_pressure = needs_points(state, seat);

                    if strength >= 5 { BidAction::OrderUp }
                    else if strength >= 4 && (is_dealer || is_partner) { BidAction::OrderUp }
                    else if strength >= 3 && score_pressure { BidAction::OrderUp }
                    else { BidAction::Pass }
                }
            }
        }
        GamePhase::BiddingRound2 => {
            // Try each suit except the turned-down suit
            let turned_down = state.upcard.suit;
            let mut best_suit: Option<Suit> = None;
            let mut best_count = 0u8;

            for suit in [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades] {
                if suit == turned_down { continue; }
                let count = count_trump(hand, suit);
                let threshold = match difficulty {
                    Difficulty::Novice => 3,
                    Difficulty::Intermediate => 2,
                    Difficulty::Advanced | Difficulty::Expert => {
                        if seat == state.dealer { 2 } else { 3 }
                    }
                };
                if count >= threshold && count > best_count {
                    best_count = count;
                    best_suit = Some(suit);
                }
            }

            // Stuck dealer must call
            if best_suit.is_none() && seat == state.dealer {
                // Pick suit with most cards
                let mut max_count = 0;
                for suit in [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades] {
                    if suit == turned_down { continue; }
                    let count = count_trump(hand, suit);
                    if count > max_count {
                        max_count = count;
                        best_suit = Some(suit);
                    }
                }
                // If still none (shouldn't happen), pick any non-turned-down suit
                if best_suit.is_none() {
                    for suit in [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades] {
                        if suit != turned_down {
                            best_suit = Some(suit);
                            break;
                        }
                    }
                }
            }

            match best_suit {
                Some(suit) => BidAction::CallSuit(suit),
                None => BidAction::Pass,
            }
        }
        _ => BidAction::Pass,
    }
}

// --- Play strategies by difficulty ---

fn novice_play(cards: &[Card], _state: &GameState, rng: &mut ChaCha20Rng) -> Card {
    // Play randomly from legal cards
    cards[rng.random_range(0..cards.len())]
}

fn intermediate_play(
    cards: &[Card],
    state: &GameState,
    seat: Seat,
    _rng: &mut ChaCha20Rng,
) -> Card {
    let leading = state.current_trick.is_empty();

    if leading {
        // Lead highest non-trump, or highest trump if only trump
        let non_trump: Vec<&Card> = cards.iter()
            .filter(|c| c.effective_suit(state.trump) != state.trump)
            .collect();

        if non_trump.is_empty() {
            // Only trump — lead highest
            *cards.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap()
        } else {
            // Lead highest off-suit
            **non_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap()
        }
    } else {
        // Following: play highest if partner isn't winning, else play low
        let _ = seat; // Used in advanced+
        let partner_winning = is_partner_winning(state, seat);

        if partner_winning {
            // Play lowest legal card
            *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap()
        } else {
            // Play highest legal card to try to win
            *cards.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap()
        }
    }
}

fn advanced_play(
    cards: &[Card],
    state: &GameState,
    seat: Seat,
    _rng: &mut ChaCha20Rng,
) -> Card {
    let leading = state.current_trick.is_empty();

    if leading {
        // Lead aces of off-suit first (guaranteed winners if no trump)
        for card in cards {
            if card.rank == Rank::Ace && card.effective_suit(state.trump) != state.trump {
                return *card;
            }
        }

        // Count remaining trump — if we have majority, lead trump to draw it out
        let our_trump: Vec<&Card> = cards.iter()
            .filter(|c| c.effective_suit(state.trump) == state.trump)
            .collect();

        if our_trump.len() >= 2 {
            // Lead highest trump to draw opponents' trump
            return **our_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Otherwise lead highest non-trump
        let non_trump: Vec<&Card> = cards.iter()
            .filter(|c| c.effective_suit(state.trump) != state.trump)
            .collect();

        if !non_trump.is_empty() {
            return **non_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        *cards.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap()
    } else {
        let partner_winning = is_partner_winning(state, seat);
        let can_beat_current = cards.iter().any(|c| {
            c.trick_power(state.trump) > current_winning_power(state)
        });

        if partner_winning && !last_to_play(state, seat) {
            // Partner winning and more opponents to play — play low
            *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap()
        } else if can_beat_current {
            // Play cheapest card that wins
            cards.iter()
                .filter(|c| c.trick_power(state.trump) > current_winning_power(state))
                .min_by_key(|c| c.trick_power(state.trump))
                .copied()
                .unwrap()
        } else {
            // Can't win — throw lowest
            *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap()
        }
    }
}

fn expert_play(
    cards: &[Card],
    state: &GameState,
    seat: Seat,
    _rng: &mut ChaCha20Rng,
) -> Card {
    let leading = state.current_trick.is_empty();
    let team = team_of(seat);

    if leading {
        // Score-aware: if we're ahead, play conservatively
        let tricks_needed = 3u8.saturating_sub(state.tricks_won[team as usize]);

        if tricks_needed == 0 {
            // Already won — dump lowest card
            return *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Lead aces of off-suit
        for card in cards {
            if card.rank == Rank::Ace && card.effective_suit(state.trump) != state.trump {
                // Check if opponents might be void (from tracked voids)
                let eff_suit = card.effective_suit(state.trump);
                let opp1 = (seat + 1) % 4;
                let opp2 = (seat + 3) % 4;
                let opp1_void = state.known_voids[opp1 as usize].0 & (1 << (eff_suit as u32)) != 0;
                let opp2_void = state.known_voids[opp2 as usize].0 & (1 << (eff_suit as u32)) != 0;

                if !opp1_void || !opp2_void {
                    // At least one opponent might follow — ace is safe
                    return *card;
                }
                // Both opponents void in this suit — ace will get trumped, skip it
            }
        }

        // Lead trump if we have Right Bower (guaranteed win, draws trump)
        let our_trump: Vec<&Card> = cards.iter()
            .filter(|c| c.effective_suit(state.trump) == state.trump)
            .collect();

        if our_trump.iter().any(|c| c.rank == Rank::Jack && c.suit == state.trump) {
            // Have Right Bower — lead it
            return **our_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Lead high trump if we have 2+ trump remaining
        if our_trump.len() >= 2 {
            return **our_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Fallback: highest non-trump
        let non_trump: Vec<&Card> = cards.iter()
            .filter(|c| c.effective_suit(state.trump) != state.trump)
            .collect();
        if !non_trump.is_empty() {
            return **non_trump.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        *cards.iter().max_by_key(|c| c.trick_power(state.trump)).unwrap()
    } else {
        // Following with full card-counting logic
        let partner_winning = is_partner_winning(state, seat);
        let winning_power = current_winning_power(state);

        if partner_winning && last_to_play(state, seat) {
            // Partner winning and we're last — play lowest
            return *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        if partner_winning && !last_to_play(state, seat) {
            // Partner winning but opponents still to play
            // Only help if we can play cheaply
            return *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Try to win cheaply
        let winners: Vec<&Card> = cards.iter()
            .filter(|c| c.trick_power(state.trump) > winning_power)
            .collect();

        if !winners.is_empty() {
            // Play cheapest winner
            return **winners.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap();
        }

        // Can't win — throw lowest value card
        *cards.iter().min_by_key(|c| c.trick_power(state.trump)).unwrap()
    }
}

// --- Helper functions ---

fn count_trump(hand: CardSet, trump: Suit) -> u8 {
    let trump_mask = CardSet::effective_suit_mask(trump, trump);
    hand.intersection(trump_mask).count() as u8
}

fn has_bower(hand: CardSet, trump: Suit, right: bool) -> bool {
    if right {
        hand.contains(Card::new(trump, Rank::Jack))
    } else {
        let left_suit = match trump {
            Suit::Hearts => Suit::Diamonds,
            Suit::Diamonds => Suit::Hearts,
            Suit::Clubs => Suit::Spades,
            Suit::Spades => Suit::Clubs,
        };
        hand.contains(Card::new(left_suit, Rank::Jack))
    }
}

fn trump_strength(hand: CardSet, trump: Suit) -> u8 {
    let mut strength = 0u8;
    let trump_mask = CardSet::effective_suit_mask(trump, trump);
    let trump_cards = hand.intersection(trump_mask);

    for card in trump_cards {
        strength += match card.trick_power(trump) {
            12 => 3, // Right Bower
            11 => 2, // Left Bower
            10 => 2, // Ace of trump
            _ => 1,  // Other trump
        };
    }

    // Bonus for off-suit aces
    for card in hand {
        if card.effective_suit(trump) != trump && card.rank == Rank::Ace {
            strength += 1;
        }
    }

    strength
}

fn needs_points(state: &GameState, seat: Seat) -> bool {
    let team = team_of(seat);
    let opp_team = 1 - team;
    // Opponent close to winning, or we're behind
    state.scores[opp_team as usize] >= 7 || state.scores[team as usize] < state.scores[opp_team as usize]
}

fn is_partner_winning(state: &GameState, seat: Seat) -> bool {
    if state.current_trick.is_empty() {
        return false;
    }
    let winner = crate::game::rules::trick_winner(&state.current_trick, state.trump);
    team_of(winner.seat) == team_of(seat)
}

fn current_winning_power(state: &GameState) -> u8 {
    if state.current_trick.is_empty() {
        return 0;
    }
    let winner = crate::game::rules::trick_winner(&state.current_trick, state.trump);
    winner.card.trick_power(state.trump)
}

fn last_to_play(state: &GameState, seat: Seat) -> bool {
    let active = state.active_players_in_trick();
    let played = state.current_trick.len() as u8;
    let _ = seat;
    played + 1 == active
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Suit::*, Rank::*};
    use crate::game::state::GamePhase;

    fn hand_from(cards: &[(Suit, Rank)]) -> CardSet {
        let mut set = CardSet::EMPTY;
        for &(suit, rank) in cards {
            set.insert(Card::new(suit, rank));
        }
        set
    }

    fn playing_state(hands: [CardSet; 4], trump: Suit, maker: Seat) -> GameState {
        let mut state = GameState::new_hand(hands, Card::new(trump, Nine), 3, [0, 0]);
        state.trump = trump;
        state.maker = maker;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;
        state
    }

    #[test]
    fn novice_plays_legal_card() {
        let hands = [
            hand_from(&[(Hearts, Ace), (Clubs, King)]),
            hand_from(&[(Hearts, Nine), (Spades, Nine)]),
            hand_from(&[(Hearts, King), (Diamonds, King)]),
            hand_from(&[(Diamonds, Nine), (Spades, Ten)]),
        ];
        let state = playing_state(hands, Hearts, 0);
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let card = choose_play(&state, Difficulty::Novice, &mut rng);
        assert!(state.hands[0].contains(card));
    }

    #[test]
    fn intermediate_leads_high_offsuit() {
        let hands = [
            hand_from(&[(Clubs, Ace), (Spades, Nine), (Diamonds, Ten)]),
            hand_from(&[(Hearts, Nine), (Spades, Ace), (Diamonds, Nine)]),
            hand_from(&[(Hearts, King), (Clubs, Nine), (Diamonds, King)]),
            hand_from(&[(Spades, King), (Clubs, Ten), (Spades, Ten)]),
        ];
        let state = playing_state(hands, Hearts, 0);
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let card = choose_play(&state, Difficulty::Intermediate, &mut rng);
        // Should lead Ace of Clubs (highest non-trump)
        assert_eq!(card, Card::new(Clubs, Ace));
    }

    #[test]
    fn advanced_leads_offsuit_ace() {
        let hands = [
            hand_from(&[(Clubs, Ace), (Hearts, Nine), (Diamonds, King)]),
            hand_from(&[(Hearts, Ace), (Spades, Ace), (Diamonds, Nine)]),
            hand_from(&[(Hearts, King), (Clubs, Nine), (Spades, King)]),
            hand_from(&[(Spades, Nine), (Clubs, Ten), (Diamonds, Ten)]),
        ];
        let state = playing_state(hands, Hearts, 0);
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let card = choose_play(&state, Difficulty::Advanced, &mut rng);
        assert_eq!(card, Card::new(Clubs, Ace));
    }

    #[test]
    fn expert_dumps_when_already_won() {
        let hands = [
            hand_from(&[(Clubs, Ace), (Hearts, Nine)]),
            hand_from(&[(Spades, Nine), (Diamonds, Nine)]),
            hand_from(&[(Clubs, Nine), (Spades, King)]),
            hand_from(&[(Diamonds, Ten), (Spades, Ten)]),
        ];
        let mut state = playing_state(hands, Hearts, 0);
        state.tricks_won = [3, 1]; // Team 0 already has 3 tricks
        state.trick_number = 5;
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let card = choose_play(&state, Difficulty::Expert, &mut rng);
        // Should dump lowest card since we've already won
        assert_eq!(card, Card::new(Hearts, Nine));
    }

    #[test]
    fn novice_bids_with_3_trump() {
        let hand = hand_from(&[
            (Hearts, Ace), (Hearts, King), (Hearts, Queen),
            (Clubs, Nine), (Spades, Nine),
        ]);
        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            Card::new(Hearts, Nine), 3, [0, 0],
        );
        state.phase = GamePhase::BiddingRound1;
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let bid = choose_bid(&state, Difficulty::Novice, &mut rng);
        assert_eq!(bid, BidAction::OrderUp);
    }

    #[test]
    fn novice_passes_with_2_trump() {
        let hand = hand_from(&[
            (Hearts, Ace), (Hearts, King),
            (Clubs, Nine), (Spades, Nine), (Diamonds, Ten),
        ]);
        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            Card::new(Hearts, Nine), 3, [0, 0],
        );
        state.phase = GamePhase::BiddingRound1;
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let bid = choose_bid(&state, Difficulty::Novice, &mut rng);
        assert_eq!(bid, BidAction::Pass);
    }

    #[test]
    fn stuck_dealer_must_call() {
        let hand = hand_from(&[
            (Clubs, Nine), (Clubs, Ten),
            (Spades, Nine), (Spades, Ten), (Diamonds, Nine),
        ]);
        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            Card::new(Hearts, Nine), 0, [0, 0], // seat 0 is dealer
        );
        state.phase = GamePhase::BiddingRound2;
        let mut rng = ChaCha20Rng::seed_from_u64(42);

        let bid = choose_bid(&state, Difficulty::Novice, &mut rng);
        // Stuck dealer must call something
        matches!(bid, BidAction::CallSuit(_));
    }
}
