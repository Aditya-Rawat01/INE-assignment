/** Typed client for the price-tracker backend (see backend/docs/api.md).
 * Single place that knows URLs, response shapes, abort + CSV download plumbing.
 * Dev: relative '/api/…' via the Vite proxy. Prod: VITE_API_URL (Render URL). */

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

const get = <T>(path: string, signal?: AbortSignal): Promise<T> =>
  req<T>(path, { signal });

export interface ProductListItem {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
}

export interface Paged<T> {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  items: T[];
}

export interface SearchResponse extends Paged<ProductListItem> {
  q: string;
}

export interface ProductOption {
  id: string;
  label: string;
}

export interface ProductDetail {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  specs: Record<string, unknown>;
  option_axis: string;
  options: ProductOption[];
}

export interface PreviewResult {
  productId: number;
  optionId: string;
  price: number | null;
  stock: string | null;
  outcome: 'success' | 'failed';
  attempts: number;
  error: string | null;
  ms: number;
  ephemeral: true;
  notStored: true;
}

export interface TrackedItem {
  id: number;
  product_id: number;
  name: string;
  option_id: string;
  option_label: string;
  active: boolean;
  created_at: string;
}

export interface HistoryPoint {
  at: string;
  price: string | null;
  stock: string | null;
}

export interface LogRow {
  attempt: number;
  at: string;
  finished_at: string | null;
  price: string | null;
  stock: string | null;
  outcome: 'success' | 'retried' | 'failed';
  error: string | null;
  duration_ms: number | null;
}

export interface HistoryResponse {
  tracked: TrackedItem;
  latest: LogRow | null;
  points: HistoryPoint[];
  log: LogRow[];
}

export const listProducts = (page = 1, limit = 20): Promise<Paged<ProductListItem>> =>
  get(`/api/products?page=${page}&limit=${limit}`);

export const searchProducts = (
  q: string,
  page = 1,
  limit = 20,
  signal?: AbortSignal,
): Promise<SearchResponse> =>
  get(`/api/products/search?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`, signal);

export const getProduct = (id: number): Promise<ProductDetail> =>
  get(`/api/products/${id}`);

export const getPreview = (id: number, option: string): Promise<PreviewResult> =>
  get(`/api/products/${id}/preview?option=${encodeURIComponent(option)}`);

export const trackProduct = (productId: number, optionId: string) =>
  req<{ tracked: TrackedItem; firstResult: PreviewResult; rowsWritten: number }>(
    '/api/tracked',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, optionId }),
    },
  );

export const listTracked = (): Promise<{ total: number; items: TrackedItem[] }> =>
  get('/api/tracked');

export const setActive = (id: number, active: boolean) =>
  req<{ tracked: TrackedItem; resumedResult?: PreviewResult; rowsWritten?: number }>(
    `/api/tracked/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    },
  );

export const getHistory = (id: number, limit = 100): Promise<HistoryResponse> =>
  get(`/api/tracked/${id}/history?limit=${limit}`);

/** Downloads the CSV via blob URL so the server filename is honored. */
export async function downloadCsv(trackedId?: number): Promise<void> {
  const path = trackedId === undefined ? '/api/history.csv' : `/api/history.csv?trackedId=${trackedId}`;
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new ApiError(r.status, 'CSV download failed');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = trackedId === undefined ? 'scrape-history.csv' : `scrape-history-tracked-${trackedId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
