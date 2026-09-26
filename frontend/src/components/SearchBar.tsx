import { useEffect, useState } from 'react';

/** Debounced text input (~300ms). Parent fetches; no API calls here. */
export default function SearchBar({
  onQuery,
  placeholder = 'Search by product name…',
}: {
  onQuery: (q: string) => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const t = setTimeout(() => onQuery(value.trim()), 300);
    return () => clearTimeout(t);
  }, [value, onQuery]);

  return (
    <input
      type="search"
      className="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      aria-label="Search products"
    />
  );
}
