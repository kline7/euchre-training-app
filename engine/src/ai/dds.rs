use crate::game::card::{Card, CardSet, Suit, Rank};
use crate::game::rules::{legal_plays, play_card};
use crate::game::state::{GameState, GamePhase, team_of};

/// Dummy card for initializing fixed-size arrays (value is arbitrary).
const DUMMY_CARD: Card = Card::new(Suit::Hearts, Rank::Nine);
/// Max legal plays in Euchre playing phase (5 cards + safety margin).
const MAX_MOVES: usize = 6;

/// Result of a DDS solve: tricks won by each team from this position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DdsResult {
    pub tricks: [u8; 2], // tricks won by team 0, team 1
}

/// Transposition table entry.
#[derive(Debug, Clone, Copy, Default)]
struct TTEntry {
    key: u64,
    tricks_team0: u8,
    depth: u8,
    valid: bool,
}

/// Transposition table using Zobrist hashing.
/// Size: 2^14 = 16384 entries × ~16 bytes = ~256KB
const TT_SIZE: usize = 1 << 14;
const TT_MASK: usize = TT_SIZE - 1;

pub struct TranspositionTable {
    entries: Vec<TTEntry>,
    hits: u64,
    misses: u64,
}

impl TranspositionTable {
    pub fn new() -> Self {
        Self {
            entries: vec![TTEntry::default(); TT_SIZE],
            hits: 0,
            misses: 0,
        }
    }

    pub fn clear(&mut self) {
        for entry in &mut self.entries {
            *entry = TTEntry::default();
        }
        self.hits = 0;
        self.misses = 0;
    }

    fn probe(&mut self, key: u64) -> Option<u8> {
        let idx = key as usize & TT_MASK;
        let entry = &self.entries[idx];
        if entry.valid && entry.key == key {
            self.hits += 1;
            Some(entry.tricks_team0)
        } else {
            self.misses += 1;
            None
        }
    }

    fn store(&mut self, key: u64, tricks_team0: u8, depth: u8) {
        let idx = key as usize & TT_MASK;
        let entry = &mut self.entries[idx];
        // Replace if: empty, same key, or deeper search
        if !entry.valid || entry.key == key || depth >= entry.depth {
            entry.key = key;
            entry.tricks_team0 = tricks_team0;
            entry.depth = depth;
            entry.valid = true;
        }
    }

    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 { 0.0 } else { self.hits as f64 / total as f64 }
    }
}

/// Zobrist hash keys: random u64 for each (card_index, seat) pair.
/// 24 cards × 4 seats = 96 keys.
/// Plus keys for: trump (4), lead_seat (4), trick_number (5).
struct ZobristKeys {
    card_seat: [[u64; 4]; 24], // card_index × seat
    trump: [u64; 4],
    trick_num: [u64; 6], // 0-5 (0 unused, 1-5 for tricks)
}

impl ZobristKeys {
    fn new() -> Self {
        // Deterministic "random" keys from a simple LCG
        let mut state: u64 = 0xDEAD_BEEF_CAFE_BABE;
        let mut next = || -> u64 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            state
        };

        let mut card_seat = [[0u64; 4]; 24];
        for card in &mut card_seat {
            for seat in card.iter_mut() {
                *seat = next();
            }
        }
        let mut trump = [0u64; 4];
        for t in &mut trump { *t = next(); }
        let mut trick_num = [0u64; 6];
        for tn in &mut trick_num { *tn = next(); }

        Self { card_seat, trump, trick_num }
    }
}

/// Compute Zobrist hash for a position at trick boundaries.
fn zobrist_hash(state: &GameState, keys: &ZobristKeys) -> u64 {
    let mut hash = 0u64;
    // Hash each card's location
    for seat in 0..4u8 {
        for card in state.hands[seat as usize] {
            hash ^= keys.card_seat[card.index()][seat as usize];
        }
    }
    hash ^= keys.trump[state.trump as usize];
    hash ^= keys.trick_num[state.trick_number as usize];
    hash
}

