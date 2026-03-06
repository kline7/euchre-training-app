use rand::prelude::*;
use rand_chacha::ChaCha20Rng;

use crate::game::card::{Card, CardSet, Suit, Rank};
use crate::game::rules::legal_plays;
use crate::game::state::{GameState, Seat, team_of};
use crate::ai::dds::Solver;

/// Dummy card for initializing fixed-size arrays (value is arbitrary).
const DUMMY_CARD: Card = Card::new(Suit::Hearts, Rank::Nine);
/// Max legal plays in Euchre (5 cards + safety margin).
const MAX_LEGAL: usize = 6;

/// Result of evaluating a single card play via PIMC.
#[derive(Debug, Clone)]
pub struct EvalResult {
    pub card: Card,
    pub expected_tricks: f64,
    pub win_probability: f64,
    pub expected_points: f64,
    pub determinizations: u32,
}

/// Result of evaluating all legal plays at a decision point.
#[derive(Debug, Clone)]
pub struct PimcResult {
    pub evaluations: Vec<EvalResult>,
    pub total_determinizations: u32,
    pub total_nodes: u64,
}

/// Generate a single determinization: randomly assign unknown cards to opponents
/// consistent with observed information (voids).
/// Uses fixed-size arrays — zero heap allocations.
fn generate_determinization(
    state: &GameState,
    perspective_seat: Seat,
    rng: &mut ChaCha20Rng,
) -> Option<GameState> {
    let mut new_state = *state; // Copy (no heap allocation)

    // Fixed-size buffers: max 15 unknown cards (3 opponents × 5), max 3 seats
    let mut unknown_cards = [DUMMY_CARD; 15];
    let mut unknown_len = 0usize;
    let mut seats_to_fill = [(0u8, 0u32); 3];
    let mut seats_len = 0usize;

    for seat in 0..4u8 {
        if seat == perspective_seat {
            continue;
        }
        if Some(seat) == state.sitting_out {
            new_state.hands[seat as usize] = CardSet::EMPTY;
            continue;
        }
        let hand = state.hands[seat as usize];
        let card_count = hand.count();
        for card in hand {
            unknown_cards[unknown_len] = card;
            unknown_len += 1;
        }
        seats_to_fill[seats_len] = (seat, card_count);
        seats_len += 1;
    }

    // Shuffle unknown cards
    unknown_cards[..unknown_len].shuffle(rng);

    // Distribute cards to seats, respecting known voids
    // Rejection sampling — fast for Euchre's small card set
    for _attempt in 0..100 {
        let mut shuffled = unknown_cards; // Stack copy, no heap allocation
        shuffled[..unknown_len].shuffle(rng);

        let mut valid = true;
        let mut idx = 0;

        for &(seat, count) in &seats_to_fill[..seats_len] {
            let mut hand = CardSet::EMPTY;
            let void_bits = state.known_voids[seat as usize].0;

            for card in &shuffled[idx..idx + count as usize] {
                let eff_suit = card.effective_suit(state.trump);
                if void_bits & (1 << (eff_suit as u32)) != 0 {
                    valid = false;
                    break;
                }
                hand.insert(*card);
            }

            if !valid { break; }
            new_state.hands[seat as usize] = hand;
            idx += count as usize;
        }

        if valid {
            return Some(new_state);
        }
    }

    // If we can't find a valid assignment after 100 tries, return unconstrained
    let mut idx = 0;
    for &(seat, count) in &seats_to_fill[..seats_len] {
        let mut hand = CardSet::EMPTY;
        for card in &unknown_cards[idx..idx + count as usize] {
            hand.insert(*card);
        }
        new_state.hands[seat as usize] = hand;
        idx += count as usize;
    }
    Some(new_state)
}

