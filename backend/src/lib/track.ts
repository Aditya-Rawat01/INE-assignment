import { getDb, getPool } from '../db.js';
import { scrapeRuns } from '../schema.js';
import { scrapeProduct, type ScrapeResult } from '../scraper/index.js';

/**
 * The single write path. Callers: initial track, resume, cron item.
 * One scrape_runs row per handshake attempt, spec vocabulary:
 * non-final attempts are 'retried', the final attempt is 'success'
 * (carries price/stock) or 'failed' (price/stock null + error).
 * Skipped items never reach here (no rows).
 */
export async function scrapeAndPersist(
  trackedId: number,
  productId: number,
  optionId: string,
): Promise<{ result: ScrapeResult; rowsWritten: number }> {
  const result = await scrapeProduct(productId, optionId);
  await getDb()
    .insert(scrapeRuns)
    .values(
      result.attemptLog.map((a, i) => {
        const last = i === result.attemptLog.length - 1;
        const ok = last && result.outcome === 'success';
        return {
          trackedId,
          attempt: a.attempt,
          startedAt: a.startedAt,
          finishedAt: a.finishedAt,
          price: ok && result.price !== null ? String(result.price) : null,
          stock: ok ? result.stock : null,
          outcome: ok ? 'success' : last ? 'failed' : 'retried',
          error: a.error,
          durationMs: a.durationMs,
        };
      }),
    );
  return { result, rowsWritten: result.attemptLog.length };
}

/** Verify a product+option against the catalog. Returns product name + option label. */
export async function verifyProductOption(
  productId: number,
  optionId: string,
): Promise<{ name: string; optionLabel: string } | { error: string; status: 404 | 400 }> {
  const { rows } = await getPool().query(
    'select name, options from public.products where id = $1',
    [productId],
  );
  if (rows.length === 0) return { error: 'product not found', status: 404 };
  const options = rows[0].options as Array<{ id: string; label: string }>;
  const opt = Array.isArray(options) ? options.find((o) => o.id === optionId) : undefined;
  if (!opt) return { error: `invalid option '${optionId}' for product ${productId}`, status: 400 };
  return { name: rows[0].name as string, optionLabel: opt.label };
}