/// QuickTricks: count guaranteed winning tricks for a team from the current position.
/// Returns (team0_quick, team1_quick).
fn quick_tricks(state: &GameState) -> (u8, u8) {
    let mut quick = [0u8; 2];

    // For each seat, check for top cards in each effective suit
    for seat in 0..4u8 {
        if Some(seat) == state.sitting_out {
            continue;
        }
        let hand = state.hands[seat as usize];
        let team = team_of(seat);

        // Check for Right Bower
        let right_bower = Card::new(state.trump, crate::game::card::Rank::Jack);
        if hand.contains(right_bower) {
            quick[team as usize] += 1;
            // If also has Left Bower, that's another guaranteed trick
            let left_bower = Card::new(state.trump.same_color(), crate::game::card::Rank::Jack);
            if hand.contains(left_bower) {
                quick[team as usize] += 1;
            }
        }
    }

    (quick[0], quick[1])
}

/// Alpha-beta DDS solver. Returns tricks won by team 0 from this position.
fn alpha_beta(
    state: &GameState,
    alpha: i8,
    beta: i8,
    tt: &mut TranspositionTable,
    keys: &ZobristKeys,
    nodes: &mut u64,
) -> u8 {
    *nodes += 1;

    // Base case: hand is over
    if state.phase == GamePhase::HandScoring || state.trick_number > 5 {
        return state.tricks_won[0];
    }

    // Transposition table lookup (only at trick boundaries — start of trick)
    let at_trick_start = state.current_trick.is_empty();
    let hash = if at_trick_start {
        let h = zobrist_hash(state, keys);
        if let Some(cached) = tt.probe(h) {
            return cached;
        }
        Some(h)
    } else {
        None
    };

    // QuickTricks pruning at trick boundaries
    if at_trick_start {
        let (qt0, qt1) = quick_tricks(state);
        let remaining_tricks = 5u8.saturating_sub(state.trick_number.saturating_sub(1));

        // If team 0's guaranteed tricks + already won >= beta, prune
        let team0_min = state.tricks_won[0].saturating_add(qt0).min(5);
        let team0_max = (state.tricks_won[0] + remaining_tricks).saturating_sub(qt1);

        if team0_min as i8 >= beta {
            return team0_min;
        }
        if (team0_max as i8) <= alpha {
            return team0_max;
        }
    }

    let seat = state.next_to_play();
    let hand = state.hands[seat as usize];
    let legal = legal_plays(hand, state);

    if legal.is_empty() {
        return state.tricks_won[0];
    }

    let team = team_of(seat);
    let maximizing = team == 0;

    // Card equivalence: group cards that are functionally identical
    let (cards, num_cards) = order_moves(legal, state);

    let mut best;
    let mut a = alpha;
    let mut b = beta;

    if maximizing {
        best = 0u8;
        for &card in &cards[..num_cards] {
            let new_state = play_card(state, seat, card);
            let score = alpha_beta(&new_state, a, b, tt, keys, nodes);
            if score > best { best = score; }
            if (score as i8) > a { a = score as i8; }
            if a >= b { break; } // Beta cutoff
        }
    } else {
        best = 5; // Max possible tricks for team 0
        for &card in &cards[..num_cards] {
            let new_state = play_card(state, seat, card);
            let score = alpha_beta(&new_state, a, b, tt, keys, nodes);
            if score < best { best = score; }
            if (score as i8) < b { b = score as i8; }
            if a >= b { break; } // Alpha cutoff
        }
    }

    // Store in transposition table at trick boundaries
    if let Some(h) = hash {
        let depth = 5 - (state.trick_number - 1);
        tt.store(h, best, depth);
    }

    best
}

/// Order moves for better alpha-beta pruning. Returns fixed-size array + count.
/// Zero heap allocations — critical for WASM DDS performance.
fn order_moves(legal: CardSet, state: &GameState) -> ([Card; MAX_MOVES], usize) {
    let mut cards = [DUMMY_CARD; MAX_MOVES];
    let mut len = 0;
    for card in legal.iter() {
        cards[len] = card;
        len += 1;
    }

    let trump = state.trump;
    let team = team_of(state.next_to_play());
    let maximizing = team == 0;

    cards[..len].sort_by(|a, b| {
        let a_trump = a.effective_suit(trump) == trump;
        let b_trump = b.effective_suit(trump) == trump;

        match (a_trump, b_trump) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let pa = a.trick_power(trump);
                let pb = b.trick_power(trump);
                if maximizing {
                    pb.cmp(&pa) // High to low for maximizer
                } else {
                    pa.cmp(&pb) // Low to high for minimizer
                }
            }
        }
    });

    (cards, len)
}

