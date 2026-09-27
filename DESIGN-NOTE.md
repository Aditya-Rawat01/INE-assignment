# Design Note — Product Price Tracker

## 1. How the scraping was made reliable

The mock store never shows prices to scrapers. Each price requires: fetching
a challenge (salt, difficulty, a small program) → solving the puzzle
(`sha256(salt:nonce)` with leading zeros) → running the program → posting the
solution → receiving a 30-second per-item pass → fetching an encrypted blob →
decrypting it. I reverse-engineered this chain from the storefront's JS bundle
and checked every step against a real captured run (the puzzle answer, the
program output, and the decrypted price all matched exactly) before trusting
it — full writeup in `backend/docs/protocol.md`.

What keeps it working night after night, each lesson from something that
actually broke:
- **Knowing what to retry**: server hiccups (quote 503/429, random 401s the
  server throws for no reason) get retried; genuinely bad responses don't.
  Up to 6 attempts like the storefront itself, reusing the same pass on 503s,
  and backing off exponentially (`800·2ⁿ`, max 8s) while respecting the
  server's slow-down headers. That backoff exists because retrying too fast
  once spiraled into a flood of rate-limit rejections during testing.
- **Honest history**: one `scrape_runs` row per attempt — `success`, `retried`
  (tries before the last one), `failed` (gave up; price and stock left empty,
  error written down). Sold-out is `success` with the listed price and
  `stock='sold_out'` (checked against the storefront down to the rupee).
  Nothing unverified is ever stored.
- **Built to run alone**: one product at a time (~1 second each), a 90-second
  cap per scheduled run with the leftovers reported as skipped, safe to re-run
  (running twice never corrupts anything), answers that survive the caller
  hanging up (cheap schedulers cut the connection at 5 seconds — the work
  finishes anyway), an outside scheduler since the free server sleeps, an
  hourly warmup ping, and a shared secret on the trigger.
- **Measured, not claimed**: 36 back-to-back checks (36/36 after fixes), an
  hour at twelve times the required pace with zero total failures, and
  overnight runs every 2 hours piling up cleanly.

## 2. Trade-offs

- **Plain requests over a browser**: the site's own click handler does nothing
  35% of the time (found in its code) — a browser would fight that; plain
  requests skip it completely. The challenge program runs in Node directly,
  so no browser was ever needed.
- **One at a time over parallel**: ~1 second per item means 10 items take
  about 15 seconds; parallel would save seconds and risk rate limits.
  Revisit past ~40 tracked items.
- **Slim tracking table** (product link + option + on/off flag; labels looked
  up from the catalog): the catalog is never copied or re-scraped on schedule.
- **One rule for all writes**: only the Track button's first scrape, the
  resume scrape, and the scheduled runs write history. Previews and page
  views never do — enforced by sending every write through a single shared
  function.
- **Scheduler story, short version**: EasyCron's free tier blocks Render
  addresses and can't send POST requests; cron-job.org reported failures that
  weren't real; FastCron ran like clockwork for 25+ minutes straight with POST
  and headers on free. Judge by database rows, never by scheduler dashboards.

## 3. AI tools: what they got wrong, and corrections

AI assistance was used for scaffolding, help understanding the store's code,
and routine implementation. All product decisions, captured evidence, and test
designs are mine. Things I had to fix in AI-written output:
- Retry delays of 400ms → caused rate-limit spirals; replaced with
  exponential backoff + slow-down headers after my soak test exposed it.
- A stale dev server served old code during a demo; caught by a missing field
  in a response, fixed with explicit env loading and port hygiene.
- CSV export wrote the header twice when appending; fixed with refuse-by-
  default plus an explicit `--append` flag.
- A command-line parsing bug that swallowed the first argument; caught by my
  own runs, twice.
- No CORS rules on the deployed cross-origin setup; added an allowlist and
  documented that CORS is hygiene while the shared secret is the real lock.
- Wrong cron pairing (warmup 65 minutes before the scrape on a server that
  sleeps after 15 idle minutes); corrected to an hourly warmup after I
  spotted it in the schedule.

## 4. Bonus status

Done without extra code: multi-product dashboard (tracked tab) and
every-option-per-run coverage (one scheduled run covers all tracked options;
per-option handshakes are forced by the protocol itself). CI runs the backend
typecheck plus frontend lint and build on every push. Email alerts,
per-product frequencies, and explicit change detection were deliberately left
out (new moving parts hours before a deadline; breakage already shows up as
honest failed rows).
