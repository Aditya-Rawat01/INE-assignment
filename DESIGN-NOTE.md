# Design Note — Product Price Tracker

## 1. How the scraping was made reliable

The mock store never exposes prices to scrapers. Each price requires: fetching
a challenge (salt, difficulty, a small program) → solving the proof-of-work
(`sha256(salt:nonce)` with leading zeros) → executing the program → posting the
solution → receiving a 30-second per-item pass → fetching an XOR-encrypted blob
→ decrypting it. I reverse-engineered this chain from the storefront's JS bundle
and verified every step against a captured trace (nonce, program output, binding
hash, decrypted price all replayed exactly) before trusting it — full writeup in
`backend/docs/protocol.md`.

Reliability layers, each from a real incident:
- **Retry taxonomy**: retryable (quote 503/429, spurious 401s) vs fatal (bad
  shapes). Up to 6 attempts mirroring the frontend, same-pass retry on 503s,
  exponential backoff (`800·2ⁿ`, cap 8s) honoring `Retry-After`. The backoff
  exists because rapid re-handshakes spiraled into 429 cascades in testing.
- **Honest history**: one `scrape_runs` row per attempt — `success`, `retried`
  (non-final), `failed` (terminal, price/stock empty + error text). Sold-out is
  `success` with the as-listed price and `stock='sold_out'` (verified against
  the storefront to the rupee). Nothing unverified is ever stored.
- **Unattended-safe**: sequential scraping (~1s/item), 90s job deadline with
  `skipped` reporting, idempotent re-runs, disconnect-safe responses (a severed
  cron connection can't crash a finished job), external scheduler (free tier
  sleeps) + hourly warmup, secret-gated trigger.
- **Measured, not claimed**: 36-check soak (36/36 after fixes), an hour at 12×
  required cadence with zero terminal failures, overnight q2h runs accumulating
  cleanly.

## 2. Trade-offs

- **HTTP over Playwright**: the site's own click handler no-ops 35% of the time
  (found in its code) — a browser would fight that; plain requests bypass it
  entirely. The challenge program runs in Node's WebAssembly, no browser needed.
- **Sequential over concurrent**: ~1s/item makes 10 items ≈ 15s; concurrency
  would buy seconds at the cost of rate-limit risk. Revisit past ~40 items.
- **Thin `tracked_products`** (product FK + option + active flag; labels derived
  via join): the catalog is never duplicated or re-scraped on schedule.
- **Write-path invariant**: only Track-click first scrape, resume scrape, and
  cron runs write history. Previews and reads never do — enforced by routing
  writes through one shared function.
- **Scheduler saga**: EasyCron free blocks Render domains and can't POST;
  cron-job.org misfired phantom failures; FastCron proved metronomic (error-free
  trace over 25+ minutes) with POST + headers on free. Judge by DB rows, never
  by scheduler dashboards.

## 3. AI tools: what they got wrong, and corrections

AI assistance was used for scaffolding, protocol reverse-engineering support,
and routine implementation. All product decisions, field captures, and test
designs are mine. Concrete corrections I made to AI output:
- Aggressive 400ms retry backoff → caused 429 cascades; replaced with
  exponential backoff + `Retry-After` after my soak test exposed it.
- Stale dev server served old code during a demo; caught via a missing
  response field, fixed with explicit env loading + port hygiene.
- CSV append duplicated headers; fixed with refuse-by-default + `--append`.
- Arg-parsing regression (dropped first CLI arg) caught by my runs, twice.
- Missing CORS on the cross-origin deploy; added allowlist + documented that
  CORS is hygiene, the secret is the gate.
- Wrong cron pairing (`:55` on even hours = 65-min gaps vs Render's 15-min
  sleep); corrected to hourly warmup after I spotted it in the schedule.

## 4. Bonus status

Satisfied without extra code: multi-product dashboard (tracked tab) and
every-option-per-run coverage (one cron firing covers all tracked options;
per-option handshakes are protocol-mandated). CI runs backend typecheck +
frontend lint/build on every push. Email alerts, per-product frequencies, and
explicit change detection were deliberately left out (unneeded runtime surface
before a deadline; breakage already surfaces as honest failed rows).
