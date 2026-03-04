use criterion::{criterion_group, criterion_main, Criterion, black_box};

use euchre_engine::game::card::{Card, CardSet, Suit, Rank};
use euchre_engine::game::state::{GameState, GamePhase};
use euchre_engine::ai::dds::Solver;
use euchre_engine::ai::pimc;

fn hand_from(cards: &[(Suit, Rank)]) -> CardSet {
    let mut set = CardSet::EMPTY;
    for &(suit, rank) in cards {
        set.insert(Card::new(suit, rank));
    }
    set
}

fn setup_full_hand() -> GameState {
    use Suit::*;
    use Rank::*;

    let hands = [
        hand_from(&[(Hearts, Ace), (Clubs, Ace), (Clubs, King), (Spades, Nine), (Diamonds, Nine)]),
        hand_from(&[(Hearts, Jack), (Hearts, King), (Spades, Ace), (Spades, King), (Diamonds, Ten)]),
        hand_from(&[(Hearts, Queen), (Hearts, Nine), (Clubs, Queen), (Diamonds, Ace), (Diamonds, King)]),
        hand_from(&[(Diamonds, Jack), (Hearts, Ten), (Clubs, Nine), (Spades, Queen), (Spades, Ten)]),
    ];

    let mut state = GameState::new_hand(hands, Card::new(Hearts, Nine), 3, [0, 0]);
    state.trump = Hearts;
    state.maker = 1;
    state.phase = GamePhase::Playing;
    state.lead_seat = 0;
    state
}

fn bench_dds_single_solve(c: &mut Criterion) {
    let state = setup_full_hand();

    c.bench_function("dds_single_solve_5tricks", |b| {
        let mut solver = Solver::new();
        b.iter(|| {
            solver.clear_tt();
            black_box(solver.solve(&state));
        })
    });
}

fn bench_pimc_100(c: &mut Criterion) {
    let state = setup_full_hand();

    c.bench_function("pimc_100_determinizations", |b| {
        b.iter(|| {
            black_box(pimc::evaluate_plays(&state, 100, 42));
        })
    });
}

fn bench_pimc_200(c: &mut Criterion) {
    let state = setup_full_hand();

    c.bench_function("pimc_200_determinizations", |b| {
        b.iter(|| {
            black_box(pimc::evaluate_plays(&state, 200, 42));
        })
    });
}

fn bench_pimc_1000(c: &mut Criterion) {
    let state = setup_full_hand();

    let mut group = c.benchmark_group("pimc_1000");
    group.sample_size(10); // 1000 determinizations is slow, reduce samples
    group.bench_function("pimc_1000_determinizations", |b| {
        b.iter(|| {
            black_box(pimc::evaluate_plays(&state, 1000, 42));
        })
    });
    group.finish();
}

criterion_group!(benches, bench_dds_single_solve, bench_pimc_100, bench_pimc_200, bench_pimc_1000);
criterion_main!(benches);
