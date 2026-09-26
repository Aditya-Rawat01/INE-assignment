import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Table 1: static catalog, 960 rows. Price NEVER lives here.
export const products = pgTable('products', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  brand: text('brand'),
  category: text('category'),
  sku: text('sku'),
  description: text('description'),
  specs: jsonb('specs').notNull().default({}),
  optionAxis: text('option_axis').notNull().default(''),
  options: jsonb('options').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Table 2: thin pointers — WHAT to track. No catalog data duplicated,
// no option_label (derived from products.options via join).
export const trackedProducts = pgTable(
  'tracked_products',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    optionId: text('option_id').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex('uq_tracked_product_option').on(t.productId, t.optionId)],
);

// Table 3: WHAT HAPPENED — one row per attempt (success + retries + failures).
export const scrapeRuns = pgTable('scrape_runs', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  trackedId: integer('tracked_id')
    .notNull()
    .references(() => trackedProducts.id),
  attempt: integer('attempt').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  price: numeric('price'),
  stock: text('stock'),
  outcome: text('outcome').notNull(), // success | failed
  error: text('error'),
  durationMs: integer('duration_ms'),
});
