import { decryptBlob } from './blob.js';
import { Fatal, MAX_RETRIES, Retryable, fetchQuote, handshake, type StageEvent } from './protocol.js';

export type ScrapeEvent =
  | StageEvent
  | { stage: 'quote-retry' | 'decrypted'; attempt: number; detail: string; ms: number };

export interface AttemptRecord {
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /** null when this attempt produced the final success */
  error: string | null;
}

export interface ScrapeResult {
  productId: number;
  optionId: string;
  price: number | null;
  stock: string | null;
  stockCount: number | null;
  outcome: 'success' | 'failed';
  error: string | null;
  attempts: number;
  /** one entry per handshake attempt, in order (for scrape_runs rows) */
  attemptLog: AttemptRecord[];
}

/**
 * Normalize the raw stock field. Vocabulary confirmed live:
 * number > 0 = units available, number 0 = sold out (observed 2002/o1),
 * sold-out-ish strings = sold out. Anything unverifiable -> null
 * (caller marks failed, never stores it).
 */
function normStock(a: unknown): { stock: string; count: number | null } | null {
  if (typeof a === 'number' && Number.isFinite(a)) {
    return a > 0 ? { stock: 'in_stock', count: a } : { stock: 'sold_out', count: 0 };
  }
  if (typeof a === 'string') {
    const s = a.trim().toLowerCase();
    if (!s) return null;
    if (s.includes('sold') || s === 'oos' || s === 'out') return { stock: 'sold_out', count: null };
    return { stock: s, count: null };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape one product+option. One attempt = one handshake; a 503 on the quote
 * is first retried with the SAME pass (mirrors the site's own retry, avoids a
 * pointless re-handshake that feeds 429 cascades). Fresh handshake per attempt
 * (pass is per-item:opt with 30s TTL). Retries up to MAX_RETRIES.
 * sold_out is success carrying the as-listed price (verified live: the blob's
 * q matches the storefront figure to the rupee — e.g. 2002/o1 → 159330 —
 * while stock reports 0). Availability lives in `stock`, never in price-null.
 * Anything unverified is failed (nothing stored).
 */
export async function scrapeProduct(
  productId: number,
  optionId: string,
  opts: { maxRetries?: number; attemptTimeoutMs?: number; onAttemptError?: (attempt: number, err: string) => void; onEvent?: (e: ScrapeEvent) => void } = {},
): Promise<ScrapeResult> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const budget = opts.attemptTimeoutMs ?? 25000;
  let lastError = 'unknown';
  const attemptLog: AttemptRecord[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), budget);
    const startedAt = new Date();
    const s0 = Date.now();
    const finish = (error: string | null): void => {
      const finishedAt = new Date();
      attemptLog.push({ attempt, startedAt, finishedAt, durationMs: Date.now() - s0, error });
    };
    try {
      const ev = (e: ScrapeEvent) => opts.onEvent?.(e);
      const pass = await handshake(productId, optionId, ctrl.signal, attempt, ev);
      let q;
      try {
        q = await fetchQuote(productId, optionId, pass, ctrl.signal);
      } catch (e) {
        // Same-pass retry on transient quote errors (pass still valid).
        if (e instanceof Retryable && !/pass rejected/.test(e.message)) {
          const msg = e.message;
          ev({ stage: 'quote-retry', attempt, detail: `${msg} — same-pass retry in 500ms`, ms: 0 });
          await sleep(500);
          q = await fetchQuote(productId, optionId, pass, ctrl.signal);
        } else {
          throw e;
        }
      }
      const d = decryptBlob(q.blob, pass);
      ev({ stage: 'decrypted', attempt, detail: `price ${d.price} ${d.currency}, stock ${JSON.stringify(d.stockRaw)}`, ms: 0 });
      const s = normStock(d.stockRaw);
      if (!s) throw new Fatal(`unverifiable stock: ${JSON.stringify(d.stockRaw)}`);
      clearTimeout(t);
      if (s.stock === 'sold_out') {
        finish(null);
        return { productId, optionId, price: d.price, stock: 'sold_out', stockCount: s.count, outcome: 'success', error: null, attempts: attempt, attemptLog };
      }
      finish(null);
      return { productId, optionId, price: d.price, stock: s.stock, stockCount: s.count, outcome: 'success', error: null, attempts: attempt, attemptLog };
    } catch (e) {
      clearTimeout(t);
      lastError = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
      finish(lastError);
      opts.onAttemptError?.(attempt, lastError);
      // Back off exponentially and always honor the server's Retry-After.
      const hint = e instanceof Retryable ? e.retryAfterMs : 0;
      if (attempt < maxRetries) {
        const exp = Math.min(800 * 2 ** (attempt - 1), 8000);
        const wait = Math.max(exp, hint) + Math.floor(Math.random() * 300);
        await sleep(wait);
      }
    }
  }
  return { productId, optionId, price: null, stock: null, stockCount: null, outcome: 'failed', error: lastError, attempts: maxRetries, attemptLog };
}
