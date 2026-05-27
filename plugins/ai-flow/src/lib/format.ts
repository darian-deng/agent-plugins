export function truncateError(e: unknown, max = 120): string {
  const s = String(e).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