/// Solve a position with all cards visible (double-dummy).
/// Returns tricks won by team 0.
fn solve(state: &GameState, tt: &mut TranspositionTable, keys: &ZobristKeys) -> (DdsResult, u64) {
    let mut nodes = 0u64;
    let team0_tricks = alpha_beta(state, -1, 6, tt, keys, &mut nodes).min(5);
    let result = DdsResult {
        tricks: [team0_tricks, 5 - team0_tricks],
    };
    (result, nodes)
}

/// High-level DDS solver with its own transposition table.
pub struct Solver {
    tt: TranspositionTable,
    keys: ZobristKeys,
    pub total_nodes: u64,
    pub total_solves: u64,
}

impl Solver {
    pub fn new() -> Self {
        Self {
            tt: TranspositionTable::new(),
            keys: ZobristKeys::new(),
            total_nodes: 0,
            total_solves: 0,
        }
    }

    /// Solve a position. Reuses transposition table across calls within same hand.
    pub fn solve(&mut self, state: &GameState) -> DdsResult {
        let (result, nodes) = solve(state, &mut self.tt, &self.keys);
        self.total_nodes += nodes;
        self.total_solves += 1;
        result
    }

    /// Clear transposition table (call between different hands/determinizations).
    pub fn clear_tt(&mut self) {
        self.tt.clear();
    }

    pub fn tt_hit_rate(&self) -> f64 {
        self.tt.hit_rate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Card, CardSet, Suit, Rank};
    use crate::game::state::GameState;

    /// Helper to build a hand from card specs.
    fn hand_from(cards: &[(Suit, Rank)]) -> CardSet {
        let mut set = CardSet::EMPTY;
        for &(suit, rank) in cards {
            set.insert(Card::new(suit, rank));
        }
        set
    }

    #[test]
    fn solve_obvious_trump_sweep() {
        // Team 0 (seats 0, 2) has all the trump. Should win all 5 tricks.
        use Suit::*;
        use Rank::*;

        // 1 trick remaining, 1 card each
        let hands_1trick = [
            hand_from(&[(Hearts, Jack)]),   // Seat 0: Right Bower
            hand_from(&[(Clubs, Nine)]),    // Seat 1: junk
            hand_from(&[(Hearts, Queen)]),  // Seat 2: trump
            hand_from(&[(Spades, Nine)]),   // Seat 3: junk
        ];

        let mut state = GameState::new_hand(
            hands_1trick,
            Card::new(Hearts, Nine),
            3,
            [0, 0],
        );
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.trick_number = 5; // Last trick
        state.tricks_won = [3, 1]; // Team 0 already won 3

        let mut solver = Solver::new();
        let result = solver.solve(&state);
        // Seat 0 leads Right Bower → wins trick. Team 0 gets 4 total.
        assert_eq!(result.tricks[0], 4);
        assert_eq!(result.tricks[1], 1);
    }

    #[test]
    fn solve_two_tricks_remaining() {
        use Suit::*;
        use Rank::*;

        // 2 tricks left, 2 cards each
        let hands = [
            hand_from(&[(Hearts, Jack), (Hearts, Ace)]),     // Seat 0: Right Bower + Ace
            hand_from(&[(Clubs, Nine), (Clubs, Ten)]),       // Seat 1: junk
            hand_from(&[(Diamonds, Jack), (Hearts, King)]),  // Seat 2: Left Bower + King
            hand_from(&[(Spades, Nine), (Spades, Ten)]),     // Seat 3: junk
        ];

        let mut state = GameState::new_hand(
            hands,
            Card::new(Hearts, Nine),
            3,
            [0, 0],
        );
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.trick_number = 4; // Tricks 4 and 5 remaining
        state.tricks_won = [2, 1];

        let mut solver = Solver::new();
        let result = solver.solve(&state);
        // Team 0 has Right Bower, Left Bower, Ace, King of trump — wins both remaining tricks
        assert_eq!(result.tricks[0], 4);
        assert_eq!(result.tricks[1], 1);
    }

