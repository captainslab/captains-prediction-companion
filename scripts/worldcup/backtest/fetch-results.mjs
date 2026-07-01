// Fetch a single year's eloratings results TSV. Network only; no parsing here.
export async function fetchResultsYear(year, { fetchImpl = fetch } = {}) {
  const url = `https://www.eloratings.net/${year}_results.tsv`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}
