# Backend API

Base: `http://localhost:3000` locally. All responses JSON.

## Catalog (public reads, no auth)

### `GET /api/products?page=1&limit=20`
Stable id-ordered listing (never the store's shuffle). `limit` default 20, max 60.
→ `{page, limit, total: 960, totalPages, items: [{id, slug, name, brand, category}]}`

### `GET /api/products/search?q=&page=1&limit=20`
Substring `ILIKE` on name + brand (wildcards escaped, literal match), `ORDER BY id`.
Empty `q` → 400. Same envelope + `q` echoed.
Frontend: debounce ~300ms, abort in-flight on new keystroke.

### `GET /api/products/:id`
Full detail: `id, slug, name, brand, category, sku, description, specs, option_axis, options[{id,label}]`.
Unknown id → 404. Powers option chips + Track button.

## Tracking (live)

- `POST /api/tracked {productId, optionId}` — verify vs catalog (404 bad id, 400 bad option) → insert → immediate scrape → persist. Duplicate → 409 + existing row, no re-scrape.
- `GET /api/tracked` — `{total, items: [{id, product_id, name, option_id, option_label, active, created_at}]}`.
- `PATCH /api/tracked/:id {active}` — pause needs no scrape; resume (false→true) scrapes immediately + persists (`resumedResult`, `rowsWritten`). No-op change returns row as-is.

## History (live)

- `GET /api/tracked/:id/history?limit=` (max 500) — `{tracked, latest (recent success or null), points[] (success rows, chronological, chart-ready), log[] (all attempts incl. failures, newest first)}`.
- `GET /api/products/:id/preview?option=` — **ephemeral** live price for the product page; `{…, ephemeral: true, notStored: true}`, zero `scrape_runs` writes (verified 5→5).
## Export (live)

- `GET /api/history.csv[?trackedId=]` — complete history (or one product) as download:
  `product_id,product_name,option_id,option_label,timestamp_utc,price,stock,outcome,error,source`
  (`source`: `history` = stored row, `live` = ephemeral now-row). One row per attempt,
  chronological; per-product exports append one fresh live row (never stored),
  full export stays DB-pure. Bad `trackedId` → 400, unknown → 404.

Write-path invariant: only Track-click first scrape, resume scrape, and cron runs write `scrape_runs`. Previews and reads never do.

## Ops (live)

- `GET /health` — `{ok:true}`, touches pool (`select 1`); scheduler warmup target
- `POST /api/schedule/scrape` — header `x-cron-secret: $CRON_SECRET` (401 otherwise);
  sequential over active tracked, 500ms stagger, 90s deadline (`skipped` beyond it);
  per-attempt `scrape_runs` writes (`success`/`retried`/`failed` vocabulary);
  → `{ran, succeeded, failed, skipped, rowsWritten, persistErrors, ms, items[]}`
- Headed: `npm run headed [-- productId optionId] [--csv out.csv] [--append]` — same core,
  terminal narration via stage events, zero DB writes (see README). `--csv` refuses
  an existing file unless `--append` is passed.
