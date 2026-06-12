# Deployment Plan — Euchre Training App

Target: production deployment supporting **up to ~100 concurrent users**
(roughly 25 simultaneous tables) with real-money-free stakes, low ops burden,
and a clear path to grow later.

---

## 1. Architecture decision: one box, one process

The multiplayer server keeps matchmaking queues, parties, and live matches
**in process memory** by design. That means exactly **one server instance** —
which is also the right call at this scale:

| Resource | Worst case @ 100 users | Single-process capacity |
|---|---|---|
| WebSocket connections | ~100 | tens of thousands |
| Live matches | ~25 | thousands (each engine action is sub-millisecond; the DDS solver benches at ~25 µs) |
| State broadcasts | ~4 × 2 KB per action, ~10 actions/min/table ≈ 35 KB/s total | trivial |
| SQLite writes | ~1 insert per action ≈ 5–50 writes/s | WAL mode handles thousands/s |
| CPU | solo-game analysis (PIMC) runs in the **player's browser**, not the server | server only validates moves + runs heuristic AI |
| RAM | Node + WASM engine + 25 matches | < 300 MB |

**Recommended host: one small VPS** (Hetzner CX22 / DigitalOcean Basic /
Lightsail — 2 vCPU, 2–4 GB RAM, ~$5–12/mo) running:

```
                    ┌──────────────────────────── VPS ───────────────────────────┐
 Browser ── HTTPS ──►  Caddy (:443, auto-TLS)                                    │
                    │    ├── /            → serve web/dist (static SPA + PWA)    │
                    │    ├── /api/*       → reverse_proxy localhost:3001         │
                    │    ├── /healthz     → reverse_proxy localhost:3001         │
                    │    └── /ws          → reverse_proxy localhost:3001 (WS)    │
                    │  Node 22 (systemd)  → server/index.ts via tsx              │
                    │  SQLite (WAL)       → /var/lib/euchre/euchre.db            │
                    │  Litestream         → continuous DB replication to S3/B2   │
                    └─────────────────────────────────────────────────────────────┘
```

Why this shape:
- **Same-origin everything.** Caddy serves the SPA and proxies `/api` + `/ws`,
  so no CORS pain, cookies/tokens stay simple, and the client's existing
  `wss://{location.host}/ws` URL works unchanged.
- **Caddy** gives automatic Let's Encrypt TLS, HTTP/2, gzip, and static-file
  caching in ~15 lines of config.
- **SQLite stays.** At 100 users a Postgres migration is pure overhead.
  Litestream gives point-in-time restore for pennies.
- PaaS alternative: **Fly.io** (1 machine + volume) or **Railway** work fine if
  you prefer git-push deploys — the constraint either way is *exactly one
  instance* (no horizontal autoscaling).

---

## 2. Pre-deploy code checklist

1. ~~Stale-match cleanup on boot~~ — **DONE**: `abandonStaleMatches()` runs at
   server startup (`server/index.ts`); matches stranded by a restart are
   marked `abandoned` (no elo settles for them).
2. ~~Client WebSocket heartbeat~~ — **DONE**: `MatchClient` pings every 30 s
   while connected, so idle proxies/NAT can't drop quiet sockets.
3. ~~Rate-limit auth endpoints~~ — **DONE**: `POST /api/auth/login|register|guest`
   are capped at 30/min per IP (`server/ratelimit.ts`, reads X-Forwarded-For
   from the reverse proxy). Authenticated endpoints are not limited.
4. **Env review (per deploy).** Set `PORT=3001`,
   `DB_PATH=/var/lib/euchre/euchre.db`, `CORS_ORIGINS=https://yourdomain.com`
   (belt-and-suspenders; same-origin makes it mostly moot),
   `NODE_ENV=production`.
5. **Compile instead of tsx (optional).** `tsx` in prod is acceptable at this
   scale; if you want faster cold starts add `"build": "tsc"` and run
   `node dist/index.js`.

---

## 3. Build pipeline

Build happens on your machine or CI; the VPS only receives artifacts.

```bash
# 1. Engine (both targets)
cd engine
wasm-pack build --target web    --out-dir ../web/src/wasm-engine
wasm-pack build --target nodejs --out-dir pkg-node

# 2. Frontend (564 KB total, gzip ~180 KB)
cd ../web && npm ci && npm run build         # → web/dist

# 3. Tests must be green before any deploy
cd ../engine && cargo test
cd ../server && npm ci && npm test
cd ../web && npx playwright test
```

