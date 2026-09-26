# Product Price Tracker — Agent Context

## Goal
Full-stack price tracker vs mock store https://demo.inelabteamdev.com.
Search by name → pick product + option → track → scrape price/stock q2h →
history + per-product scrape log + CSV export + headed demo.
Reliability > UI. AI allowed but must be understood/disclosed.

## Architecture (3 tables, 3 concerns)
- `products` (table 1): catalog of all 960, static. Powers search/option pick.
- `tracked_products` (table 2): only user-selected product+option combos, `active` flag. Cron source of truth.
- `scrape_runs` (table 3): per-attempt history (success + retries + failures). Shown as log/charts/CSV.
- Flow: cron → tracked (active only) → scraper → scrape_runs. NEVER scrape all 960 on schedule.

## Build order (agreed)
`1 → 3` now, stub `2`, full `2` API later.
1. products table + COPY 960 now.
2. tracked_products: schema + 2-3 manual seeds only (no user CRUD yet).
3. scrape_runs + core scraper experiment (the important bit).
Reason: table 2 API/cron pipeline is easy; table 3 core scraping is risky.

## Catalog (done, local files)
- `GET /api/v2/listings?page={1..16}&limit=60` → total 960, shuffled per request.
- Detail: `GET /api/v2/items/{id}`, ids 2001–2960 contiguous.
- `fetch-listings.js`: DRIFTED (TARGET_UNIQUE=980, OUT_FILE=test_listings.csv) — needs align to 960/listings.csv, obsolete anyway.
- `listings.csv`: 960 rows, id,slug,name,brand,category,sku,description.
- `fetch-products.js`: OK — adaptive backoff START 1500/MIN 1200/MAX 8000ms, 800*2^n, reset after 5 ok, Retry-After, resumable via col-1.
- `products.csv`: header + 960, +specs,option_axis,options (JSON-stringified, optionAxis→option_axis). 0 bad JSON, 0 empty axis.
- products schema: `id int PK, slug text unique not null, name text not null, brand/category/sku/description text, specs jsonb default '{}', option_axis text default '', options jsonb default '[]', created_at timestamptz`. Indexes brand/category. RLS enabled, NO policies (private, app-only via direct PG).
- No reviews. No static price in products — price lives in scrape_runs.

## Scraper: CRACKED (HTTP-only, verified live)
- Bundle `/assets/index-*.js` holds whole protocol; `Xn` flaky-clicks 35%; `jr=6` retries, `300*n`ms backoff, `Er`=retryable (503/429) vs `Tr`=fatal; `/api/v2/ui/manifest` randomizes classes/order.
- Chain per attempt: `GET handshake` → PoW `sha256(salt:nonce)`→`difficulty` zeros → `wasm exports.f(input)|0` (no imports; input=`u32(sha256(DR|seed|salt|attHash))`) → `derived=sha256(DR|derive|salt|wasmOut|attHash)` → `POST` (+synth att: ≥8 moves, ≥600ms dwell, trusted) → `pass` (per-item:opt, 30s TTL) → `GET quote?opt=` Bearer → blob XOR `sha256(DR|enc|pass)` → JSON `{q:price, a:stock, u:currency}`. `DR=feffd9…4b56` (bundle string table).
- Offline replay vs captured 2212/o2 trace: PoW + wasmOut + derived + blob(12009 INR, 169 units) all match.
- Live: 2670/o3→10411×38 (1 att, 599ms), 2304/o3→15452×143 (2 att), 2001/o2→182529×49 (1 att). Stock: number>0=in_stock, 0/sold-string=sold_out(success, price=q as listed).
- Code: `backend/src/scraper/{protocol,blob,index}.ts` (`scrapeProduct`→typed result, MAX_RETRIES=6, per-attempt timeout, `onAttemptError`), `scripts/scrape-once.ts`.
- tracked_products: `id, product_id FK, option_id, active, created_at` (+unique) — NO option_label (derived via join, verified). Seeds: 2670/o3, 2304/o3, 2001/o2.
- Site behavior context: cookie/consent popup; price hidden until hover → "Check Today's Price"; HTTP bypasses `Xn` flaky-click entirely (Playwright fallback would need state-driven wait, not double-click).
- Track prominent selling price (`q`), not member price. Site-retry ("Loaded in N attempts") ≠ our retry layer.

