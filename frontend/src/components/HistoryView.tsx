import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { downloadCsv, getHistory, getPreview, type HistoryResponse } from '../api';

const TEAL = '#0f766e';
const AMBER = '#d97706';

const fmtDay = (ts: number) =>
  new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function stockLabel(s: string | null | undefined): string {
  if (s === 'sold_out') return 'Sold out';
  if (s === 'in_stock') return 'In stock';
  return s ?? '';
}

function ChartTip({ active, payload, label, nowHint }: {
  active?: boolean;
  payload?: Array<{ value: number | string; payload?: Partial<ChartPoint> }>;
  label?: number | string;
  nowHint?: { at: number; price: number; stock: string | null } | null;
}) {
  if (!active || !payload?.length) return null;
  // Area points carry the full datum; the hollow ReferenceDot only yields
  // coordinates, so fall back to the live nowHint when shapes differ.
  const datum = payload[0].payload;
  const live = datum?.live === true || (nowHint !== null && nowHint !== undefined && Number(label) === nowHint.at);
  const at = datum?.at ?? nowHint?.at ?? Number(label);
  const price = datum?.price ?? nowHint?.price ?? Number(payload[0].value);
  const stock = datum?.stock ?? nowHint?.stock ?? null;
  return (
    <div className="chart-tip">
      <div className="muted">{new Date(at).toLocaleString('en-IN')}</div>
      <div className="price">₹{Number(price).toLocaleString('en-IN')}</div>
      <div className="muted">{live ? 'Live now' : stockLabel(stock)}{live && stock ? ` · ${stockLabel(stock)}` : ''}</div>
    </div>
  );
}

interface ChartPoint {
  at: number;
  price: number;
  stock: string | null;
  live?: boolean;
}

/**
 * Per-product history: stored points as a line, ephemeral live price as a
 * hollow "now" dot (legend: live, not stored), full attempt log below.
 */
export default function HistoryView({ trackedId }: { trackedId: number }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [now, setNow] = useState<{ at: number; price: number; stock: string | null } | null>(null);
  const [nowOff, setNowOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setNow(null);
    setNowOff(false);
    setError(null);
    getHistory(trackedId, 200)
      .then((h) => {
        if (!live) return;
        setData(h);
        // Ephemeral now-dot: live preview, never stored. Its retries stay
        // in-memory only (attempt count shown, no rows written anywhere).
        getPreview(h.tracked.product_id, h.tracked.option_id)
          .then((p) => {
            if (!live) return;
            if (p.price !== null) setNow({ at: Date.now(), price: p.price, stock: p.stock });
            else setNowOff(true);
          })
          .catch(() => live && setNowOff(true));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [trackedId]);

  if (error) return <section><Link to="/tracked" className="btn">← Back</Link><p className="error">{error}</p></section>;
  if (!data) {
    return (
      <section aria-label="Loading history">
        <div className="skel skel-line" />
        <div className="skel skel-chart" />
        <div className="skel skel-line" />
        <div className="skel skel-table" />
      </section>
    );
  }

  // Chart data: stored points plus the live now-point as the final dot, so
  // the line connects through to "now". Renders even when history is empty
  // (sold-out items whose only rows predate priced storage) — then it's just
  // the live dot on padded axes.
  const chart: ChartPoint[] = data.points
    .filter((p) => p.price !== null)
    .map((p) => ({ at: new Date(p.at).getTime(), price: Number(p.price), stock: p.stock }));
  if (now) chart.push({ at: now.at, price: now.price, stock: now.stock, live: true });

  // Domains cover every plotted point (single-point charts get min padding
  // so axes never collapse).
  const xs = chart.map((p) => p.at);
  const ys = chart.map((p) => p.price);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const xPad = Math.max(60_000, xSpan * 0.05);
  const xDomain: [number, number] = [Math.min(...xs) - xPad, Math.max(...xs) + xPad];
  const yPad = Math.max(1, (Math.max(...ys) - Math.min(...ys)) * 0.1);
  const yDomain: [number, number] = [Math.min(...ys) - yPad, Math.max(...ys) + yPad];
  const livePt = chart.find((p) => p.live);

  return (
    <section>
      <Link to="/tracked" className="btn btn-ghost">← Tracked</Link>
      <p className="eyebrow">{data.tracked.option_label} · {data.tracked.option_id}{!data.tracked.active && ' · paused'}</p>
      <h2>{data.tracked.name}</h2>

      {chart.length > 0 ? (
        <div className="chart-card">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chart} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TEAL} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={TEAL} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d9" vertical={false} />
              <XAxis dataKey="at" type="number" domain={xDomain} tickFormatter={fmtDay} tick={{ fill: '#78716c', fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis domain={yDomain} tickFormatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} tick={{ fill: '#78716c', fontSize: 12 }} axisLine={false} tickLine={false} width={72} />
              <Tooltip content={<ChartTip nowHint={now} />} />
              <Area
                type="monotone"
                dataKey="price"
                stroke={TEAL}
                strokeWidth={2.5}
                fill="url(#priceFill)"
                dot={(p: { cx?: number; cy?: number; payload?: ChartPoint }) =>
                  p.payload?.live ? (
                    <g key={`live-${p.payload.at}`} />
                  ) : (
                    <circle key={`d-${p.payload?.at}`} cx={p.cx} cy={p.cy} r={4} fill={TEAL} stroke="none" />
                  )
                }
                activeDot={{ r: 5, fill: TEAL }}
                name="stored price"
              />
              {livePt && (
                <ReferenceDot x={livePt.at} y={livePt.price} r={4} fill="none" stroke={AMBER} strokeWidth={2} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted">No successful scrapes yet.</p>
      )}
      <p className="now-legend"><span className="now-dot" aria-hidden="true" /> {now ? 'hollow dot = live price now' : nowOff ? 'live price unavailable right now' : 'fetching live price…'}</p>

      <div className="row">
        <h3>Scrape log ({data.log.length})</h3>
        <button type="button" onClick={() => void downloadCsv(trackedId)}>Export CSV</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Time (local)</th>
            <th className="ctr">Attempt</th>
            <th className="ctr">Price</th>
            <th className="ctr">Stock</th>
            <th className="ctr">Outcome</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {data.log.map((r, i) => (
            <tr key={i}>
              <td className="mono">{new Date(r.at).toISOString().slice(0, 19)}Z</td>
              <td className="mono">{new Date(r.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</td>
              <td className="ctr">{r.attempt}</td>
              <td className="ctr">{r.price === null ? '—' : `₹${Number(r.price).toLocaleString('en-IN')}`}</td>
              <td className="ctr">{r.stock ?? '—'}</td>
              <td className="ctr"><span className={`pill pill-${r.outcome}`}>{r.outcome}</span></td>
              <td className={r.error ? 'muted' : 'muted ctr'}>{r.error ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
