const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://demo.inelabteamdev.com/api/v2/listings';
const TOTAL_PAGES = 16;
const LIMIT = 60;
const TARGET_UNIQUE = 980;
const MAX_ROUNDS = 20;
const DELAY_MS = 400;
const OUT_FILE = path.join(__dirname, 'test_listings.csv');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function fetchPage(page, attempt = 1) {
  const url = `${BASE_URL}?page=${page}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (res.status === 429 && attempt <= 5) {
    const wait = 1000 * attempt;
    console.log(`page ${page}: 429 rate-limited, retry ${attempt} after ${wait}ms...`);
    await sleep(wait);
    return fetchPage(page, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Page ${page}: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.results || [];
}

(async () => {
  const seen = new Map(); // id -> item, dedupes across all pages

  // NOTE: API returns randomized/shuffled results per request, so a single
  // 1..16 pass only yields ~600 uniques. Cycle pages until 960 collected.
  let round = 0;
  outer: for (round = 1; round <= MAX_ROUNDS; round++) {
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const results = await fetchPage(page);
      let added = 0;
      for (const item of results) {
        if (item == null || item.id == null) continue;
        if (!seen.has(item.id)) {
          seen.set(item.id, item);
          added++;
        }
      }
      console.log(`round ${round} page ${page}: ${results.length} raw, +${added} new, total unique: ${seen.size}`);
      await sleep(DELAY_MS);
      if (seen.size >= TARGET_UNIQUE) break outer;
    }
    console.log(`--- end of round ${round}: ${seen.size}/${TARGET_UNIQUE} uniques ---`);
    if (seen.size >= TARGET_UNIQUE) break;
  }

  const header = ['id', 'slug', 'name', 'brand', 'category', 'sku', 'description'];
  const lines = [header.join(',')];
  for (const item of seen.values()) {
    lines.push(header.map((col) => csvEscape(item[col])).join(','));
  }

  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`\nDone in ${round} round(s). Unique entries: ${seen.size} -> ${OUT_FILE}`);

  if (seen.size !== TARGET_UNIQUE) {
    console.warn(`Warning: expected ${TARGET_UNIQUE} unique entries but got ${seen.size}.`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
