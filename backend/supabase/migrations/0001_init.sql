-- 0001_init: products catalog + tracked pointers + per-attempt scrape history.
-- Applied to Supabase via the pooler (direct :5432 is IPv6-only on most networks).
-- RLS enabled, no policies: app-only access via direct PG (service role equivalent).

drop table if exists public.scrape_runs;
drop table if exists public.tracked_products;
drop table if exists public.products;

create table public.products (
  id int primary key,
  slug text unique not null,
  name text not null,
  brand text,
  category text,
  sku text,
  description text,
  specs jsonb not null default '{}',
  option_axis text not null default '',
  options jsonb not null default '[]',
  created_at timestamptz default now()
);
create index idx_products_brand on public.products (brand);
create index idx_products_category on public.products (category);
alter table public.products enable row level security;

create table public.tracked_products (
  id int primary key generated always as identity,
  product_id int not null references public.products (id),
  option_id text not null,
  active bool not null default true,
  created_at timestamptz default now(),
  unique (product_id, option_id)
);
alter table public.tracked_products enable row level security;

create table public.scrape_runs (
  id int primary key generated always as identity,
  tracked_id int not null references public.tracked_products (id),
  attempt int not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  price numeric null,
  stock text null,
  outcome text not null, -- success | retried | failed
  error text null,
  duration_ms int
);
alter table public.scrape_runs enable row level security;

-- Seed example (ids verified against the catalog):
-- insert into public.tracked_products (product_id, option_id) values (2670,'o3'),(2304,'o3'),(2001,'o2');
