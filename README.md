# Euchre Training App

An AI-powered Euchre training application that analyzes every decision you make — both bidding and card play — using a Perfect Information Monte Carlo (PIMC) engine with a Double Dummy Solver (DDS). Think "Lichess for Euchre."

The entire AI engine runs client-side as WebAssembly compiled from Rust. No server required. Works offline.

## Features

- **Full Euchre rules** — Left/Right Bowers, going alone, stuck dealer, euchre scoring
- **4 AI difficulty levels** — Novice, Intermediate, Advanced, Expert with distinct strategies
- **PIMC + DDS analysis** — Evaluates every legal play using Monte Carlo sampling with perfect-information solves. 200 determinizations per move in under 200ms
- **Move classification** — Grades each play as Best, Good, Inaccuracy, Mistake, or Blunder based on win probability change (WPC)
- **Bid analysis** — Evaluates trump calling decisions using hand strength heuristics. Flags missed opportunities and risky calls
- **Post-hand summary** — Shows top errors with WPC, expected trick differential, and what the optimal play was
- **Maker indicator** — Gold "M" badge shows who called trump; score panel shows "Called by: Us/Them"
- **Game history** — All games persisted in IndexedDB via Dexie.js, survives browser close
- **Step-through review** — Replay any completed game decision by decision
- **Persistent game state** — Navigate to Settings or History mid-game without losing progress
- **Mobile responsive** — Playable on screens 375px and wider

## Architecture

```
euchre-training-app/
├── engine/                  # Rust → WebAssembly
│   ├── src/
│   │   ├── lib.rs           # WASM entry point
│   │   ├── wasm_api.rs      # wasm-bindgen exports
│   │   ├── game/
│   │   │   ├── card.rs      # Card, Suit, Rank, bitboard (24-bit CardSet)
│   │   │   ├── state.rs     # GameState, GamePhase FSM
│   │   │   ├── rules.rs     # Legal moves, trick resolution, void tracking
│   │   │   └── scoring.rs   # Hand/game scoring (maker, euchre, alone, sweep)
│   │   └── ai/
│   │       ├── dds.rs       # Double Dummy Solver (alpha-beta, transposition tables)
│   │       ├── pimc.rs      # Monte Carlo sampler (determinization + DDS)
│   │       ├── blunder.rs   # WPC classification (Best/Good/Inaccuracy/Mistake/Blunder)
│   │       └── opponents.rs # Heuristic AI (4 difficulty tiers)
│   └── benches/
│       └── dds_bench.rs     # Performance benchmarks
│
├── web/                     # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx          # Routing (wouter), persistent PlayPage
│   │   ├── engine/
│   │   │   ├── worker.ts    # Web Worker (Comlink-exposed engine API)
│   │   │   └── bridge.ts    # Comlink.wrap<EngineAPI> proxy
│   │   ├── components/
│   │   │   ├── GameTable.tsx # Card table, trick area, dealer/maker badges
│   │   │   ├── BiddingPanel.tsx
│   │   │   ├── HandSummary.tsx  # Post-hand analysis with bid + play grades
│   │   │   ├── GameOver.tsx
│   │   │   └── cards/Card.tsx   # Card rendering (Unicode suits)
│   │   ├── pages/
│   │   │   ├── PlayPage.tsx     # Main game loop, PIMC integration, bid analysis
│   │   │   ├── ReviewPage.tsx   # Step-through game replay
│   │   │   ├── HistoryPage.tsx  # Game list (Dexie live queries)
│   │   │   └── SettingsPage.tsx # Difficulty, animation speed, hints
│   │   ├── stores/store.ts     # Zustand (UI state + persisted settings)
│   │   └── db/schema.ts        # Dexie.js (games + settings tables)
│   └── e2e/                    # Playwright smoke tests
│       ├── smoke.spec.ts
│       ├── play-flow.spec.ts
│       └── review-flow.spec.ts
│
└── README.md
```

### How PIMC Works

Euchre is an imperfect information game — you can't see opponents' cards. PIMC solves this by:

1. **Sampling** — Generate 200 random "worlds" where opponents hold cards consistent with observed information (known voids from failed suit-following)
2. **Solving** — For each world, run a Double Dummy Solver with all cards visible. Alpha-beta search with transposition tables, card equivalence grouping, and QuickTricks pruning
3. **Averaging** — Aggregate expected tricks, win probability, and expected points across all worlds for each legal play

