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

/// Generate a single determinization: randomly assign UNSEEN cards to
/// opponents, consistent with the perspective player's true information set:
/// - The pool is every card not in our hand and not played face-up — this
///   includes the kitty and the dealer's discard, which we cannot see.
///   (Sampling only from opponents' actual cards would leak which cards
///   are buried.)
/// - If trump was ordered up, everyone knows the dealer holds the upcard
///   until it is played — it is pinned to the dealer's sampled hand.
/// - If the upcard was turned down, everyone knows it is buried.
/// - If WE are the dealer, we also know our own discard is buried.
/// - Known voids (from failures to follow suit) are always respected;
///   if no valid assignment is found, the determinization is skipped
///   rather than violating constraints.
fn generate_determinization(
    state: &GameState,
    perspective_seat: Seat,
    rng: &mut ChaCha20Rng,
) -> Option<GameState> {
    let mut new_state = *state; // Copy (no heap allocation)

    // Build the unseen pool from the perspective player's actual knowledge.
    let mut pool_set = CardSet::FULL_DECK
        .difference(state.hands[perspective_seat as usize])
        .difference(state.played);

    let upcard = state.upcard;
    // trump == upcard.suit ⟺ the upcard was ordered up (round-2 calls of the
    // turned-down suit are illegal). The dealer holds it unless they sat out
    // (loner by the dealer's partner skips the pickup) or already played it.
    let ordered_up = state.trump == upcard.suit && state.sitting_out != Some(state.dealer);
    let pin_upcard_to_dealer = ordered_up
        && state.dealer != perspective_seat
        && state.sitting_out != Some(state.dealer)
        && pool_set.contains(upcard);

    if !ordered_up {
        // Turned down — publicly known to be buried in the kitty
        pool_set.remove(upcard);
    } else if pin_upcard_to_dealer {
        pool_set.remove(upcard); // re-inserted into the dealer's hand below
    }

    // The dealer knows their own discard is buried
    if perspective_seat == state.dealer {
        if let Some(discard) = state.discard {
            pool_set.remove(discard);
        }
    }

    // Fixed-size buffers: the pool can hold up to 19 unseen cards
    // (24 − our 5), max 3 seats to fill.
    let mut pool = [DUMMY_CARD; 24];
    let mut pool_len = 0usize;
    for card in pool_set.iter() {
        pool[pool_len] = card;
        pool_len += 1;
    }

    let mut seats_to_fill = [(0u8, 0u32); 3];
    let mut seats_len = 0usize;
    for seat in 0..4u8 {
        if seat == perspective_seat {
            continue;
        }
        if Some(seat) == state.sitting_out {
            // The sitting-out hand is face-down and irrelevant to play;
            // its cards stay in the pool as generic unseen cards.
            new_state.hands[seat as usize] = CardSet::EMPTY;
            continue;
        }
        let mut card_count = state.hands[seat as usize].count();
        if pin_upcard_to_dealer && seat == state.dealer {
            card_count -= 1; // upcard slot is pre-filled
        }
        seats_to_fill[seats_len] = (seat, card_count);
        seats_len += 1;
    }

    // Distribute pool cards to seats, respecting known voids.
    // Rejection sampling — fast for Euchre's small card set. Leftover pool
    // cards form the imagined kitty/buried cards.
    for _attempt in 0..1000 {
        let mut shuffled = pool; // Stack copy, no heap allocation
        shuffled[..pool_len].shuffle(rng);

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
            if pin_upcard_to_dealer && seat == state.dealer {
                hand.insert(upcard);
            }
            new_state.hands[seat as usize] = hand;
            idx += count as usize;
        }

        if valid {
            return Some(new_state);
        }
    }

    // Constraints could not be satisfied — skip this determinization rather
    // than producing a world that contradicts observed voids.
    None
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
    let mut dets_used = 0u32;

    let maker_team = team_of(state.maker);
    let is_maker_side = team == maker_team;

    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let mut solver = Solver::new();

    for _det in 0..num_determinizations {
        // Generate a random world consistent with observations
        let Some(det_state) = generate_determinization(state, seat, &mut rng) else {
            continue;
        };
        dets_used += 1;

        solver.clear_tt();

        // Evaluate each legal card in this world
        for (i, &card) in legal_cards[..num_cards].iter().enumerate() {
            let new_state = crate::game::rules::play_card(&det_state, seat, card);
            let result = solver.solve(&new_state);
            total_nodes += solver.total_nodes;
            solver.total_nodes = 0;

            let team_tricks = result.tricks[team as usize];
            trick_sums[i] += team_tricks as f64;

            // "Win" for the perspective team: 3+ tricks this hand
            // (a euchre when defending).
            if team_tricks >= 3 {
                win_counts[i] += 1;
            }

            // Points from the perspective team's side, as a zero-sum
            // differential. Maker side: 1 for 3-4 tricks, 2 for a march
            // (4 alone), -2 when euchred. Defender side is the negation:
            // +2 for a euchre, -1/-2/-4 when the makers score.
            let maker_tricks = result.tricks[maker_team as usize];
            let maker_points = if maker_tricks >= 5 {
                if state.alone { 4.0 } else { 2.0 }
            } else if maker_tricks >= 3 {
                1.0
            } else {
                -2.0
            };
            point_sums[i] += if is_maker_side { maker_points } else { -maker_points };
        }
    }

    let n = dets_used.max(1) as f64;
    let evaluations = legal_cards[..num_cards]
        .iter()
        .enumerate()
        .map(|(i, &card)| EvalResult {
            card,
            expected_tricks: trick_sums[i] / n,
            win_probability: win_counts[i] as f64 / n,
            expected_points: point_sums[i] / n,
            determinizations: dets_used,
        })
        .collect();

    PimcResult {
        evaluations,
        total_determinizations: dets_used,
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
    fn determinization_pins_ordered_up_upcard_to_dealer() {
        // Trump == upcard suit means it was ordered up: everyone knows the
        // dealer (seat 3) holds the upcard until it is played.
        let upcard = Card::new(Hearts, Nine);
        let hands = [
            hand_from(&[(Clubs, Ace), (Clubs, King)]),
            hand_from(&[(Spades, Nine), (Spades, Ten)]),
            hand_from(&[(Diamonds, King), (Diamonds, Queen)]),
            hand_from(&[(Hearts, Nine), (Hearts, Ace)]), // dealer actually holds the upcard
        ];
        let mut state = GameState::new_hand(hands, upcard, 3, [0, 0]);
        state.trump = Hearts; // ordered up
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let mut rng = ChaCha20Rng::seed_from_u64(7);
        for _ in 0..50 {
            let det = generate_determinization(&state, 0, &mut rng).unwrap();
            assert!(
                det.hands[3].contains(upcard),
                "dealer must hold the known upcard in every sampled world"
            );
            // And nobody else may hold it
            for seat in [1usize, 2] {
                assert!(!det.hands[seat].contains(upcard));
            }
        }
    }

    #[test]
    fn determinization_excludes_turned_down_upcard() {
        // Trump != upcard suit: the upcard was turned down and is known buried.
        let upcard = Card::new(Spades, Ace);
        let hands = [
            hand_from(&[(Clubs, Ace), (Clubs, King)]),
            hand_from(&[(Spades, Nine), (Spades, Ten)]),
            hand_from(&[(Diamonds, King), (Diamonds, Queen)]),
            hand_from(&[(Hearts, Nine), (Hearts, Ace)]),
        ];
        let mut state = GameState::new_hand(hands, upcard, 3, [0, 0]);
        state.trump = Hearts; // called in round 2
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let mut rng = ChaCha20Rng::seed_from_u64(11);
        for _ in 0..50 {
            let det = generate_determinization(&state, 0, &mut rng).unwrap();
            for seat in 0..4usize {
                assert!(
                    !det.hands[seat].contains(upcard),
                    "turned-down upcard must never be sampled into a hand"
                );
            }
        }
    }

    #[test]
    fn determinization_samples_from_full_unseen_pool() {
        // The perspective player cannot see the kitty: unseen cards that are
        // NOT in any opponent's actual hand must still appear in sampled
        // opponent hands (otherwise the sampler leaks which cards are buried).
        let hands = [
            hand_from(&[(Clubs, Ace), (Clubs, King)]),
            hand_from(&[(Spades, Nine), (Spades, Ten)]),
            hand_from(&[(Diamonds, King), (Diamonds, Queen)]),
            hand_from(&[(Hearts, Nine), (Hearts, Ace)]),
        ];
        let mut state = GameState::new_hand(hands, Card::new(Spades, Ace), 3, [0, 0]);
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        // A card in nobody's hand, not played, not the upcard: a kitty card
        let kitty_card = Card::new(Diamonds, Nine);
        for h in &state.hands {
            assert!(!h.contains(kitty_card));
        }

        let mut rng = ChaCha20Rng::seed_from_u64(13);
        let mut seen_in_sampled_hand = false;
        for _ in 0..100 {
            let det = generate_determinization(&state, 0, &mut rng).unwrap();
            if (1..4).any(|s| det.hands[s].contains(kitty_card)) {
                seen_in_sampled_hand = true;
                break;
            }
        }
        assert!(
            seen_in_sampled_hand,
            "unseen kitty cards must be part of the sampling pool"
        );
    }

    #[test]
    fn defender_expected_points_reflect_euchre_value() {
        // Team 0 (perspective seat 0) is DEFENDING and already has 3 tricks:
        // the euchre is locked in, worth +2 to the defenders no matter how
        // the last trick goes. The old maker-centric formula scored this +1.
        let hands = [
            hand_from(&[(Hearts, Jack)]),  // right bower — seat 0 (defender)
            hand_from(&[(Clubs, Nine)]),
            hand_from(&[(Diamonds, Ten)]),
            hand_from(&[(Spades, Ten)]),
        ];
        let mut state = GameState::new_hand(hands, Card::new(Spades, Ace), 3, [0, 0]);
        state.trump = Hearts; // round-2 call; upcard (spades) turned down
        state.maker = 1;      // team 1 made it
        state.phase = GamePhase::Playing;
        state.trick_number = 5;
        state.tricks_won = [3, 1]; // defenders already euchred the makers
        state.lead_seat = 0;

        let result = evaluate_plays(&state, 30, 21);
        for eval in &result.evaluations {
            assert!(
                (eval.expected_points - 2.0).abs() < 1e-9,
                "locked-in euchre must be worth +2 to defenders, got {}",
                eval.expected_points
            );
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
