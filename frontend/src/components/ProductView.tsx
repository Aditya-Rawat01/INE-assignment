import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  getPreview,
  getProduct,
  setActive,
  trackProduct,
  type PreviewResult,
  type ProductDetail,
  type TrackedItem,
} from '../api';

/** Human labels for known spec keys; unknown camelCase keys are prettified. */
function specLabel(key: string): string {
  const known: Record<string, string> = {
    weightGrams: 'Weight',
    inTheBox: 'In the box',
    countryOfOrigin: 'Country of origin',
    modelYear: 'Model year',
  };
  if (known[key]) return known[key];
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Human values: grams → kg/g, booleans → Yes/No, everything else as-is. */
function specValue(key: string, value: unknown): string {
  if (key === 'weightGrams' && typeof value === 'number') {
    return value >= 1000 ? `${(value / 1000).toFixed(2)} kg` : `${value} g`;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
export default function ProductView({
  productId,
  tracked,
  onChanged,
}: {
  productId: number;
  tracked: TrackedItem[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [opt, setOpt] = useState<string>('');
  const [picked, setPicked] = useState(false); // true once the user taps a chip
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setPreview(null);
    setOpt('');
    setPicked(false);
    setError(null);
    getProduct(productId)
      .then((d) => {
        if (!live) return;
        setDetail(d);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [productId]);

  // Default option: the tracked one (active first) so reopening a tracked
  // product lands on what's tracked; otherwise the first option.
  // Runs until the user taps a chip — including when the tracked list
  // arrives after the detail (no override of a manual pick, ever).
  useEffect(() => {
    if (!detail || picked) return;
    const mine = tracked.filter((t) => t.product_id === productId);
    const preferred = mine.find((t) => t.active) ?? mine[0];
    const want = preferred?.option_id ?? detail.options[0]?.id ?? '';
    if (want && want !== opt) setOpt(want);
  }, [detail, tracked, productId, opt, picked]);

  // Ephemeral preview per option selection — display only, writes nothing.
  // No abort: selections are user-paced clicks (~1s scrapes), stale results
  // are discarded via the `live` flag.
  useEffect(() => {
    if (!opt) return;
    let live = true;
    setPreviewLoading(true);
    setPreviewFailed(false);
    getPreview(productId, opt)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setPreviewLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setPreview(null);
        setPreviewLoading(false);
        setPreviewFailed(true);
        setMsg(`preview failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      live = false;
    };
  }, [productId, opt]);

  const mine = tracked.filter((t) => t.product_id === productId);
  const current = mine.find((t) => t.option_id === opt);

  async function doTrack() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await trackProduct(productId, opt);
      setMsg(`Tracking started — first price ${r.firstResult.price ?? 'sold out'}`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? 'Already tracked.' : `track failed: ${e instanceof Error ? e.message : String(e)}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function doResume() {
    if (!current) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await setActive(current.id, true);
      setMsg(`Resumed — current price ${r.resumedResult?.price ?? 'sold out'}`);
      onChanged();
    } catch (e) {
      setMsg(`resume failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <section><Link to="/" className="btn">← Back</Link><p className="error">{error}</p></section>;
  if (!detail) return <section><p className="muted">Loading…</p></section>;

  return (
    <section>
      <Link to="/" className="btn btn-ghost">← Catalog</Link>
      <p className="eyebrow">{detail.brand} · {detail.category} · {detail.sku}</p>
      <h2>{detail.name}</h2>
      <p>{detail.description}</p>

      {Object.keys(detail.specs).length > 0 && (
        <dl className="specs">
          {Object.entries(detail.specs).map(([k, v]) => (
            <div key={k}>
              <dt>{specLabel(k)}</dt>
              <dd>{specValue(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}

      <h3>
        {detail.option_axis || 'Options'}
      </h3>
      <div className="chips" role="group" aria-label={detail.option_axis || 'Options'}>
        {detail.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`chip${o.id === opt ? ' chip-on' : ''}`}
            aria-pressed={o.id === opt}
            onClick={() => { setPicked(true); setOpt(o.id); }}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className={`preview${preview?.stock === 'sold_out' ? ' preview-out' : ''}`}>
        {previewFailed ? (
          <p className="muted">Live price unavailable — tracking still works.</p>
        ) : previewLoading || !preview ? (
          <div className="skel skel-price" aria-label="Checking live price…" />
        ) : preview.outcome === 'failed' || preview.price === null ? (
          <p className="muted">Live price unavailable — tracking still works.</p>
        ) : (
          <p>
            <span className="price price-lg">
              ₹{preview.price.toLocaleString('en-IN')}
            </span>{' '}
            {preview.stock === 'sold_out' && <span className="badge badge-out">Sold out</span>}
            <span className="caption">
              {preview.attempts} attempt{preview.attempts === 1 ? '' : 's'}
            </span>
          </p>
        )}
      </div>

      <div className="row">
        {current?.active ? (
          <button type="button" disabled>Tracking ✓</button>
        ) : current ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={doResume}>Resume tracking</button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !opt} onClick={doTrack}>Track this option</button>
        )}
        {current && <Link to={`/history/${current.id}`} className="link">View scrape history →</Link>}
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
