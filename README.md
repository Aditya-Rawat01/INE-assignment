# Product Price Tracker

> 🎥 **Submission video:** <video controls src="https://res.cloudinary.com/dlvcibxgx/video/upload/q_auto:best/v1790510884/submission_loud_3x_1.1x_trim-subtitled_1_vrslp4.mp4" title="https://res.cloudinary.com/dlvcibxgx/video/upload/q_auto:best/v1790510884/submission_loud_3x_1.1x_trim-subtitled_1_vrslp4.mp4"></video>

### 🟢 **Live app:** https://ine-assignment-nine.vercel.app/

### 🟢 API: https://ine-assignment.ardev.in/health

Track mock-store products (https://demo.inelabteamdev.com): search → pick product + option →
scrape price/stock every 2h → history, per-product scrape log, CSV export.

## Setup

```bash
# backend
cd backend && npm install
# frontend
cd frontend && npm install
```

## Environment variables

Backend reads `../.env` (repo root). Required:

| Var             | Purpose                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DB_POOLER_URI` | Supabase pooler `:6543` — runtime queries, migrations, loads (direct `:5432` is IPv6-only; unreachable from most networks) |
| `DB_DIRECT_URI` | Supabase direct `:5432` — kept for IPv6-capable networks                                                                   |
| `CRON_SECRET`   | Shared secret for `POST /api/schedule/scrape` (`x-cron-secret` header)                                                     |
| `FRONTEND_URL`  | Public frontend origin for CORS allowlist (exact match; scripts/cron unaffected)                                           |
| `PORT`          | Backend listen port (default 3000)                                                                                         |

Frontend: `VITE_API_URL` (production API base; dev uses the Vite `/api` proxy).

## Run

```bash
cd backend
npm run dev      # tsx src/server.ts (:3000)
npm run build && npm start   # production (tsc → dist)
```

## Scraping schedule (FastCron, q2h)

| Job    | When                   | Target                                                          |
| ------ | ---------------------- | --------------------------------------------------------------- |
| Warmup | hourly at `:55`        | `GET /health` (touches DB pool; free tier sleeps without it)    |
| Scrape | every 2 hours at `:00` | `POST /api/schedule/scrape` + `x-cron-secret` header, retry OFF |

Scrape is sequential over active `tracked_products` (~500ms stagger, 90s deadline),
one `scrape_runs` row per attempt (`success` / `retried` / `failed`).

## Headed (= observable) mode

There is no browser by design (see `backend/docs/protocol.md`) — "headed" means
the scraper narrates itself live in your terminal:

```bash
cd backend
npm run headed [-- productId optionId] [--csv out.csv]
```

- No args → loops all active tracked items (cron-like). With args → single item.
- Prints per-stage events: handshake, PoW nonce, wasm output, pass, quote
  retries (503 → same-pass retry, 401 → fresh handshake), decrypted price/stock.
- Exit `0` = all success, `2` = any failure. **Writes nothing** — console only,
  plus `--csv` file only when requested (same 10 columns as `/api/history.csv`).
- `--csv` modes: plain `--csv out.csv` creates a new file and **refuses if it
  exists** (delete it or add `--append`); `--append` adds rows to an existing
  file without repeating the header. Overwrite = `rm` + re-run (deliberately
  manual — no silent data loss).
- Recorded this in submission video; slow/failing responses
  appear as labeled retry lines absorbed live, with max 6 retries.
