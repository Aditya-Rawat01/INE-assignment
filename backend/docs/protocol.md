# Store Scraping Protocol (demo.inelabteamdev.com)

Reverse-engineered from the storefront bundle `/assets/index-*.js`
(app code region ~271–276KB; identifiers below are the bundle's minified names).
Ground truth: captured 2212/o2 trace (2026-09-26) — PoW, wasm output, derived
hash, and blob decryption all replayed exactly in Node. See `src/scraper/`.

## 1. Where things live in the bundle

| Bundle symbol | Role |
|---|---|
| `Dr(id, opt, attSnapshot)` | full quote chain (handshake → quote → decrypt) |
| `Er` / `Tr` | site-side taxonomy: retryable (quote 503, 429) vs fatal (bad solution, 401/403). We deliberately diverge on 401/403 — re-handshake and retry (durability over the site's fail-fast UX); see step 7 |
| `Ar` | interaction tracker: ≥8 moves (`minMoves`), ≥600ms dwell (`minDwellMs`), 40-move buffer, 40ms throttle |
| `jr = 6` | max attempts; retry delay `300*n` ms (`Pr`) |
| `Xn` | click wrapper that no-ops/delays 35% of the time — the "unreliable click", deliberate |
| `wr(blob, pass)` | XOR-decrypt + field map |
| `Ur/Fr/Vr/Wr/Ir` | display-only price formatting/decoys — irrelevant, we take raw `shown` |
| `GET /api/v2/ui/manifest` | per-request randomized class names + section order — the "page shifts"; API-level scraping is immune |

## 2. String table + `DR`

Strings are obfuscator.io-encoded (`ur` array, `lr` base64 decoder with `-164`
offset, rotation IIFE). Decoded with a Node eval of the three segments.
`dr` = concatenation of table entries 232+295+166+294+297+198+221+272+253+169+172:

```
DR = feffd924900aae681d40425da2e3f3ef53e3ab0a8c2e6acd330b5265f3794b56
```

`fr` = SHA-256 initial constants → the bundle's `mr`/`_r` is plain SHA-256
(hex). Node `crypto` replaces it; only the challenge `wasm` needs `WebAssembly`.

## 3. Attempt chain (fresh handshake every attempt)

1. `GET /api/v2/handshake` → `{salt, ts, difficulty, csig, wasm}`.
   (`csig` is echoed back, never verified client-side.)
2. PoW (`xr`): smallest `nonce` with `sha256(salt + ":" + nonce)`
   starting with `difficulty` zeros. Verified: `sha256("c9e4…:10266")`
   = `000a18…` at difficulty 3 (~4k hashes, milliseconds).
3. Attestation (`cr` + `Ar.snapshot`): `{env: {canvas, gl, hc, scr, frames, at},
   ix: {hoverAt, dwellMs, moves, clickAt, trusted}}`. We synthesize it:
   random hex fingerprints, 10–17 plausibly-walked moves, 8–20s fabricated
   dwell, `trusted: true`. No waiting — timestamps are just numbers.
   Verdict after 100+ live attempts: validation is loose. Identical synth-att
   succeeds on immediate re-handshake; the ~10–15% spurious 401s are transient,
   never att-driven. Contingency (unused): harvest one real telemetry sample via
   a headed browser and replay its shape with fresh timestamps.
4. `attHash = sha256(attString)`; `wasmInput = u32be(sha256(DR|seed|salt|attHash)[0:8])`;
   `wasmOut = exports.f(wasmInput)|0` (module has no imports; Node runs it as-is).
   Verified: input `1047812039` → `-964402921`, exact match.
5. `derived = sha256(DR|derive|salt|wasmOut|attHash)` — binds puzzle solution +
   wasm output + attestation together. Verified exact match (`5191e8…`).
6. `POST /api/v2/handshake` with puzzle fields + `{nonce, derived, wasmOut,
   att (stringified), itemId, option}` → `{pass, ttlMs: 30000}`.
   429 → retryable; other non-OK → retry with a fresh puzzle (cheap).
7. `GET /api/v2/items/{id}/quote?opt={opt}`, `Authorization: Bearer {pass}` →
   `{itemId, option, ver, blob, ts}`. 401/403 → fresh handshake + retry
   (the server spuriously rejects fresh passes ~10–15% of the time — always
   succeeds on re-handshake; a same-pass retry does NOT help a 401).
   Other non-OK (503 `upstream …`) → first retry with the SAME pass
   (mirrors the site's own retry, avoids handshake pressure that cascades
   into 429s), then fresh handshake. Implemented + soak-verified 36/36.
8. Decrypt: `key = sha256(DR|enc|pass)`, XOR over base64-decoded blob →
   JSON. Verified: `{"q":12009,"l":9833,"o":10,"a":169,"u":"INR",…}`.

## 4. Blob field map (`wr`)

| Key | Meaning | We use |
|---|---|---|
| `q` | prominent selling price (`shown`) — present even when out of stock (verified = storefront figure: 2002/o1 → 159330; moves while out of stock, 159330→157378, so it is live data, not a frozen placeholder) | **yes — the tracked price** |
| `a` | stock (number = units; string/0 = sold out — vocabulary confirmed live) | yes |
| `u` | currency | yes |
| `l/k/o` | list/member/discount figures | no |
| `h/hn/vd/eta` | rating, rating count, seller, delivery days | no |
| `w/z/j/i` | timestamps, variant flags (`j===1` pending, `i===1` triple) | no |

Validation (never store unverified data): `q` must be a finite number > 0;
stock must be a finite number or non-empty string. Anything else → `failed`,
nothing written except the failure row.

## 5. Pass binding + TTL

The pass embeds `METHOD|path|itemId:option|…|expiry` (base64 prefix decodes to
e.g. `GET|/api/v2/items/2212/quote|2212:o2|…`). So: **one handshake per
product+option**, usable for that quote for 30s. Our handshake→quote gap is
milliseconds — TTL is a non-constraint. The 503 same-pass retry (the site's own
"Loaded in N attempts" behavior) is implemented, not future work.

## 6. Reliability mapping

- `MAX_RETRIES = 6` mirrors the frontend (`jr`).
- Backoff is ours, not the site's `300*n`: `800·2ⁿ` ms (cap 8000, +jitter),
  always honoring the server's `Retry-After`. Cause: rapid re-handshakes after
  a failure spiraled into `POST 429`s (soak run 1); the same-pass 503 retry +
  this backoff eliminated 429s entirely in run 2.
- Site-retry ("Loaded in 2 attempts") ≠ scraper retry: direct HTTP sees the raw
  503 with no browser to absorb it — our loop owns it.
- HTTP bypasses `Xn` (35% flaky click) entirely — the core justification for
  HTTP-first over Playwright in the design note.
- `sold_out` (price = as-listed `q`, stock `'sold_out'`) is `success`;
  non-final attempts are `retried`; terminal failures are `failed`
  (`price/stock null` + error text). Row-per-attempt in `scrape_runs`.
