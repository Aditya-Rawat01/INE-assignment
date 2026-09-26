import { createHash } from 'node:crypto';

// Reverse-engineered from demo.inelabteamdev.com bundle (/assets/index-*.js):
// GET /api/v2/handshake -> PoW puzzle -> POST solution -> 30s Bearer pass ->
// GET /api/v2/items/{id}/quote?opt={opt} -> XOR-encrypted blob.
// Verified offline against a captured 2212/o2 trace (PoW + wasmOut + derived + blob all match).
// Full writeup: docs/protocol.md.

export const STORE_BASE = 'https://demo.inelabteamdev.com';
export const MAX_RETRIES = 6;

/** Salt prefix extracted from the bundle's obfuscated string table. */
export const DR = 'feffd924900aae681d40425da2e3f3ef53e3ab0a8c2e6acd330b5265f3794b56';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class Retryable extends Error {
  retryAfterMs = 0;
  constructor(msg: string, retryAfterMs = 0) {
    super(msg);
    this.retryAfterMs = retryAfterMs;
  }
}
export class Fatal extends Error {}

/** Observable stage event (verbose/headed mode). API callers ignore it. */
export interface StageEvent {
  stage: 'handshake-ok' | 'pow-solved' | 'wasm-out' | 'pass';
  attempt: number;
  detail: string;
  ms: number;
}

export interface Puzzle {
  salt: string;
  ts: number;
  difficulty: number;
  csig: string;
  wasm: string;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Find nonce so sha256(`${salt}:${nonce}`) starts with `difficulty` zeros. */
export function solveNonce(salt: string, difficulty: number): { nonce: number; hash: string } {
  const want = '0'.repeat(difficulty);
  let nonce = 0;
  for (;;) {
    const h = sha256hex(`${salt}:${nonce}`);
    if (h.startsWith(want)) return { nonce, hash: h };
    nonce++;
  }
}

/** Execute the challenge wasm module: exports.f(input) coerced to int32. No imports. */
export async function runWasm(wasmB64: string, input: number): Promise<number> {
  const bytes = Buffer.from(wasmB64, 'base64');
  const mod = await WebAssembly.instantiate(bytes);
  const instance = (mod as { instance?: WebAssembly.Instance }).instance ?? (mod as unknown as WebAssembly.Instance);
  const f = (instance.exports as Record<string, unknown>).f as (x: number) => number;
  if (typeof f !== 'function') throw new Fatal('wasm has no export f');
  return f(input) | 0;
}

function hex(n: number, len: number): string {
  return Math.floor(Math.random() * 16 ** len)
    .toString(16)
    .padStart(len, '0')
    .slice(0, len);
}

/**
 * Synthesized interaction telemetry ({env, ix}) matching the bundle's tracker shape:
 * >=8 moves, dwell >= 600ms, trusted click. Timestamps are fabricated instantly —
 * no waiting. Whether the server validates plausibility is tested live; the PoW
 * binding (derived) is self-consistent regardless since we hash our own string.
 */
export function synthAtt(): string {
  const now = Date.now();
  const dwell = 8000 + Math.floor(Math.random() * 12000);
  const hoverAt = now - dwell;
  const nMoves = 10 + Math.floor(Math.random() * 8);
  const moves: Array<[number, number, number]> = [];
  let x = 700 + Math.floor(Math.random() * 200);
  let y = 450 + Math.floor(Math.random() * 100);
  for (let i = 0; i < nMoves; i++) {
    x += Math.floor(Math.random() * 160) - 80;
    y += Math.floor(Math.random() * 120) - 60;
    moves.push([x, y, hoverAt + Math.floor((dwell * (i + 1)) / (nMoves + 1))]);
  }
  moves.push([x, y, now - 300]);
  return JSON.stringify({
    env: {
      canvas: hex(0, 16),
      gl: hex(0, 16),
      hc: 8,
      scr: [1920, 1080, 1],
      frames: Array.from({ length: 8 }, () => +(16 + Math.random()).toFixed(2)),
      at: now + 150 + Math.floor(Math.random() * 300),
    },
    ix: { hoverAt, dwellMs: dwell, moves, clickAt: now, trusted: true },
  });
}

function baseHeaders(itemId: number): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': UA,
    Referer: `${STORE_BASE}/item/${itemId}`,
    Origin: STORE_BASE,
  };
}

