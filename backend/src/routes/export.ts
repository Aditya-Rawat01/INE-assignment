import { Router } from 'express';
import { getPool } from '../db.js';
import { CSV_COLS, csvLine, type CsvRow } from '../lib/csv.js';
import { scrapeProduct } from '../scraper/index.js';

export const exportRouter = Router();

/**
 * GET /api/history.csv[?trackedId=]
 * Complete scrape history as a download: one row per scrape_runs attempt
 * (retries + failures included — same story as the on-screen log).
 * Per-product exports append one final ephemeral `source:live` now-row
 * (fresh scrape, never stored); the full export stays DB-pure.
 * Response streams row-by-row (result set buffered by pg — fine to ~100k rows).
 */
exportRouter.get('/api/history.csv', async (req, res) => {
  const raw = req.query.trackedId;
  const trackedId = raw === undefined ? null : Number(raw);
  if (raw !== undefined && !Number.isInteger(trackedId)) {
    return res.status(400).json({ error: 'trackedId must be an integer' });
  }
  try {
    // Per-product export: resolve meta first (404 on unknown id).
    interface Meta {
      product_id: number;
      product_name: string;
      option_id: string;
      option_label: string;
    }
    let meta: Meta | null = null;
    if (trackedId !== null) {
      const m = await getPool().query(
        `select t.product_id, p.name as product_name, t.option_id,
          (select o->>'label' from jsonb_array_elements(p.options) o where o->>'id' = t.option_id) as option_label
         from public.tracked_products t join public.products p on p.id = t.product_id
         where t.id = $1`,
        [trackedId],
      );
      if (m.rows.length === 0) return res.status(404).json({ error: 'tracked item not found' });
      meta = m.rows[0] as Meta;
    }
    const filter = trackedId === null ? '' : 'and r.tracked_id = $1';
    const params = trackedId === null ? [] : [trackedId];
    const cur = getPool().query(
      `select t.product_id, p.name as product_name, t.option_id,
        (select o->>'label' from jsonb_array_elements(p.options) o where o->>'id' = t.option_id) as option_label,
        r.started_at as timestamp_utc, r.price, r.stock, r.outcome, r.error
       from public.scrape_runs r
       join public.tracked_products t on t.id = r.tracked_id
       join public.products p on p.id = t.product_id
       where 1=1 ${filter} order by r.id asc`,
      params,
    );
    const name = trackedId === null ? 'scrape-history.csv' : `scrape-history-tracked-${trackedId}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.write(CSV_COLS + '\n');
    for await (const row of (await cur).rows as Array<Record<string, unknown>>) {
      res.write(
        csvLine({
          product_id: row.product_id as number,
          product_name: String(row.product_name),
          option_id: String(row.option_id),
          option_label: String(row.option_label ?? ''),
          timestamp_utc: row.timestamp_utc as Date,
          price: row.price as number | string | null,
          stock: row.stock as string | null,
          outcome: String(row.outcome),
          error: row.error as string | null,
          source: 'history',
        } satisfies CsvRow),
      );
    }
    // Per-product now-row: one fresh ephemeral scrape, flagged live.
    if (meta) {
      const r = await scrapeProduct(meta.product_id, meta.option_id);
      const ok = r.outcome === 'success';
      res.write(
        csvLine({
          product_id: meta.product_id,
          product_name: meta.product_name,
          option_id: meta.option_id,
          option_label: meta.option_label,
          timestamp_utc: new Date(),
          price: ok ? r.price : null,
          stock: ok ? r.stock : null,
          outcome: ok ? 'success' : 'failed',
          error: r.error,
          source: 'live',
        } satisfies CsvRow),
      );
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `db: ${e instanceof Error ? e.message : String(e)}` });
    else res.end();
  }
});
