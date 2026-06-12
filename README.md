# Euchre Training App

An AI-powered Euchre training application that analyzes every decision you make — both bidding and card play — using a Perfect Information Monte Carlo (PIMC) engine with a Double Dummy Solver (DDS). Think "Lichess for Euchre."

Solo play runs the AI engine client-side as WebAssembly compiled from Rust and works fully offline. Online multiplayer runs the **same Rust engine server-side** as the rules authority, with Elo matchmaking and milk-coin rewards.

## Features

### Solo training
- **Full Euchre rules** — Left/Right Bowers, going alone, engine-enforced stick-the-dealer, turned-down-suit enforcement, euchre scoring
- **4 AI difficulty levels** — Novice, Intermediate, Advanced, Expert with distinct strategies
- **PIMC + DDS analysis** — Evaluates every legal play using Monte Carlo sampling with perfect-information solves, sampled from the player's true information set (the kitty and dealer discard stay hidden)
- **Move classification** — Grades each play as Best, Good, Inaccuracy, Mistake, or Blunder based on win probability change (WPC)
- **Bid analysis** — Evaluates trump calling decisions. Flags missed opportunities and risky calls
- **Post-hand summary** — Shows top errors with WPC, expected trick differential, and what the optimal play was
- **Game history & step-through review** — Games sync to the server per account, with an offline outbox so gameplay never blocks on the network
- **Persistent game state** — Navigate to Settings or History mid-game without losing progress
- **Mobile responsive** — Playable on screens 375px and wider

### Online multiplayer
- **Accounts** — username/password or one-click guest accounts (scrypt-hashed passwords, bearer-token sessions)
- **Elo matchmaking** — queue with players near your rating; the acceptable band widens the longer you wait. Teams are balanced (strongest + weakest vs. the middle two)
- **Friends** — add friends by username, accept/decline requests, see their rating and division
- **Pre-made teams** — invite a friend to a party and queue as a duo. Each duo has a **persistent team rating** that starts from the members' combined (averaged) elo and then evolves on its own; team queues match duo vs. duo by team elo
- **Divisions** — one ladder for players and teams alike: Bronze → Silver → Gold → Platinum → Diamond → Master, rising with elo
- **Team vs AI** — full parties can start an unrated practice match against two AI opponents at any difficulty
- **Server-authoritative play** — the server deals (server-owned seeds), validates every bid/play/discard through the same Rust engine, and each player is sent *only their own cards*
- **Turn clock & disconnect handling** — slow or disconnected players are auto-played by the expert AI so tables never stall; reconnects re-attach to the live match
- **Elo + milk coins** — winners gain rating and earn 🥛 milk coins, settled in a single transaction with an append-only, idempotent coin ledger and a full match action log for replay/audit
- **Leaderboards** — top rated players AND top rated teams in the lobby

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
│   │   │   ├── engine.rs    # CoreEngine — validated rules authority (bidding FSM,
│   │   │   │                #   stick-the-dealer, action validation, scoring)
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
│   │   │   ├── PlayPage.tsx     # Solo game loop, PIMC integration, bid analysis
│   │   │   ├── LobbyPage.tsx    # Auth, profile (elo/coins), leaderboard
│   │   │   ├── MultiplayerPage.tsx # Online match view (WebSocket-driven)
│   │   │   ├── ReviewPage.tsx   # Step-through game replay
│   │   │   ├── HistoryPage.tsx  # Game list
│   │   │   └── SettingsPage.tsx # Difficulty, animation speed, hints
│   │   ├── multiplayer/        # WS protocol types, MatchClient, auth store
│   │   ├── stores/store.ts     # Zustand (UI state + persisted settings)
│   │   └── db/                 # Server API client + offline outbox, record types
│   └── e2e/                    # Playwright tests
│       ├── smoke.spec.ts
│       ├── play-flow.spec.ts
│       ├── review-flow.spec.ts
│       └── multiplayer.spec.ts # 4-browser live match test
│
├── server/                  # Hono API + multiplayer server (Node)
│   ├── index.ts             # Assembly: middleware, routes, WS, graceful shutdown
│   ├── app.ts               # CORS, body limits, logging, error handling
│   ├── auth.ts              # Accounts (scrypt), guest accounts, sessions
│   ├── games.ts             # Solo training records (zod-validated, user-scoped)
│   ├── friends.ts           # Friend requests / accept / remove
│   ├── teams.ts             # Persistent duo teams (own elo + division)
│   ├── party.ts             # Live party lobby (invite friends, queue together)
│   ├── engine.ts            # Typed wrapper over the Rust engine (nodejs WASM)
│   ├── match.ts             # Server-authoritative MatchSession (solo_rated /
│   │                        #   team_rated / team_vs_ai modes, bot seats, settlement)
│   ├── matchmaking.ts       # Elo-banded solo queue + duo queue, team balancing
│   ├── ws.ts                # WebSocket protocol (auth, queues, parties, actions)
│   ├── elo.ts               # Elo math, divisions ladder, milk-coin rewards
│   ├── leaderboard.ts       # Top players and top teams
│   ├── db.ts                # SQLite schema/migrations: users, sessions, games,
│   │                        #   matches, match_players, match_actions (append-only),
│   │                        #   ratings, coin_ledger (double-entry, idempotent)
│   └── tests/               # Vitest: API, elo, matchmaking, full matches, WS e2e
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
| Engine | Rust → WASM (wasm-pack) | Game rules authority, DDS, PIMC, AI opponents — shared by browser AND server |
| Frontend | React 19 + Vite 7 | UI components, routing |
| Animation | Motion 12 | Card dealing, playing, flip animations |
| State | Zustand 5 | UI state, persisted settings + auth session |
| Server | Hono + @hono/node-server | REST API (zod-validated), WebSocket multiplayer |
| Database | better-sqlite3 (WAL) | Users, sessions, games, matches, ratings, coin ledger |
| Persistence | Server API + localStorage outbox | Game history (offline-tolerant), settings |
| Worker RPC | Comlink | Typed communication with WASM Web Worker |
| Routing | wouter | Lightweight client-side routing |
| Tests | cargo test, Vitest, Playwright | 113 engine tests, 39 server tests, 15 e2e tests |

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

