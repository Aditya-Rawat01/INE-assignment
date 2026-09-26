/* eslint-disable no-console */
import { scrapeProduct } from '../src/scraper/index.js';

const [idRaw, optRaw] = process.argv.slice(2);
const productId = Number(idRaw);
const optionId = optRaw ?? 'o1';
if (!Number.isInteger(productId)) {
  console.error('usage: npx tsx scripts/scrape-once.ts <productId> [optionId]');
  process.exit(1);
}

const t0 = Date.now();
scrapeProduct(productId, optionId, {
  onAttemptError: (n, err) => console.error(`attempt ${n} failed: ${err}`),
})
  .then((r) => {
    console.log(JSON.stringify({ ...r, wallMs: Date.now() - t0 }, null, 2));
    process.exit(r.outcome === 'success' ? 0 : 2);
  })
  .catch((e) => {
    console.error('SCRAPE CRASH:', e);
    process.exit(1);
  });
