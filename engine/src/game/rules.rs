use crate::game::card::{Card, CardSet, Suit};
use crate::game::state::{GameState, GamePhase, TrickCard, Seat, team_of};

/// Returns the set of legal cards to play from the given hand.
/// Must follow suit (effective suit, accounting for Left Bower).
pub fn legal_plays(hand: CardSet, state: &GameState) -> CardSet {
    if hand.is_empty() {
        return CardSet::EMPTY;
    }

    // If leading or first to play, any card is legal
    if state.current_trick.is_empty() {
        return hand;
    }

    // Must follow the led suit (effective suit)
    let led_suit = state.led_suit().unwrap();
    let follow_mask = CardSet::effective_suit_mask(led_suit, state.trump);
    let can_follow = hand.intersection(follow_mask);

    if can_follow.is_empty() {
        // Can't follow suit — any card is legal
        hand
    } else {
        can_follow
    }
}

/// Determine the winner of a completed trick.
/// Returns the TrickCard of the winner.
pub fn trick_winner(trick: &[TrickCard], trump: Suit) -> TrickCard {
    assert!(!trick.is_empty());
    let led_suit = trick[0].card.effective_suit(trump);

    let mut best = trick[0];
    let mut best_is_trump = best.card.effective_suit(trump) == trump;
    let mut best_power = best.card.trick_power(trump);

    for &tc in &trick[1..] {
        let eff_suit = tc.card.effective_suit(trump);
        let is_trump = eff_suit == trump;
        let power = tc.card.trick_power(trump);

        let beats_best = if is_trump && !best_is_trump {
            // Trump beats non-trump
            true
        } else if is_trump && best_is_trump {
            // Both trump — higher power wins
            power > best_power
        } else if eff_suit == led_suit && best.card.effective_suit(trump) != led_suit {
            // Shouldn't happen if best is already tracking correctly, but safety
            false
        } else if eff_suit == led_suit {
            // Same suit as led — higher power wins
            power > best_power
        } else {
            // Off-suit, not trump — can't win
            false
        };

        if beats_best {
            best = tc;
            best_is_trump = is_trump;
            best_power = power;
        }
    }

    best
}