## Reliability contract
- `MAX_RETRIES=6` (mirror frontend).
- Row-per-attempt in scrape_runs: retries/failures are visible rows, never silent.
- Never store unverified/empty price. Never discard failures. No fixed sleeps where state-wait works.
- Immediate per-attempt DB write (no buffering) so Render sleep/crash loses nothing.
- Sequential, per-attempt timeout, exp-backoff, idempotent re-runs. No queues (no BullMQ/pg-boss); Postgres `next_due_at` + SKIP LOCKED only when cron lands.
- Scheduling: cron-job.org q2h — warmup `GET /health` (touches DB via `select 1`) at `:55`, scrape `POST /api/schedule/scrape` at `:00` (Render sleeps, no while(true)). Scrape idempotent; partial progress kept on re-run.
- `sold_out` = `success` row (price = blob's `q` as listed now, stock='sold_out') — availability lives in stock, never in price-null. Proven: 2002/o1 blob q=159330 matched storefront to the rupee; q moves while out of stock (159330→157378), so it is live data, not "last price". Pre-change row (id 3, price null) kept as artifact.
- Outcome vocabulary (spec): non-final attempts `retried`, terminal `success`/`failed`.
- Sequential scraping (measured 0.6–1.1s/item; 10 items ≈ 10–15s). Bounded concurrency (limit 3) only if tracked grows past ~40. ~500ms stagger between items.
- Soak gate before cron: 36-check polite soak, pass = ≥95% success + zero unknown error shapes. Results: PASS 36/36 (2026-09-26, fixes: same-pass quote retry on 503, exp-backoff 800*2^n + Retry-After honor). Known transient shapes only: quote 401-spurious/500/503, handshake 429. Store 500/503 bursts + dynamic price toggling (2670: 12148/10411, 2304: 15452/13265, 2001: 160567/172451/188775) are server-side, absorbed by retries.

## Schemas (live in Supabase)
```sql
tracked_products(id int identity PK, product_id int→products, option_id text, active bool default true, created_at timestamptz, unique(product_id,option_id)); -- NO option_label, derived via join
scrape_runs(id int identity PK, tracked_id→tracked_products, attempt int, started_at/finished_at timestamptz, price numeric null, stock text null, outcome text, error text null, duration_ms int);
```
Seeds: 2670/o3, 2304/o3, 2001/o2 (all active). RLS on, no policies.

## Env / stack (local-first, Render later)
- `.env`: `DB_POOLER_URI` (:6543 pooler, runtime AND migrate/load — direct `:5432` is IPv6-only, unreachable from this network), `DB_DIRECT_URI` (kept for networks with IPv6). Legacy `host/port/database/user` fragments ignored.
- Table 1 DONE: `products` live in Supabase, 960/960 rows verified, RLS on, loader `backend/load-products.py` (idempotent batch upsert, rerunnable).
- Express + `pg` + Drizzle (not Prisma — RAM/cold-start; no @supabase/ssr — Next-only). Pooler: `max:5, prepare:false` (PgBouncer txn mode) + SSL. Direct: migrations/COPY only. Secrets server-side only.
- Skills: `.agents/skills/supabase` (imperative: iterate via execute_sql/psql → advisors → `migration new` + `db pull`; RLS on all public tables; Data API ≠ RLS) + `supabase-postgres-best-practices` (COPY for bulk, pooling, RLS basics, text/timestamptz/jsonb types).

## Immediate next
CSV export endpoint → frontend DONE (Vite React TS: api.ts, SearchBar, CatalogTab, ProductView, TrackedTab, HistoryView w/ Recharts + now-dot, plain App.css, /api proxy, recharts lazy chunk; oxlint + tsc -b + vite build clean; verified in real browser: catalog/search/badges/product+preview/tracked/history+log). Remaining: per-product CSV `source:live` now-row DONE (full export DB-pure, 404 unknown, zero writes proven) + disconnect-safe cron response (EasyCron 5s) → cron-job.org wiring → headed recording → deploy → README/design note. API spec: `backend/docs/api.md`. Backend DONE: catalog reads, tracked CRUD + pause/resume (resume re-scrapes), ephemeral preview (zero writes), combined history, cron scrape with per-attempt writes, CSV export (all + per-product, verified vs DB). Headed mode: `npm run headed` (stage-event narration, zero writes, opt-in --csv via shared `lib/csv.ts`). Root README (setup/schedule/env/headed). 4 tracked seeds (3 original + 2212/o2).