Euchre's small game tree (24 cards, 5 tricks, ~5K-20K nodes after pruning) makes this feasible in the browser. A single DDS solve takes <1ms; 200 determinizations complete in <200ms.

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Engine | Rust → WASM (wasm-bindgen) | Game rules, DDS, PIMC, AI opponents |
| Frontend | React 19 + Vite 7 | UI components, routing |
| Animation | Motion 12 | Card dealing, playing, flip animations |
| State | Zustand 5 | UI state + persisted settings |
| Persistence | Dexie.js 4 (IndexedDB) | Game history, settings |
| Worker RPC | Comlink | Typed communication with WASM Web Worker |
| Routing | wouter | Lightweight client-side routing |
| E2E Tests | Playwright | Smoke tests |

---

## Setup

### Prerequisites

- **Rust** (stable) with the `wasm32-unknown-unknown` target
- **wasm-bindgen CLI** (must match the version in `engine/Cargo.toml`)
- **Node.js** >= 18
- **npm** >= 9

### Install Rust and WASM tooling

If you don't have Rust installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Add the WASM compilation target and install wasm-bindgen:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
```

**Optional** — install `wasm-opt` for ~10-20% smaller WASM binaries:

```bash
# macOS
brew install binaryen

# Or from GitHub releases: https://github.com/WebAssembly/binaryen/releases
```

### Build the WASM engine

```bash
cd engine

# Development build (fast, no LTO — ~2s)
cargo build --target wasm32-unknown-unknown --profile dev-wasm
wasm-bindgen target/wasm32-unknown-unknown/debug/euchre_engine.wasm \
  --out-dir pkg --target web

# OR: Release build (optimized, slower — ~30s)
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/euchre_engine.wasm \
  --out-dir pkg --target web

# Optional: optimize WASM binary size
wasm-opt -Oz pkg/euchre_engine_bg.wasm -o pkg/euchre_engine_bg.wasm
```

This produces `engine/pkg/` containing the JS glue and `.wasm` binary that the frontend imports.

### Install frontend dependencies

```bash
cd web
npm install
```

### Run the dev server

```bash
cd web
npm run dev
```

Opens at **http://localhost:5173**. Vite HMR provides instant updates when editing frontend code.

### Run tests

**Rust engine tests (80 tests):**

```bash
cd engine
cargo test
```

**TypeScript type checking:**

```bash
cd web
npx tsc --noEmit
```

**Playwright E2E tests:**

```bash
cd web
npx playwright install    # First time only
npm run test:e2e
```

**DDS benchmarks:**

```bash
cd engine
cargo bench
```

### Production build

```bash
# 1. Build optimized WASM
cd engine
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/euchre_engine.wasm \
  --out-dir pkg --target web
wasm-opt -Oz pkg/euchre_engine_bg.wasm -o pkg/euchre_engine_bg.wasm

# 2. Build frontend
cd ../web
npm run build
```

The output in `web/dist/` is a static site — deploy to Vercel, Netlify, GitHub Pages, or any static host. Zero backend required.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `wasm-bindgen` version mismatch | Ensure CLI version matches `Cargo.toml` dependency: `cargo install wasm-bindgen-cli --version 0.2.114` |
| `error[E0463]: can't find crate for std` | Run `rustup target add wasm32-unknown-unknown` |
| Vite can't find `@engine/euchre_engine` | Build the WASM engine first — `engine/pkg/` must exist |
| `RuntimeError: unreachable` in browser | Engine WASM panic — usually a state bug. Check browser console, restart game |
| Playwright tests fail on first run | Run `npx playwright install` to download browser binaries |

---

## Game Rules

Standard North American Euchre with stuck dealer:

- **Deck**: 24 cards (9, 10, J, Q, K, A in each suit)
- **Trump ranking**: Right Bower (J of trump) > Left Bower (J of same color) > A > K > Q > 10 > 9
- **Bidding**: Round 1 — order up the upcard or pass. Round 2 — call any other suit or pass. Stuck dealer must call
- **Going alone**: Skip your partner. Win all 5 tricks for 4 points
- **Scoring**: 3-4 tricks = 1 point. All 5 tricks = 2 points. Euchre = 2 points to defenders. First to 10 wins

## License

MIT
