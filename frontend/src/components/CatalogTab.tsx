import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listProducts, searchProducts, type ProductListItem, type TrackedItem } from '../api';
import SearchBar from './SearchBar';

const PAGE_SIZE = 20;

/** Landing: stable catalog listing (id order) + debounced search. Tracked items badged. */
export default function CatalogTab({ tracked }: { tracked: TrackedItem[] }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const onQuery = useCallback((next: string) => {
    setQ(next);
    setPage(1);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const p = q
      ? searchProducts(q, page, PAGE_SIZE, ctrl.signal)
      : listProducts(page, PAGE_SIZE);
    p.then((d) => {
      setItems(d.items);
      setTotalPages(d.totalPages);
      setTotal(d.total);
      setLoading(false);
    }).catch((e) => {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
    return () => ctrl.abort(); // abort in-flight on new keystroke/page
  }, [q, page]);

  return (
    <section>
      <div className="hero">
        <h2>{q ? `Results for “${q}”` : 'Browse the catalog'}</h2>
        <p>{q ? `${total} match${total === 1 ? '' : 'es'} across the store` : '960 products · pick one to preview its live price'}</p>
      </div>
      <SearchBar onQuery={onQuery} />
      {error && <p className="error">{error}</p>}
      <div className=''/>
      {loading ? (
        <ul className="cards" aria-label="Loading">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <div className="skel" />
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="resultline">
            {q ? `${total} match${total === 1 ? '' : 'es'} for “${q}”` : `${total} products`} · page {page} of {totalPages}
          </p>
          <ul className="cards">
            {items.map((p) => {
              const t = tracked.find((x) => x.product_id === p.id);
              return (
                <li key={p.id} className="card">
                  <Link to={`/product/${p.id}`} className="card-main">
                    <span className="eyebrow">{p.brand} · {p.category}</span>
                    <strong>{p.name}</strong>
                    {t && <span className="badge">Tracking ✓</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="pager">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ← Prev
            </button>
            <span className="muted">Page {page} of {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        </>
      )}
    </section>
  );
}