/// Run PIMC evaluation for all legal plays at the current position.
pub fn evaluate_plays(
    state: &GameState,
    num_determinizations: u32,
    seed: u64,
) -> PimcResult {
    let seat = state.next_to_play();
    let hand = state.hands[seat as usize];
    let legal = legal_plays(hand, state);
    let team = team_of(seat);

    let mut legal_cards = [DUMMY_CARD; MAX_LEGAL];
    let mut num_cards = 0;
    for card in legal.iter() {
        legal_cards[num_cards] = card;
        num_cards += 1;
    }

    if num_cards == 0 {
        return PimcResult {
            evaluations: vec![],
            total_determinizations: 0,
            total_nodes: 0,
        };
    }

    // Accumulate results per card — fixed-size, no heap allocation
    let mut trick_sums = [0.0f64; MAX_LEGAL];
    let mut win_counts = [0u32; MAX_LEGAL];
    let mut point_sums = [0.0f64; MAX_LEGAL];
    let mut total_nodes = 0u64;

    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let mut solver = Solver::new();

    for _det in 0..num_determinizations {
        // Generate a random world consistent with observations
        let Some(det_state) = generate_determinization(state, seat, &mut rng) else {
            continue;
        };

        solver.clear_tt();

        // Evaluate each legal card in this world
        for (i, &card) in legal_cards[..num_cards].iter().enumerate() {
            let new_state = crate::game::rules::play_card(&det_state, seat, card);
            let result = solver.solve(&new_state);
            total_nodes += solver.total_nodes;
            solver.total_nodes = 0;

            let team_tricks = result.tricks[team as usize];
            trick_sums[i] += team_tricks as f64;

            // Win = maker gets 3+ tricks
            if team_tricks >= 3 {
                win_counts[i] += 1;
            }

            // Points: 1 for 3-4 tricks, 2 for sweep, -2 for euchre
            let points = if team_tricks >= 5 {
                if state.alone { 4.0 } else { 2.0 }
            } else if team_tricks >= 3 {
                1.0
            } else {
                -2.0
            };
            point_sums[i] += points;
        }
    }

    let n = num_determinizations as f64;
    let evaluations = legal_cards[..num_cards]
        .iter()
        .enumerate()
        .map(|(i, &card)| EvalResult {
            card,
            expected_tricks: trick_sums[i] / n,
            win_probability: win_counts[i] as f64 / n,
            expected_points: point_sums[i] / n,
            determinizations: num_determinizations,
        })
        .collect();

    PimcResult {
        evaluations,
        total_determinizations: num_determinizations,
        total_nodes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Suit, Rank, Suit::*, Rank::*};
    use crate::game::state::GamePhase;

    fn hand_from(cards: &[(Suit, Rank)]) -> CardSet {
        let mut set = CardSet::EMPTY;
        for &(suit, rank) in cards {
            set.insert(Card::new(suit, rank));
        }
        set
    }

    #[test]
    fn pimc_obvious_play() {
        // Seat 0 leads with Right Bower vs. junk. Should have high win prob.
        let hands = [
            hand_from(&[(Hearts, Jack), (Hearts, Ace), (Clubs, Ace), (Spades, Ace), (Diamonds, Ace)]),
            hand_from(&[(Clubs, Nine), (Clubs, Ten), (Spades, Nine), (Spades, Ten), (Diamonds, Nine)]),
            hand_from(&[(Diamonds, Jack), (Hearts, King), (Hearts, Queen), (Clubs, King), (Spades, King)]),
            hand_from(&[(Clubs, Queen), (Spades, Queen), (Diamonds, Ten), (Diamonds, Queen), (Diamonds, King)]),
        ];

        let mut state = GameState::new_hand(hands, Card::new(Hearts, Nine), 3, [0, 0]);
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let result = evaluate_plays(&state, 50, 42);
        assert!(!result.evaluations.is_empty());

        // With all this trump power, win probability should be very high
        for eval in &result.evaluations {
            println!("{}: tricks={:.2}, win={:.2}, pts={:.2}",
                eval.card, eval.expected_tricks, eval.win_probability, eval.expected_points);
        }

        // The Right Bower should be among the best plays
        let best = result.evaluations.iter()
            .max_by(|a, b| a.expected_tricks.partial_cmp(&b.expected_tricks).unwrap())
            .unwrap();
        assert!(best.win_probability > 0.8);
    }

    #[test]
    fn pimc_deterministic_with_same_seed() {
        let hands = [
            hand_from(&[(Hearts, Ace), (Clubs, Ace), (Spades, King), (Diamonds, King), (Hearts, Queen)]),
            hand_from(&[(Hearts, Nine), (Clubs, Nine), (Spades, Nine), (Diamonds, Nine), (Clubs, Ten)]),
            hand_from(&[(Hearts, King), (Clubs, King), (Spades, Ace), (Diamonds, Ace), (Hearts, Ten)]),
            hand_from(&[(Clubs, Queen), (Spades, Queen), (Diamonds, Queen), (Spades, Ten), (Diamonds, Ten)]),
        ];

        let mut state = GameState::new_hand(hands, Card::new(Hearts, Nine), 3, [0, 0]);
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let r1 = evaluate_plays(&state, 20, 12345);
        let r2 = evaluate_plays(&state, 20, 12345);

        // Same seed → same results
        for (a, b) in r1.evaluations.iter().zip(r2.evaluations.iter()) {
            assert_eq!(a.card, b.card);
            assert!((a.expected_tricks - b.expected_tricks).abs() < 1e-10);
        }
    }

    #[test]
    fn pimc_respects_voids() {
        // Seat 1 is known void in hearts (they failed to follow suit earlier)
        let hands = [
            hand_from(&[(Hearts, Ace), (Clubs, Ace)]),
            hand_from(&[(Clubs, Nine), (Spades, Nine)]),
            hand_from(&[(Hearts, King), (Diamonds, King)]),
            hand_from(&[(Diamonds, Nine), (Spades, Ten)]),
        ];

        let mut state = GameState::new_hand(hands, Card::new(Hearts, Nine), 3, [0, 0]);
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.trick_number = 4;
        state.tricks_won = [2, 1];
        state.lead_seat = 0;
        // Mark seat 1 as void in Hearts
        state.known_voids[1].0 |= 1 << (Suit::Hearts as u32);

        let result = evaluate_plays(&state, 30, 99);
        assert!(!result.evaluations.is_empty());
    }
}
