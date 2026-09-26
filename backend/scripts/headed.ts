/* eslint-disable no-console */
/**
 * Headed (= observable) scraper run. Same scrapeProduct core as the API —
 * different sink: live terminal narration + optional local CSV, zero DB writes.
 * No browser exists by design (see docs/protocol.md); observability comes
 * from per-stage events instead of a window.
 *
  * usage: npm run headed [-- productId optionId] [--csv out.csv] [--append]
  *   no args  -> loops all active tracked items (cron-like, with stagger)
  *   --csv    -> also writes the 9-col CSV; refuses if the file exists
  *              (delete it, or add --append to add rows without repeating the header)
  *   exit 0   -> all success · exit 2 -> any failure (nothing stored either way)
 */
import { appendFileSync, existsSync, statSync } from 'node:fs';
import dotenv from 'dotenv';
import path from 'node:path';
// .env lives at repo root; scripts run from backend/.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
import { getPool } from '../src/db.js';
import { CSV_COLS, csvLine } from '../src/lib/csv.js';
import { scrapeProduct } from '../src/scraper/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal ANSI colors (no deps). Honors NO_COLOR; CSV writes stay plain. */
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
const c = (code: string, s: string): string => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const bold = (s: string) => c('1', s);
const cyan = (s: string) => c('36', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const red = (s: string) => c('31', s);
const magenta = (s: string) => c('35', s);
const dim = (s: string) => c('2', s);

/** One color per protocol stage so the eye can follow the chain. */
function stageColor(stage: string): (s: string) => string {
  switch (stage) {
    case 'handshake-ok': return cyan;
    case 'pow-solved': return yellow;
    case 'wasm-out': return magenta;
    case 'pass': return green;
    case 'quote-retry': return yellow;
    case 'decrypted': return green;
    default: return dim;
  }
}

const args = process.argv.slice(2);
const csvIdx = args.indexOf('--csv');
const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;
if (csvIdx >= 0 && !csvPath) {
  console.error('usage: npm run headed [-- productId optionId] [--csv out.csv] [--append]');
  process.exit(1);
}
const append = args.includes('--append');
if (append && !csvPath) {
  console.error('--append needs --csv <path>');
  process.exit(1);
}
// NOTE: guard index math behind csvIdx >= 0. When no --csv is passed,
// csvIdx is -1 and `i !== csvIdx + 1` would wrongly drop args[0].
// (Regressed once before — do not "simplify" this back.)
const rest = args.filter(
  (_, i) => (csvIdx < 0 || (i !== csvIdx && i !== csvIdx + 1)) && args[i] !== '--append',
);
const [idRaw, optRaw] = rest;

async function targets(): Promise<Array<{ productId: number; optionId: string; name: string; label: string; axis: string }>> {
  if (idRaw) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || !optRaw) {
      console.error('usage: npm run headed [-- productId optionId] [--csv out.csv] [--append]');
      process.exit(1);
    }
    const { rows } = await getPool().query(
      `select p.name as name, p.option_axis as axis,
        (select o->>'label' from jsonb_array_elements(p.options) o where o->>'id' = $2) as label
       from public.products p where p.id = $1`,
      [id, optRaw],
    );
    await getPool().end();
    if (rows.length === 0) {
      console.error(`product ${id} not found`);
      process.exit(1);
    }
    return [{ productId: id, optionId: optRaw, name: rows[0].name as string, label: (rows[0].label as string) ?? '', axis: (rows[0].axis as string) ?? '' }];
  }
  const { rows } = await getPool().query(
    `select t.product_id, t.option_id, p.name as name, p.option_axis as axis,
      (select o->>'label' from jsonb_array_elements(p.options) o where o->>'id' = t.option_id) as label
     from public.tracked_products t join public.products p on p.id = t.product_id
     where t.active order by t.id`,
  );
  await getPool().end();
  return rows.map((r) => ({
    productId: r.product_id as number,
    optionId: r.option_id as string,
    name: r.name as string,
    label: (r.label as string) ?? '',
    axis: (r.axis as string) ?? '',
  }));
}

(async () => {
  if (csvPath && !append && existsSync(csvPath)) {
    console.error(`${csvPath} already exists — delete it, or re-run with --append to add rows.`);
    process.exit(1);
  }
  // Header only when creating a fresh (or empty) file — never repeated.
  if (csvPath && (!existsSync(csvPath) || statSync(csvPath).size === 0)) {
    appendFileSync(csvPath, CSV_COLS + '\n');
  }
  const list = await targets();
  let failed = 0;

  for (const [idx, { productId, optionId, name, label, axis }] of list.entries()) {
    if (idx > 0) console.log(); // air between products
    console.log(bold(cyan(`[headed] scraping "${name}" (id ${productId}), option "${label}" (${optionId}) on axis "${axis}" — starting now`)));
    const t0 = Date.now();
    const r = await scrapeProduct(productId, optionId, {
      onEvent: (e) => {
        console.log(`  [attempt ${e.attempt}] ${stageColor(e.stage)(e.stage)}: ${e.detail} (${e.ms}ms)`);
      },
      onAttemptError: (n, err) => {
        console.log(`  [attempt ${n}] ${red('FAILED')}: ${err} — ${yellow('backing off, fresh handshake next')}`);
        console.log(); // air before the next attempt
      },
    });
    // One CSV line per handshake attempt, same shape as /api/history.csv.
    if (csvPath) {
      r.attemptLog.forEach((a, i) => {
        const last = i === r.attemptLog.length - 1;
        const ok = last && r.outcome === 'success';
        appendFileSync(
          csvPath,
          csvLine({
            product_id: productId, product_name: name, option_id: optionId, option_label: label,
            timestamp_utc: a.startedAt, price: ok && r.price !== null ? r.price : null,
            stock: ok ? r.stock : null, outcome: ok ? 'success' : last ? 'failed' : 'retried',
            error: a.error, source: 'live',
          }),
        );
      });
    }
    if (r.outcome === 'success') {
      console.log(); // air before the verdict
      console.log(
        r.stock === 'sold_out'
          ? magenta(`[done] SOLD OUT (success, price null)`) + dim(` in ${r.attempts} attempt(s), ${Date.now() - t0}ms total — NOT STORED (headed mode writes nothing)`)
          : green(bold(`[done] price ${r.price}, stock ${r.stockCount}`)) + dim(` in ${r.attempts} attempt(s), ${Date.now() - t0}ms total — NOT STORED (headed mode writes nothing)`),
      );
    } else {
      failed++;
      console.log(); // air before the verdict
      console.log(red(`[done] FAILED after ${r.attempts} attempts: ${r.error}`) + dim(' — recorded above, NOT STORED'));
    }
    await sleep(500);
  }
  console.log(failed === 0 ? green(bold('[headed] all success')) : red(`[headed] ${failed} item(s) failed`));
  process.exit(failed === 0 ? 0 : 2);
})().catch((e) => {
  console.error('HEADED CRASH:', e);
  process.exit(1);
});
