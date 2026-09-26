import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { downloadCsv, getHistory, setActive, type TrackedItem } from '../api';

interface Latest {
  price: string | null;
  stock: string | null;
  at: string;
}

/** Dashboard: tracked list with latest stored badges, pause/resume, CSV buttons. */
export default function TrackedTab({
  items,
  onChanged,
  onRefresh,
}: {
  items: TrackedItem[];
  onChanged: () => void;
  onRefresh: () => void;
}) {
  const [latest, setLatest] = useState<Record<number, Latest | null>>({});
  const [pending, setPending] = useState<number[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  // Latest stored result per item (one cheap history call each; failures tolerated).
  // `pending` distinguishes loading from genuinely empty — "no history yet"
  // only renders after that item's fetch settles.
  useEffect(() => {
    let live = true;
    setPending(items.map((t) => t.id));
    Promise.all(
      items.map((t) =>
        getHistory(t.id, 1)
          .then((h) => ({ id: t.id, latest: h.latest ? { price: h.latest.price, stock: h.latest.stock, at: h.latest.at } : null }))
          .catch(() => ({ id: t.id, latest: null })),
      ),
    ).then((rows) => {
      if (!live) return;
      const m: Record<number, Latest | null> = {};
      for (const r of rows) m[r.id] = r.latest;
      setLatest(m);
      setPending([]);
    });
    return () => {
      live = false;
    };
  }, [items]);

  async function flip(t: TrackedItem) {
    setMsg(null);
    try {
      await setActive(t.id, !t.active);
      onChanged();
    } catch (e) {
      setMsg(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section>
      <div className="row">
        <h2>Tracked ({items.length})</h2>
        <div className="row">
          <button type="button" onClick={onRefresh}>Refresh</button>
          <button type="button" onClick={() => void downloadCsv()}>Export all CSV</button>
        </div>
      </div>
      {msg && <p className="error">{msg}</p>}
      {items.length === 0 && <p className="muted">Nothing tracked yet — pick a product from Catalog.</p>}
      <ul className="rows">
        {items.map((t) => {
          const l = latest[t.id];
          const out = l?.stock === 'sold_out';
          return (
            <li key={t.id} className="card tracked-row">
              <div className="tracked-main">
                <span className="eyebrow">{t.option_label} · {t.option_id}</span>
                <strong>{t.name}</strong>
                {!t.active && <span className="badge badge-paused">paused</span>}
              </div>
              <div className="tracked-side">
                {pending.includes(t.id) ? (
                  <span className="skel skel-badge" aria-label="Loading latest price…" />
                ) : l ? (
                  <>
                    <span className={`dot ${out ? 'dot-out' : 'dot-live'}`} aria-hidden="true" />
                    {l.price !== null && (
                      <span className="price price-md">₹{Number(l.price).toLocaleString('en-IN')}</span>
                    )}
                    {out && <span className="badge badge-out">Sold out</span>}
                  </>
                ) : (
                  <span className="muted">no history yet</span>
                )}
                <Link to={`/history/${t.id}`} className="btn">History</Link>
                <button type="button" onClick={() => void flip(t)}>
                  {t.active ? 'Pause' : 'Resume'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
