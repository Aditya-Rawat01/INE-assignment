import { Router, type Request } from 'express';
import { getPool } from '../db.js';
import { verifyProductOption } from '../lib/track.js';
import { scrapeProduct } from '../scraper/index.js';

export const productsRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 60;

function pageParams(req: Request): { page: number; limit: number } {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  return { page, limit };
}

/** Escape LIKE wildcards in user input so `q` is always literal substring. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const LIST_COLS = 'id, slug, name, brand, category';

/** GET /api/products?page=&limit= — stable id-ordered catalog listing. */
productsRouter.get('/api/products', async (req, res) => {
  const { page, limit } = pageParams(req);
  try {
    const total = Number((await getPool().query('select count(*)::int as c from public.products')).rows[0].c);
    const { rows } = await getPool().query(
      `select ${LIST_COLS} from public.products order by id limit $1 offset $2`,
      [limit, (page - 1) * limit],
    );
    res.json({ page, limit, total, totalPages: Math.ceil(total / limit), items: rows });
  } catch (e) {
    res.status(500).json({ error: `db: ${e instanceof Error ? e.message : String(e)}` });
  }
});

/** GET /api/products/search?q=&page=&limit= — substring ILIKE on name/brand, id-ordered. */
productsRouter.get('/api/products/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q is required (use /api/products for plain listing)' });
  const { page, limit } = pageParams(req);
  const like = `%${escapeLike(q)}%`;
  try {
    const count = await getPool().query(
      `select count(*)::int as c from public.products where name ilike $1 escape '\\' or brand ilike $1 escape '\\'`,
      [like],
    );
    const total = Number(count.rows[0].c);
    const { rows } = await getPool().query(
      `select ${LIST_COLS} from public.products where name ilike $1 escape '\\' or brand ilike $1 escape '\\' order by id limit $2 offset $3`,
      [like, limit, (page - 1) * limit],
    );
    res.json({ q, page, limit, total, totalPages: Math.ceil(total / limit), items: rows });
  } catch (e) {
    res.status(500).json({ error: `db: ${e instanceof Error ? e.message : String(e)}` });
  }
});

/** GET /api/products/:id — full detail incl. specs + options for the product page. */
productsRouter.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
  try {
    const { rows } = await getPool().query(
      'select id, slug, name, brand, category, sku, description, specs, option_axis, options from public.products where id = $1',
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'product not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: `db: ${e instanceof Error ? e.message : String(e)}` });
  }
});

/**
 * GET /api/products/:id/preview?option=o2 — EPHEMERAL live price for the
 * product page. Same scraper, zero DB writes (never touches scrape_runs).
 */
productsRouter.get('/api/products/:id/preview', async (req, res) => {
  const id = Number(req.params.id);
  const option = String(req.query.option ?? '');
  if (!Number.isInteger(id) || !option) {
    return res.status(400).json({ error: 'integer :id and ?option= required' });
  }
  const v = await verifyProductOption(id, option);
  if ('error' in v) return res.status(v.status).json({ error: v.error });
  const s0 = Date.now();
  const r = await scrapeProduct(id, option);
  res.json({
    productId: id, optionId: option, price: r.price, stock: r.stock,
    outcome: r.outcome, attempts: r.attempts, error: r.error,
    ms: Date.now() - s0, ephemeral: true, notStored: true,
  });
});
