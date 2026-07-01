// Derive whether a historical match was played at a neutral site.
export function isNeutral(row) {
  const v = row?.venueCode;
  if (!v) return false;
  return v !== row.homeCode && v !== row.awayCode;
}
