const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://demo.inelabteamdev.com/api/v2/items';
const START_ID = 2001;
const END_ID = 2960;
const OUT_FILE = path.join(__dirname, 'products.csv');

// Adaptive throttling: exponential backoff grows on consecutive 429/5xx,
// resets after sustained success so we don't stay slow forever.
const START_DELAY_MS = 1500;
const MIN_DELAY_MS = 1200;
const MAX_DELAY_MS = 8000;
const RESET_AFTER_SUCCESS = 5;
const MAX_ATTEMPTS = 8;

let currentDelay = START_DELAY_MS;
let consecLimited = 0;
let consecSuccess = 0;

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

function jitter(ms) {
  return ms + Math.floor(Math.random() * 400);
}

function getRetryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const dateMs = Date.parse(h);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function onSuccess() {
  consecSuccess++;
  if (consecSuccess >= RESET_AFTER_SUCCESS) {
    // sustained success -> reset exponential backoff
    consecLimited = 0;
    consecSuccess = 0;
    currentDelay = START_DELAY_MS;
  } else {
    // gentle decay toward floor while doing well
    currentDelay = Math.max(MIN_DELAY_MS, Math.floor(currentDelay * 0.95));
  }
}

function onLimited(retryAfterMs) {
  consecSuccess = 0;
  consecLimited++;
  const exp = Math.min(consecLimited, 5);
  const backoff = Math.min(MAX_DELAY_MS, 800 * 2 ** (exp - 1));
  currentDelay = Math.min(MAX_DELAY_MS, Math.floor(currentDelay * 1.3) + 200);
  return Math.max(backoff, retryAfterMs, currentDelay);
}

async function fetchItem(id) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE_URL}/${id}`);
    if (res.ok) {
      onSuccess();
      return res.json();
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = jitter(onLimited(getRetryAfterMs(res)));
      console.log(`id ${id}: HTTP ${res.status}, backoff ${wait}ms (attempt ${attempt}, consecLimited ${consecLimited}, delay ${currentDelay}ms)...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`id ${id}: HTTP ${res.status} ${res.statusText}`);
  }
  throw new Error(`id ${id}: giving up after ${MAX_ATTEMPTS} attempts (still rate-limited)`);
}

function loadDoneIds() {
  const done = new Set();
  if (!fs.existsSync(OUT_FILE)) return done;
  const content = fs.readFileSync(OUT_FILE, 'utf8');
  const lines = content.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const id = Number(lines[i].split(',')[0]);
    if (Number.isFinite(id)) done.add(id);
  }
  return done;
}

(async () => {
  const header = ['id', 'slug', 'name', 'brand', 'category', 'sku', 'description', 'specs', 'option_axis', 'options'];
  const done = loadDoneIds();
  const fresh = done.size === 0;
  if (!fresh) console.log(`Resuming: ${done.size} ids already in ${OUT_FILE}, skipping them.`);
  const stream = fs.createWriteStream(OUT_FILE, { flags: fresh ? 'w' : 'a' });
  if (fresh) stream.write(header.join(',') + '\n');

  let ok = done.size;

  for (let id = START_ID; id <= END_ID; id++) {
    if (done.has(id)) continue;
    const item = await fetchItem(id);
    const row = {
      id: item.id,
      slug: item.slug ?? '',
      name: item.name ?? '',
      brand: item.brand ?? '',
      category: item.category ?? '',
      sku: item.sku ?? '',
      description: item.description ?? '',
      specs: JSON.stringify(item.specs ?? {}),
      option_axis: item.optionAxis ?? '',
      options: JSON.stringify(item.options ?? []),
    };
    stream.write(header.map((col) => csvEscape(row[col])).join(',') + '\n');
    ok++;
    if (ok % 50 === 0 || id === END_ID) {
      console.log(`progress: ${ok}/${END_ID - START_ID + 1} (id ${id}, delay ${currentDelay}ms)`);
    }
    await sleep(jitter(currentDelay));
  }

  stream.end();
  await new Promise((r) => stream.on('finish', r));
  console.log(`\nDone. Rows: ${ok} -> ${OUT_FILE}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