### Build the WASM engine (both targets)

```bash
cd engine

# Browser bundle (imported by the frontend from web/src/wasm-engine)
wasm-pack build --target web --out-dir ../web/src/wasm-engine

# Node bundle (imported by the multiplayer server from engine/pkg-node)
wasm-pack build --target nodejs --out-dir pkg-node
```

Install `wasm-pack` first if needed: `cargo install wasm-pack`.

### Install dependencies

```bash
cd web && npm install
cd ../server && npm install
```

### Run the dev servers

```bash
# Terminal 1: API + multiplayer server on :3001
cd server
npm run dev

# Terminal 2: frontend on :5173 (proxies /api and /ws to :3001)
cd web
npm run dev
```

Opens at **http://localhost:5173**. Solo play works even with the server down — history syncs when it returns.

Server configuration via env vars: `PORT`, `DB_PATH`, `CORS_ORIGINS`, `TURN_TIMEOUT_MS`, `SESSION_TTL_DAYS`.

### Run tests

```bash
# Rust engine tests (113 tests: rules, bidding state machine, DDS, PIMC, AI)
cd engine && cargo test

# Server tests (39 tests: API validation, auth, elo, matchmaking,
# full server-authoritative matches, WebSocket end-to-end with 4 bot clients)
cd server && npm test

# Type checking
cd web && npx tsc -b --noEmit
cd server && npm run typecheck

# Playwright E2E (15 tests incl. 4-browser multiplayer match; starts both servers)
cd web
npx playwright install    # First time only
npx playwright test

# DDS benchmarks
cd engine && cargo bench
```

### Production build

```bash
# 1. Build both WASM targets (see above)
# 2. Build frontend
cd web && npm run build
# 3. Run the server (serves the API + WebSocket; put web/dist behind your web server)
cd ../server && npm start
```

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

North American Euchre with stuck dealer and the no-trump-lead house rule:

- **Deck**: 24 cards (9, 10, J, Q, K, A in each suit)
- **Trump ranking**: Right Bower (J of trump) > Left Bower (J of same color) > A > K > Q > 10 > 9
- **Bidding**: Round 1 — order up the upcard or pass. Round 2 — call any suit except the turned-down one, or pass. Stuck dealer must call
- **Trump must be broken**: trump may not be LED until a trump card has been played (e.g. on a ruff). Exception: a hand holding only trump must lead it. Following suit or ruffing with trump is always allowed
- **Going alone**: Skip your partner. Win all 5 tricks for 4 points
- **Scoring**: 3-4 tricks = 1 point. All 5 tricks = 2 points. Euchre = 2 points to defenders. First to 10 wins

## License

MIT
