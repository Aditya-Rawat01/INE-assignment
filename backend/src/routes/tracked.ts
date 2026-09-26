import { Router } from "express";
import { getDb, getPool } from "../db.js";
import { trackedProducts } from "../schema.js";
import { eq } from "drizzle-orm";
import { scrapeAndPersist, verifyProductOption } from "../lib/track.js";

export const trackedRouter = Router();

const WITH_LABEL = `
  select t.id, t.product_id, p.name, t.option_id,
    (select o->>'label' from jsonb_array_elements(p.options) o where o->>'id' = t.option_id) as option_label,
    t.active, t.created_at
  from public.tracked_products t join public.products p on p.id = t.product_id`;

/**
 * POST /api/tracked {productId, optionId}
 * Verify vs catalog (kills fake entries) → insert → immediate scrape →
 * persist. Duplicate → 409 with existing row, no re-scrape.
 */
trackedRouter.post("/api/tracked", async (req, res) => {
    const productId = Number(req.body?.productId);
    const optionId = String(req.body?.optionId ?? "");
    if (!Number.isInteger(productId) || !optionId) {
        return res
            .status(400)
            .json({ error: "productId (int) and optionId required" });
    }
    const v = await verifyProductOption(productId, optionId);
    if ("error" in v) return res.status(v.status).json({ error: v.error });

    const existing = await getPool().query(
        "select id, active from public.tracked_products where product_id = $1 and option_id = $2",
        [productId, optionId],
    );
    if (existing.rows.length > 0) {
        return res
            .status(409)
            .json({ error: "already tracked", tracked: existing.rows[0] });
    }
    const ins = await getDb()
        .insert(trackedProducts)
        .values({ productId, optionId })
        .returning({ id: trackedProducts.id });
    const trackedId = ins[0].id;

    const { result, rowsWritten } = await scrapeAndPersist(
        trackedId,
        productId,
        optionId,
    );
    res.status(201).json({
        tracked: {
            id: trackedId,
            productId,
            optionId,
            optionLabel: v.optionLabel,
            active: true,
        },
        firstResult: {
            price: result.price,
            stock: result.stock,
            outcome: result.outcome,
            attempts: result.attempts,
            error: result.error,
        },
        rowsWritten,
    });
});

/** GET /api/tracked — all rows with product name + derived option label. */
trackedRouter.get("/api/tracked", async (_req, res) => {
    try {
        const { rows } = await getPool().query(`${WITH_LABEL} order by t.id`);
        res.json({ total: rows.length, items: rows });
    } catch (e) {
        res.status(500).json({
            error: `db: ${e instanceof Error ? e.message : String(e)}`,
        });
    }
});

/**
 * PATCH /api/tracked/:id {active}
 * Pause needs no scrape. Resume (false→true) scrapes immediately + persists,
 * same as the initial track. No-op state change returns the row as-is.
 */
trackedRouter.patch("/api/tracked/:id", async (req, res) => {
    const id = Number(req.params.id);
    const active = req.body?.active;
    if (!Number.isInteger(id) || typeof active !== "boolean") {
        return res
            .status(400)
            .json({ error: "id (int) and active (bool) required" });
    }
    const cur = await getPool().query(
        "select id, product_id, option_id, active from public.tracked_products where id = $1",
        [id],
    );
    if (cur.rows.length === 0)
        return res.status(404).json({ error: "tracked item not found" });
    const row = cur.rows[0] as {
        id: number;
        product_id: number;
        option_id: string;
        active: boolean;
    };

    if (row.active !== active) {
        await getDb()
            .update(trackedProducts)
            .set({ active })
            .where(eq(trackedProducts.id, id));
    }
    if (active && !row.active) {
        // Resume: capture the comeback price now, don't wait for cron.
        const { result, rowsWritten } = await scrapeAndPersist(
            id,
            row.product_id,
            row.option_id,
        );
        return res.json({
            tracked: { ...row, active },
            resumedResult: {
                price: result.price,
                stock: result.stock,
                outcome: result.outcome,
                attempts: result.attempts,
                error: result.error,
            },
            rowsWritten,
        });
    }
    res.json({ tracked: { ...row, active } });
});

/**
 * GET /api/tracked/:id/history?limit=
 * Combined: tracked meta, latest success, chart points (ascending),
 * full attempt log (newest first, incl. failures).
 */
trackedRouter.get("/api/tracked/:id/history", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
        return res.status(400).json({ error: "id must be an integer" });
    const limit = Math.min(
        500,
        Math.max(1, Number(req.query.limit ?? 100) || 100),
    );
    try {
        const meta = await getPool().query(`${WITH_LABEL} where t.id = $1`, [
            id,
        ]);
        if (meta.rows.length === 0)
            return res.status(404).json({ error: "tracked item not found" });
        const log = await getPool().query(
            "select attempt, started_at as at, finished_at, price, stock, outcome, error, duration_ms from public.scrape_runs where tracked_id = $1 order by id desc limit $2",
            [id, limit],
        );
        const points = await getPool().query(
            "select started_at as at, price, stock from public.scrape_runs where tracked_id = $1 and outcome = 'success' order by id asc limit $2",
            [id, limit],
        );
        const latest = log.rows.find((r) => r.outcome === "success") ?? null;
        res.json({
            tracked: meta.rows[0],
            latest,
            points: points.rows,
            log: log.rows,
        });
    } catch (e) {
        res.status(500).json({
            error: `db: ${e instanceof Error ? e.message : String(e)}`,
        });
    }
});
