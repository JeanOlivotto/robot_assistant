import { timingSafeEqual } from 'node:crypto';

/** Compara tokens em tempo constante. */
export function tokenEquals(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
