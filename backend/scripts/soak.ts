/* eslint-disable no-console */
import { scrapeProduct, type ScrapeResult } from '../src/scraper/index.js';

/**
 * Polite reliability soak: N checks round-robin across seeds with a stagger,
 * recording per-check outcome + per-attempt errors to a local JSONL file.
 * Local output only — never touches scrape_runs (keeps DB history clean).
 * Pass gate: >=95% success + zero unknown error shapes.
 */
const SEEDS: Array<[number, string]> = [
  [2670, 'o3'],
  [2304, 'o3'],
  [2001, 'o2'],
];

const TOTAL = Number(process.argv[2] ?? 36);
const STAGGER_MS = Number(process.argv[3] ?? 4000);

interface Row {
  i: number;
  at: string;
  productId: number;
  optionId: string;
  outcome: ScrapeResult['outcome'];
  price: number | null;
  stock: string | null;
  stockCount: number | null;
  attempts: number;
  attemptErrors: string[];
  error: string | null;
  wallMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `soak-${stamp}.jsonl`;
  const { appendFileSync } = await import('node:fs');
  const rows: Row[] = [];

  for (let i = 0; i < TOTAL; i++) {
    const [productId, optionId] = SEEDS[i % SEEDS.length];
    const attemptErrors: string[] = [];
    const t0 = Date.now();
    const r = await scrapeProduct(productId, optionId, {
      onAttemptError: (n, err) => attemptErrors.push(`a${n}:${err}`),
    });
    const row: Row = {
      i: i + 1,
      at: new Date().toISOString(),
      productId,
      optionId,
      outcome: r.outcome,
      price: r.price,
      stock: r.stock,
      stockCount: r.stockCount,
      attempts: r.attempts,
      attemptErrors,
      error: r.error,
      wallMs: Date.now() - t0,
    };
    rows.push(row);
    appendFileSync(outPath, JSON.stringify(row) + '\n');
    console.log(
      `#${row.i} ${productId}/${optionId} ${row.outcome} price=${row.price} stock=${row.stock} att=${row.attempts} ${row.wallMs}ms${attemptErrors.length ? ' ERR:' + attemptErrors.join(' | ') : ''}`,
    );
    if (i < TOTAL - 1) await sleep(STAGGER_MS + Math.floor(Math.random() * 1000));
  }

  const ok = rows.filter((r) => r.outcome === 'success').length;
  const prices = new Map<string, Array<number | null>>();
  for (const r of rows) {
    const k = `${r.productId}/${r.optionId}`;
    if (!prices.has(k)) prices.set(k, []);
    prices.get(k)!.push(r.price);
  }
  console.log(`\nsoak done: ${ok}/${TOTAL} success -> ${outPath}`);
  for (const [k, v] of prices) console.log(`  ${k} prices: ${v.join(',')}`);
})().catch((e) => {
  console.error('SOAK CRASH:', e);
  process.exit(1);
});