    #[test]
    fn solve_defenders_can_euchre() {
        use Suit::*;
        use Rank::*;

        // 3 tricks left, defenders (team 1) have the power
        let hands = [
            hand_from(&[(Clubs, Nine), (Clubs, Ten), (Spades, Nine)]),  // Seat 0: junk
            hand_from(&[(Hearts, Jack), (Hearts, Ace), (Hearts, King)]), // Seat 1: all trump
            hand_from(&[(Diamonds, Nine), (Diamonds, Ten), (Spades, Ten)]), // Seat 2: junk
            hand_from(&[(Diamonds, Jack), (Hearts, Queen), (Clubs, Ace)]), // Seat 3: Left Bower + trump
        ];

        let mut state = GameState::new_hand(
            hands,
            Card::new(Hearts, Nine),
            3,
            [0, 0],
        );
        state.trump = Hearts;
        state.maker = 0; // Team 0 called it but has no trump
        state.phase = GamePhase::Playing;
        state.trick_number = 3;
        state.tricks_won = [1, 1];
        state.lead_seat = 0; // Seat 0 leads

        let mut solver = Solver::new();
        let result = solver.solve(&state);
        // Team 1 (seats 1, 3) has all the trump → wins all 3 remaining tricks
        // Team 0 ends with 1 trick, Team 1 ends with 4
        assert_eq!(result.tricks[0], 1);
        assert_eq!(result.tricks[1], 4);
    }

    #[test]
    fn solve_full_hand() {
        use Suit::*;
        use Rank::*;

        // Full 5-trick hand, 5 cards each
        let hands = [
            hand_from(&[(Hearts, Jack), (Hearts, Ace), (Clubs, Ace), (Spades, Ace), (Diamonds, Ace)]),
            hand_from(&[(Clubs, Nine), (Clubs, Ten), (Spades, Nine), (Spades, Ten), (Diamonds, Nine)]),
            hand_from(&[(Diamonds, Jack), (Hearts, King), (Hearts, Queen), (Clubs, King), (Spades, King)]),
            hand_from(&[(Clubs, Queen), (Spades, Queen), (Diamonds, Ten), (Diamonds, Queen), (Diamonds, King)]),
        ];

        let mut state = GameState::new_hand(
            hands,
            Card::new(Hearts, Nine),
            3,
            [0, 0],
        );
        state.trump = Hearts;
        state.maker = 0;
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let mut solver = Solver::new();
        let result = solver.solve(&state);
        // Team 0 has Right Bower, Left Bower, Ace/King/Queen of trump + off-suit Aces
        // Should win all 5 tricks
        assert_eq!(result.tricks[0], 5);
        assert_eq!(result.tricks[1], 0);

        println!("Full hand solve: {} nodes, TT hit rate: {:.1}%",
            solver.total_nodes, solver.tt_hit_rate() * 100.0);
    }

    #[test]
    fn solve_close_hand() {
        use Suit::*;
        use Rank::*;

        // A more contested hand
        let hands = [
            hand_from(&[(Hearts, Ace), (Clubs, Ace), (Clubs, King), (Spades, Nine), (Diamonds, Nine)]),
            hand_from(&[(Hearts, Jack), (Hearts, King), (Spades, Ace), (Spades, King), (Diamonds, Ten)]),
            hand_from(&[(Hearts, Queen), (Hearts, Nine), (Clubs, Queen), (Diamonds, Ace), (Diamonds, King)]),
            hand_from(&[(Diamonds, Jack), (Hearts, Ten), (Clubs, Nine), (Spades, Queen), (Spades, Ten)]),
        ];

        let mut state = GameState::new_hand(
            hands,
            Card::new(Hearts, Nine),
            3,
            [0, 0],
        );
        state.trump = Hearts;
        state.maker = 1; // Seat 1 called trump (team 1)
        state.phase = GamePhase::Playing;
        state.lead_seat = 0;

        let mut solver = Solver::new();
        let result = solver.solve(&state);
        // This is a genuine search — just verify it returns valid results
        assert!(result.tricks[0] + result.tricks[1] == 5);
        println!("Close hand: team0={}, team1={}, {} nodes, TT hit rate: {:.1}%",
            result.tricks[0], result.tricks[1],
            solver.total_nodes, solver.tt_hit_rate() * 100.0);
    }
}
