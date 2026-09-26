"""One-shot bulk load of products.csv into public.products via pooler.
Idempotent: INSERT ... ON CONFLICT (id) DO UPDATE. Batches of 100.
Usage: python3 load-products.py (reads DB_POOLER_URI from ../.env or env)
"""
import csv
import json
import os
import sys
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

BASE = Path(__file__).resolve().parent
CSV_PATH = BASE.parent / "products.csv"


def load_env():
    env_path = BASE.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


load_env()
DB_URI = os.environ.get("DB_POOLER_URI", "")
if not DB_URI:
    sys.exit("DB_POOLER_URI missing")

rows = []
with open(CSV_PATH, newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        specs = json.loads(r["specs"])  # validate
        options = json.loads(r["options"])
        assert isinstance(specs, dict) and isinstance(options, list)
        rows.append(
            (
                int(r["id"]),
                r["slug"],
                r["name"],
                r["brand"],
                r["category"],
                r["sku"],
                r["description"],
                json.dumps(specs),
                r["option_axis"],
                json.dumps(options),
            )
        )
print(f"parsed {len(rows)} rows from {CSV_PATH.name}")

SQL = """insert into public.products
(id,slug,name,brand,category,sku,description,specs,option_axis,options)
values %s
on conflict (id) do update set
slug=excluded.slug, name=excluded.name, brand=excluded.brand,
category=excluded.category, sku=excluded.sku, description=excluded.description,
specs=excluded.specs::jsonb, option_axis=excluded.option_axis, options=excluded.options::jsonb"""

conn = psycopg2.connect(DB_URI)
conn.autocommit = False
done = 0
with conn.cursor() as cur:
    for i in range(0, len(rows), 100):
        batch = rows[i : i + 100]
        execute_values(
            cur,
            SQL,
            batch,
            template="(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb)",
            page_size=100,
        )
        conn.commit()
        done += len(batch)
        print(f"upserted {done}/{len(rows)}")
with conn.cursor() as cur:
    cur.execute("select count(*) from public.products")
    print("count in db:", cur.fetchone()[0])
conn.close()
print("Done.")
