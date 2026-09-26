/** Shared CSV shape (API export + headed --csv): identical columns, byte-for-byte. */
export const CSV_COLS =
  'product_id,product_name,option_id,option_label,timestamp_utc,price,stock,outcome,error,source';

export interface CsvRow {
  product_id: number | string;
  product_name: string;
  option_id: string;
  option_label: string;
  timestamp_utc: Date | string;
  price: number | string | null;
  stock: string | null;
  outcome: string;
  error: string | null;
  /** 'history' = stored row · 'live' = ephemeral now-row, never in scrape_runs */
  source: 'history' | 'live';
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(r: CsvRow): string {
  return (
    [
      r.product_id, r.product_name, r.option_id, r.option_label,
      r.timestamp_utc, r.price, r.stock, r.outcome, r.error, r.source,
    ]
      .map(csvCell)
      .join(',') + '\n'
  );
}
