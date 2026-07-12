// One canonical NASCAR driver-name key for source, model, market, and gate joins.
export function normalizeNascarDriverName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
