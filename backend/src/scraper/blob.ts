import { createHash } from 'node:crypto';
import { DR, Fatal } from './protocol.js';

/** Decrypted quote payload. `q` = prominent selling price, `a` = stock. */
export interface QuotePayload {
  price: number;
  stockRaw: unknown;
  currency: string;
  raw: Record<string, unknown>;
}

/** XOR-decrypt the quote blob. Key = sha256(DR + '|enc|' + pass). See docs/protocol.md §4. */
export function decryptBlob(blobB64: string, pass: string): QuotePayload {
  const key = createHash('sha256').update(DR + '|enc|' + pass, 'utf8').digest();
  const enc = Buffer.from(blobB64, 'base64');
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) dec[i] = enc[i] ^ key[i % key.length];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(dec.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Fatal('blob decrypt produced invalid JSON (wrong key?)');
  }
  const price = o.q;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Fatal(`unverified price in blob: ${JSON.stringify(price)}`);
  }
  return {
    price,
    stockRaw: o.a,
    currency: typeof o.u === 'string' ? o.u : 'INR',
    raw: o,
  };
}
