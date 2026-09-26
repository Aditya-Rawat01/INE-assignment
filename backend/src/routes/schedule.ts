import { Router, type Request } from 'express';
import { getPool } from '../db.js';
import { scrapeAndPersist } from '../lib/track.js';

export const scheduleRouter = Router();

const STAGGER_MS = 500;
const DEADLINE_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? '';
  if (!expected) return true; // local dev without secret — boot logs a warning
  return req.header('x-cron-secret') === expected;
}

interface ItemSummary {
  trackedId: number;
  productId: number;
  optionId: string;
  outcome: 'success' | 'failed' | 'skipped';
  price: number | null;
  stock: string | null;
  attempts: number;
  error: string | null;
  rowsWritten: number;
  ms: number;
}

/**
 * Cron entry point (cron-job.org, q2h). Sequential over active tracked rows,
 * ~500ms stagger, 90s overall deadline. Writes go through scrapeAndPersist —
 * one scrape_runs row per attempt. Skipped items get no rows.
 */
scheduleRouter.post('/api/schedule/scrape', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const t0 = Date.now();
  let rows: Array<{ id: number; product_id: number; option_id: string }>;
  try {
    const r = await getPool().query(
      'select id, product_id, option_id from public.tracked_products where active order by id',
    );
    rows = r.rows as typeof rows;
  } catch (e) {
    return res.status(500).json({ error: `db: ${e instanceof Error ? e.message : String(e)}` });
  }

  const items: ItemSummary[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let rowsWritten = 0;
  const persistErrors: Array<{ trackedId: number; error: string }> = [];

  for (const t of rows) {
    if (Date.now() - t0 > DEADLINE_MS) {
      skipped++;
      items.push({
        trackedId: t.id, productId: t.product_id, optionId: t.option_id,
        outcome: 'skipped', price: null, stock: null, attempts: 0,
        error: 'job deadline exceeded', rowsWritten: 0, ms: 0,
      });
      continue;
    }
    const s0 = Date.now();
    try {
      const { result, rowsWritten: w } = await scrapeAndPersist(t.id, t.product_id, t.option_id);
      rowsWritten += w;
      if (result.outcome === 'success') succeeded++;
      else failed++;
      items.push({
        trackedId: t.id, productId: result.productId, optionId: result.optionId,
        outcome: result.outcome, price: result.price, stock: result.stock,
        attempts: result.attempts, error: result.error, rowsWritten: w, ms: Date.now() - s0,
      });
    } catch (e) {
      failed++;
      persistErrors.push({ trackedId: t.id, error: e instanceof Error ? e.message : String(e) });
      items.push({
        trackedId: t.id, productId: t.product_id, optionId: t.option_id,
        outcome: 'failed', price: null, stock: null, attempts: 0,
        error: `persist: ${e instanceof Error ? e.message : String(e)}`, rowsWritten: 0, ms: Date.now() - s0,
      });
    }
    await sleep(STAGGER_MS);
  }

  // Disconnect-safe summary: cheap-tier cron services (5s timeouts) routinely
  // sever the connection mid-run. The DB work above is complete regardless;
  // never let a broken pipe turn a finished job into a crash.
  const summary = { ran: rows.length, succeeded, failed, skipped, rowsWritten, persistErrors, ms: Date.now() - t0, items };
  try {
    if (!req.socket.destroyed) res.json(summary);
  } catch {
    /* client gone — history is already in scrape_runs */
  }
});