Ship to the server (rsync or a git checkout + build):
- `web/dist/` → `/srv/euchre/dist`
- `server/` + `engine/pkg-node/` → `/srv/euchre/` (run `npm ci --omit=dev` on
  the box — `better-sqlite3` is a native module and must be built for the
  server's platform)

---

## 4. Server configuration

### Caddyfile (`/etc/caddy/Caddyfile`)

```caddy
yourdomain.com {
    encode gzip

    handle /api/* {
        reverse_proxy localhost:3001
    }
    handle /healthz {
        reverse_proxy localhost:3001
    }
    handle /ws {
        reverse_proxy localhost:3001     # WebSocket upgrade is automatic
    }
    handle {
        root * /srv/euchre/dist
        try_files {path} /index.html     # SPA fallback
        file_server
    }
}
```

### systemd unit (`/etc/systemd/system/euchre.service`)

```ini
[Unit]
Description=Euchre multiplayer server
After=network.target

[Service]
WorkingDirectory=/srv/euchre/server
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=2
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=DB_PATH=/var/lib/euchre/euchre.db
Environment=CORS_ORIGINS=https://yourdomain.com
# Keep the box safe from a runaway process
MemoryMax=1G
User=euchre

[Install]
WantedBy=multi-user.target
```

### Litestream (`/etc/litestream.yml`)

```yaml
dbs:
  - path: /var/lib/euchre/euchre.db
    replicas:
      - url: s3://your-bucket/euchre   # works with Backblaze B2 / R2 / S3
```

`litestream replicate` runs as its own systemd service; restore with
`litestream restore`. Cost: cents per month. (Minimal alternative: a nightly
`sqlite3 /var/lib/euchre/euchre.db ".backup /backups/euchre-$(date +%F).db"`
cron + offsite copy.)

---

## 5. Deploy runbook (first deploy)

1. Provision VPS (Ubuntu 24.04), create `euchre` user, point DNS A record.
2. `apt install caddy`; install Node 22 (NodeSource) and litestream.
3. `mkdir -p /srv/euchre /var/lib/euchre && chown euchre /var/lib/euchre`.
4. Copy artifacts (§3), `cd /srv/euchre/server && npm ci --omit=dev`.
5. Install the systemd unit + Caddyfile + litestream config; `systemctl enable --now euchre caddy litestream`.
6. Smoke test:
   - `curl https://yourdomain.com/healthz` → `{"ok":true}`
   - `curl -X POST https://yourdomain.com/api/auth/guest` → token + profile
   - Open the site in two browsers → guest login → friend → team → Play vs AI
   - `curl https://yourdomain.com/api/presence` → counts match reality
7. Add uptime monitoring on `/healthz` (UptimeRobot/Healthchecks.io, free).

### Subsequent deploys

Restarts kill in-flight matches (in-memory state). With ≤100 users this is a
brief, visible blip — keep it polite:

1. Deploy when `/api/presence` shows `inGame: 0`, or accept that active
   matches abandon (no elo is settled for abandoned matches; nobody is unfairly
   penalized — pre-deploy item #1 cleans up the rows).
2. `rsync` new artifacts → `systemctl restart euchre`. Downtime ≈ 2 s; clients
   auto-reconnect (the WS client retries with backoff and re-attaches to
   matches — but matches won't survive the restart itself).

---

## 6. Operations

- **Logs**: Hono request logs go to stdout → `journalctl -u euchre`. Caddy
  logs cover the static/TLS side.
- **Metrics worth watching** (all available cheaply): `/api/presence` counts,
  `journalctl` error grep, VPS CPU/RAM, SQLite file size (expect MBs, not GBs).
- **Security posture already in place**: scrypt password hashing, hashed
  session tokens, zod validation on every endpoint, server-authoritative
  games, idempotent coin ledger, body-size limits. Add the auth rate limit
  (§2.3) and keep the VPS patched (`unattended-upgrades`).
- **Data**: `euchre.db` is the only state. Litestream + an occasional manual
  backup before schema migrations is sufficient.

---

## 7. When you outgrow this (>~500 concurrent)

Not needed now; the seams are already in the code:

1. **Postgres** swap for better-sqlite3 (the SQL is vanilla; the schema was
   written to port — see comments in `server/db.ts`).
2. **Split match hosting from the API**: `MatchSession` is self-contained;
   shard live matches across worker processes by match id, route WS by a
   match→worker map in Redis.
3. **Sticky-session load balancing** for the WS tier; queues move to Redis.
4. **CDN** for the static bundle (it's 564 KB total — Cloudflare free tier in
   front of Caddy is a one-toggle win even today).

Estimated monthly cost for the 100-user setup: **$6–15** (VPS + backup
storage + domain).
