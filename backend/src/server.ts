import dotenv from 'dotenv';
import path from 'node:path';
// .env lives at repo root (dotenv/config alone would look in backend/).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
import express from 'express';
import { getPool } from './db.js';
import { scheduleRouter } from './routes/schedule.js';
import { productsRouter } from './routes/products.js';
import { trackedRouter } from './routes/tracked.js';
import { exportRouter } from './routes/export.js';

const app = express();
app.use(express.json());

/** Warmup target: cheap, but touches the pool so first real query isn't cold. */
app.get('/health', async (_req, res) => {
  try {
    await getPool().query('select 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.use(scheduleRouter);
app.use(productsRouter);
app.use(trackedRouter);
app.use(exportRouter);

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== 'test') {
  if (!process.env.CRON_SECRET) console.warn('WARN: CRON_SECRET unset — /api/schedule/scrape is open');
  app.listen(port, () => console.log(`backend on :${port}`));
}

export default app;