/// Play a card in the current trick. Returns the new state.
/// Does NOT validate legality — caller must use legal_plays() first.
pub fn play_card(state: &GameState, seat: Seat, card: Card) -> GameState {
    let mut new_state = state.clone();

    // Remove card from hand
    new_state.hands[seat as usize].remove(card);

    // Track voids: if not following suit, mark void
    if let Some(led_suit) = state.led_suit() {
        if card.effective_suit(state.trump) != led_suit {
            // Player is void in the led suit — record this
            // We store suit voids as bits 0-3 in known_voids
            new_state.known_voids[seat as usize].0 |= 1 << (led_suit as u32);
        }
    }

    // Add to current trick
    new_state.current_trick.push(TrickCard { seat, card });

    // Check if trick is complete
    if new_state.trick_complete() {
        let winner = trick_winner(&new_state.current_trick, new_state.trump);
        let winning_team = team_of(winner.seat);
        new_state.tricks_won[winning_team as usize] += 1;
        new_state.lead_seat = winner.seat;
        new_state.current_trick.clear();
        new_state.trick_number += 1;

        // Check if hand is over (all 5 tricks played)
        if new_state.trick_number > 5 {
            new_state.phase = GamePhase::HandScoring;
        }
    }

    new_state
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Rank, Suit::*, Rank::*};

    fn make_card(suit: crate::game::card::Suit, rank: Rank) -> Card {
        Card::new(suit, rank)
    }

    #[test]
    fn follow_suit_required() {
        let mut hand = CardSet::EMPTY;
        hand.insert(make_card(Hearts, Ace));
        hand.insert(make_card(Hearts, King));
        hand.insert(make_card(Clubs, Nine));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Spades, Nine),
            0,
            [0, 0],
        );
        state.trump = Spades;
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Hearts, Nine),
        });

        let legal = legal_plays(hand, &state);
        // Must follow hearts — only hearts cards are legal
        assert!(legal.contains(make_card(Hearts, Ace)));
        assert!(legal.contains(make_card(Hearts, King)));
        assert!(!legal.contains(make_card(Clubs, Nine)));
    }

    #[test]
    fn cant_follow_any_card_legal() {
        let mut hand = CardSet::EMPTY;
        hand.insert(make_card(Clubs, Ace));
        hand.insert(make_card(Spades, Nine));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Spades, Nine),
            0,
            [0, 0],
        );
        state.trump = Spades;
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Hearts, Nine),
        });

        let legal = legal_plays(hand, &state);
        // Can't follow hearts — any card is legal
        assert_eq!(legal, hand);
    }

    #[test]
    fn left_bower_follows_trump() {
        let mut hand = CardSet::EMPTY;
        let left_bower = make_card(Diamonds, Jack); // Left Bower when Hearts is trump
        hand.insert(left_bower);
        hand.insert(make_card(Clubs, Ace));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Hearts, Nine),
            0,
            [0, 0],
        );
        state.trump = Hearts;
        // Someone led hearts
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Hearts, Nine),
        });

        let legal = legal_plays(hand, &state);
        // Left Bower IS hearts (effective suit) — must play it to follow
        assert!(legal.contains(left_bower));
        assert!(!legal.contains(make_card(Clubs, Ace)));
    }

    #[test]
    fn trick_winner_trump_beats_offsuit() {
        let trump = Hearts;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Clubs, Ace) },
            TrickCard { seat: 1, card: make_card(Hearts, Nine) },
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 1); // Nine of trump beats Ace of off-suit
    }

    #[test]
    fn trick_winner_right_bower_highest() {
        let trump = Hearts;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Hearts, Ace) },
            TrickCard { seat: 1, card: make_card(Hearts, Jack) },  // Right Bower
            TrickCard { seat: 2, card: make_card(Diamonds, Jack) }, // Left Bower
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 1); // Right Bower wins
    }

    #[test]
    fn trick_winner_left_bower_beats_ace() {
        let trump = Hearts;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Hearts, Ace) },
            TrickCard { seat: 1, card: make_card(Diamonds, Jack) }, // Left Bower
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 1); // Left Bower beats Ace of trump
    }

    #[test]
    fn trick_winner_offsuit_doesnt_win() {
        let trump = Spades;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Hearts, Nine) },
            TrickCard { seat: 1, card: make_card(Clubs, Ace) }, // Off-suit, didn't follow
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 0); // Led suit wins if no trump played
    }

    #[test]
    fn leading_any_card_legal() {
        let mut hand = CardSet::EMPTY;
        hand.insert(make_card(Hearts, Ace));
        hand.insert(make_card(Clubs, Nine));

        let state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Spades, Nine),
            0,
            [0, 0],
        );

        let legal = legal_plays(hand, &state);
        assert_eq!(legal, hand); // When leading, any card is legal
    }

    // --- play_card state transition tests ---

    #[test]
    fn play_card_removes_from_hand() {
        let mut hand = CardSet::EMPTY;
        hand.insert(make_card(Hearts, Ace));
        hand.insert(make_card(Clubs, Nine));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Spades, Nine),
            0,
            [0, 0],
        );
        state.trump = Spades;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let new_state = play_card(&state, 0, make_card(Hearts, Ace));
        assert!(!new_state.hands[0].contains(make_card(Hearts, Ace)));
        assert!(new_state.hands[0].contains(make_card(Clubs, Nine)));
    }

    #[test]
    fn play_card_tracks_void() {
        let mut hand = CardSet::EMPTY;
        hand.insert(make_card(Clubs, Ace)); // No hearts to follow

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Spades, Nine),
            0,
            [0, 0],
        );
        state.trump = Spades;
        state.phase = GamePhase::Playing;
        state.lead_seat = 1;
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Hearts, Nine),
        });

        let new_state = play_card(&state, 0, make_card(Clubs, Ace));
        // Should record void in Hearts (suit 0)
        assert!(new_state.known_voids[0].0 & (1 << (crate::game::card::Suit::Hearts as u32)) != 0);
    }

    #[test]
    fn trick_completes_after_4_plays() {
        let hands = [
            CardSet::EMPTY,
            CardSet::EMPTY,
            CardSet::EMPTY,
            CardSet::EMPTY,
        ];
        let mut state = GameState::new_hand(hands, make_card(Spades, Nine), 0, [0, 0]);
        state.trump = Spades;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;
        // Simulate 3 cards already played
        state.current_trick.push(TrickCard { seat: 0, card: make_card(Hearts, Ace) });
        state.current_trick.push(TrickCard { seat: 1, card: make_card(Hearts, King) });
        state.current_trick.push(TrickCard { seat: 2, card: make_card(Hearts, Queen) });
        // Give seat 3 a card to play
        state.hands[3].insert(make_card(Hearts, Nine));

        let new_state = play_card(&state, 3, make_card(Hearts, Nine));
        // Trick should be cleared, winner is seat 0 (Ace of Hearts)
        assert!(new_state.current_trick.is_empty());
        assert_eq!(new_state.tricks_won[0], 1); // Team 0 wins (seat 0)
        assert_eq!(new_state.lead_seat, 0); // Winner leads next
        assert_eq!(new_state.trick_number, 2);
    }

    #[test]
    fn hand_scoring_after_5_tricks() {
        let hands = [CardSet::EMPTY; 4];
        let mut state = GameState::new_hand(hands, make_card(Spades, Nine), 0, [0, 0]);
        state.trump = Spades;
        state.phase = GamePhase::Playing;
        state.trick_number = 5; // Last trick
        state.tricks_won = [3, 1]; // Team 0 has 3, team 1 has 1
        state.lead_seat = 0;
        // Set up the final trick — 3 cards played
        state.current_trick.push(TrickCard { seat: 0, card: make_card(Hearts, Ace) });
        state.current_trick.push(TrickCard { seat: 1, card: make_card(Hearts, King) });
        state.current_trick.push(TrickCard { seat: 2, card: make_card(Hearts, Queen) });
        state.hands[3].insert(make_card(Hearts, Nine));

        let new_state = play_card(&state, 3, make_card(Hearts, Nine));
        assert_eq!(new_state.phase, GamePhase::HandScoring);
        assert_eq!(new_state.tricks_won[0], 4); // 3 + 1 from this trick
    }

    // --- Left Bower edge cases ---

    #[test]
    fn left_bower_must_follow_when_trump_led() {
        // When trump is led and you only have the Left Bower as "trump", you must play it
        let mut hand = CardSet::EMPTY;
        let left_bower = make_card(Diamonds, Jack); // Left Bower when Hearts is trump
        hand.insert(left_bower);
        hand.insert(make_card(Clubs, Ace));
        hand.insert(make_card(Spades, King));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Hearts, Nine),
            0,
            [0, 0],
        );
        state.trump = Hearts;
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Hearts, Ace), // Trump led
        });

        let legal = legal_plays(hand, &state);
        assert_eq!(legal.count(), 1);
        assert!(legal.contains(left_bower));
    }

    #[test]
    fn left_bower_not_required_when_native_suit_led() {
        // When Diamonds is led and Hearts is trump, Jack of Diamonds is a Bower — NOT in Diamonds suit
        let mut hand = CardSet::EMPTY;
        let left_bower = make_card(Diamonds, Jack);
        hand.insert(left_bower);
        hand.insert(make_card(Diamonds, Ace));
        hand.insert(make_card(Clubs, Nine));

        let mut state = GameState::new_hand(
            [hand, CardSet::EMPTY, CardSet::EMPTY, CardSet::EMPTY],
            make_card(Hearts, Nine),
            0,
            [0, 0],
        );
        state.trump = Hearts;
        state.current_trick.push(TrickCard {
            seat: 1,
            card: make_card(Diamonds, Nine), // Diamonds led
        });

        let legal = legal_plays(hand, &state);
        // Only Ace of Diamonds follows — Left Bower is trump, not diamonds
        assert!(legal.contains(make_card(Diamonds, Ace)));
        assert!(!legal.contains(left_bower)); // Left Bower is trump, can't play to follow diamonds
    }

    // --- trick_winner edge cases ---

    #[test]
    fn trick_winner_led_suit_beats_other_offsuit() {
        let trump = Spades;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Hearts, Ten) },  // Led hearts
            TrickCard { seat: 1, card: make_card(Clubs, Ace) },    // Off-suit
            TrickCard { seat: 2, card: make_card(Diamonds, Ace) }, // Off-suit
            TrickCard { seat: 3, card: make_card(Hearts, Ace) },   // Followed hearts
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 3); // Ace of Hearts beats Ten of Hearts
    }

    #[test]
    fn trick_winner_low_trump_beats_high_offsuit() {
        let trump = Hearts;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Clubs, Ace) },
            TrickCard { seat: 1, card: make_card(Spades, Ace) },
            TrickCard { seat: 2, card: make_card(Hearts, Nine) }, // Lowest trump
            TrickCard { seat: 3, card: make_card(Diamonds, Ace) },
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 2); // Nine of trump beats all off-suit aces
    }

    #[test]
    fn trick_winner_left_bower_when_leading() {
        let trump = Hearts;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Diamonds, Jack) }, // Left Bower leads
            TrickCard { seat: 1, card: make_card(Hearts, Ace) },    // Ace of trump
            TrickCard { seat: 2, card: make_card(Hearts, King) },
        ];
        let winner = trick_winner(&trick, trump);
        // Left Bower > Ace of trump
        assert_eq!(winner.seat, 0);
    }

    #[test]
    fn trick_winner_all_same_suit_highest_wins() {
        let trump = Spades;
        let trick = vec![
            TrickCard { seat: 0, card: make_card(Hearts, Nine) },
            TrickCard { seat: 1, card: make_card(Hearts, Queen) },
            TrickCard { seat: 2, card: make_card(Hearts, King) },
            TrickCard { seat: 3, card: make_card(Hearts, Ten) },
        ];
        let winner = trick_winner(&trick, trump);
        assert_eq!(winner.seat, 2); // King highest
    }

    // --- alone mode trick completion ---

    #[test]
    fn trick_completes_with_3_in_alone_mode() {
        let hands = [CardSet::EMPTY; 4];
        let mut state = GameState::new_hand(hands, make_card(Hearts, Nine), 0, [0, 0]);
        state.trump = Hearts;
        state.maker = 0;
        state.alone = true;
        state.sitting_out = Some(2); // Partner sits out
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;
        state.current_trick.push(TrickCard { seat: 0, card: make_card(Hearts, Ace) });
        state.current_trick.push(TrickCard { seat: 1, card: make_card(Hearts, King) });
        state.hands[3].insert(make_card(Hearts, Nine));

        let new_state = play_card(&state, 3, make_card(Hearts, Nine));
        // 3 players = trick complete
        assert!(new_state.current_trick.is_empty());
        assert_eq!(new_state.tricks_won[0], 1);
    }
}
