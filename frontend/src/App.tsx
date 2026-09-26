import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useParams } from 'react-router';
import './App.css';
import { listTracked, type TrackedItem } from './api';
import CatalogTab from './components/CatalogTab';
import HistoryView from './components/HistoryView';
import ProductView from './components/ProductView';
import TrackedTab from './components/TrackedTab';

function ProductRoute({ tracked, onChanged }: { tracked: TrackedItem[]; onChanged: () => void }) {
  const { id } = useParams();
  return <ProductView productId={Number(id)} tracked={tracked} onChanged={onChanged} />;
}

function HistoryRoute() {
  const { trackedId } = useParams();
  return <HistoryView trackedId={Number(trackedId)} />;
}

export default function App() {
  const [tracked, setTracked] = useState<TrackedItem[]>([]);
  const { pathname } = useLocation();
  // Section-aware tabs: product pages belong to Catalog, history to Tracked.
  const catalogActive = pathname === '/' || pathname.startsWith('/product/');
  const trackedActive = pathname === '/tracked' || pathname.startsWith('/history/');

  const refreshTracked = useCallback(() => {
    listTracked()
      .then((d) => setTracked(d.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshTracked();
  }, [refreshTracked]);

  return (
    <main className="app">
      <header className="topbar">
        <Link to="/" className="brand">Price Tracker</Link>
        <nav className="tabs">
          <NavLink to="/" end className={catalogActive ? 'active' : undefined}>Catalog</NavLink>
          <NavLink to="/tracked" className={trackedActive ? 'active' : undefined}>Tracked ({tracked.length})</NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<CatalogTab tracked={tracked} />} />
        <Route path="/product/:id" element={<ProductRoute tracked={tracked} onChanged={refreshTracked} />} />
        <Route
          path="/tracked"
          element={<TrackedTab items={tracked} onChanged={refreshTracked} onRefresh={refreshTracked} />}
        />
        <Route path="/history/:trackedId" element={<HistoryRoute />} />
        <Route path="*" element={<p>Not found. <Link to="/">Back to catalog</Link></p>} />
      </Routes>
    </main>
  );
}