/** Honor server backpressure: Retry-After (seconds or HTTP date) → ms. */
export function retryAfterMs(r: Response): number {
  const h = r.headers.get('retry-after');
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? 0 : Math.max(0, t - Date.now());
}

/** Full handshake for one product+option. Returns the Bearer pass (30s TTL, use immediately). */
export async function handshake(
  itemId: number,
  option: string,
  signal: AbortSignal,
  attempt = 0,
  onEvent?: (e: StageEvent) => void,
): Promise<string> {
  const h0 = Date.now();
  const g = await fetch(`${STORE_BASE}/api/v2/handshake`, { headers: baseHeaders(itemId), signal });
  if (!g.ok) throw new Retryable(`handshake GET ${g.status}`);
  const p = (await g.json()) as Puzzle;
  if (!p.salt || !p.wasm || typeof p.difficulty !== 'number') throw new Fatal('bad puzzle shape');
  onEvent?.({ stage: 'handshake-ok', attempt, detail: `salt ${p.salt.slice(0, 8)}…, difficulty ${p.difficulty}`, ms: Date.now() - h0 });

  const p0 = Date.now();
  const { nonce } = solveNonce(p.salt, p.difficulty);
  onEvent?.({ stage: 'pow-solved', attempt, detail: `nonce ${nonce}`, ms: Date.now() - p0 });
  const att = synthAtt();
  const attHash = sha256hex(att);
  const wasmInput = parseInt(sha256hex(`${DR}|seed|${p.salt}|${attHash}`).slice(0, 8), 16) | 0;
  const w0 = Date.now();
  const wasmOut = await runWasm(p.wasm, wasmInput);
  onEvent?.({ stage: 'wasm-out', attempt, detail: `${wasmOut} (input ${wasmInput})`, ms: Date.now() - w0 });
  const derived = sha256hex(`${DR}|derive|${p.salt}|${wasmOut}|${attHash}`);

  const body = {
    salt: p.salt,
    ts: p.ts,
    difficulty: p.difficulty,
    csig: p.csig,
    wasm: p.wasm,
    nonce,
    derived,
    wasmOut,
    att,
    itemId,
    option,
  };
  const r = await fetch(`${STORE_BASE}/api/v2/handshake`, {
    method: 'POST',
    headers: { ...baseHeaders(itemId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (r.status === 429) throw new Retryable('handshake POST 429', retryAfterMs(r));
  if (!r.ok) throw new Retryable(`handshake POST ${r.status}`);
  const { pass } = (await r.json()) as { pass?: string };
  if (!pass) throw new Fatal('handshake gave no pass');
  onEvent?.({ stage: 'pass', attempt, detail: 'ttl 30s', ms: 0 });
  return pass;
}

export interface RawQuote {
  itemId: number;
  option: string;
  ver: number;
  blob: string;
  ts: number;
}

/** Quote call with a fresh pass. 401/403 = pass rejected (retry w/ fresh handshake). Else !ok = upstream error. */
export async function fetchQuote(
  itemId: number,
  option: string,
  pass: string,
  signal: AbortSignal,
): Promise<RawQuote> {
  const r = await fetch(`${STORE_BASE}/api/v2/items/${itemId}/quote?opt=${encodeURIComponent(option)}`, {
    headers: { ...baseHeaders(itemId), Authorization: `Bearer ${pass}` },
    signal,
  });
  if (r.status === 401 || r.status === 403) throw new Retryable(`quote ${r.status} (pass rejected)`);
  if (r.status === 429) throw new Retryable('quote 429', retryAfterMs(r));
  if (!r.ok) throw new Retryable(`quote upstream ${r.status}`);
  const q = (await r.json()) as RawQuote;
  if (!q || typeof q.blob !== 'string') throw new Fatal('bad quote shape');
  return q;
}
