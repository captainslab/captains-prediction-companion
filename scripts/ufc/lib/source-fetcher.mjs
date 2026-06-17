import { spawnSync } from 'node:child_process';

function parseRecord(recordStr) {
  const m = String(recordStr || '').match(/(\d+)-(\d+)-(\d+)/);
  if (!m) return null;
  return { wins: Number(m[1]), losses: Number(m[2]), draws: Number(m[3]) };
}

function cleanCell(cell) {
  return String(cell || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/_/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(cell) {
  const links = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of String(cell || '').matchAll(re)) links.push({ text: match[1], url: match[2] });
  return links;
}

function parsePairStat(cell) {
  const nums = String(cell || '').match(/--|\d+/g);
  if (!nums || nums.length < 2 || nums[0] === '--' || nums[1] === '--') return { for: null, against: null };
  return { for: Number(nums[0]), against: Number(nums[1]) };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function lastNameInitial(name) {
  const parts = normalizeName(name).split(' ').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last[0] || 'a';
}

export function parseFightHistory(markdown) {
  const fights = [];
  for (const line of String(markdown || '').split('\n')) {
    const wlMatch = line.match(/\[_(win|loss|draw|next)_\]/i);
    if (!wlMatch) continue;
    const result = wlMatch[1].toLowerCase();
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length >= 11) {
      const fightLinks = extractLinks(cells[1]);
      const fighterLinks = extractLinks(cells[2]);
      const eventLinks = extractLinks(cells[7]);
      const methodText = cleanCell(cells[8]);
      const methodMatch = methodText.match(/\b(KO\/TKO|SUB|U-DEC|S-DEC|DEC|M-DEC|CNC|Overturned|DQ)\b/i);
      const roundMatch = cleanCell(cells[9]).match(/\d+/);
      const timeMatch = cleanCell(cells[10]).match(/\d+:\d+/);
      const kd = parsePairStat(cells[3]);
      const sigStr = parsePairStat(cells[4]);
      const td = parsePairStat(cells[5]);
      const subAtt = parsePairStat(cells[6]);
      fights.push({
        result,
        method: methodMatch ? methodMatch[1].toUpperCase() : null,
        round: roundMatch ? Number(roundMatch[0]) : null,
        time: timeMatch ? timeMatch[0] : null,
        opponent: fighterLinks[1]?.text ?? null,
        opponent_url: fighterLinks[1]?.url ?? null,
        event: eventLinks[0]?.text ?? null,
        event_url: eventLinks[0]?.url ?? null,
        fight_url: fightLinks[0]?.url ?? null,
        kd_for: kd.for,
        kd_against: kd.against,
        sig_str_for: sigStr.for,
        sig_str_against: sigStr.against,
        td_for: td.for,
        td_against: td.against,
        sub_att_for: subAtt.for,
        sub_att_against: subAtt.against,
      });
      continue;
    }
    const methodMatch = line.match(/\|\s*(KO\/TKO|SUB|U-DEC|S-DEC|DEC|M-DEC|CNC|Overturned|DQ)\b/i);
    const timeMatch = line.match(/(\d+:\d+)/);
    fights.push({ result, method: methodMatch ? methodMatch[1].toUpperCase() : null, round: null, time: timeMatch ? timeMatch[0] : null });
  }
  return fights;
}

function searchFighterUrl(markdown, fighterName = null) {
  const target = normalizeName(fighterName);
  const rowRe = /\|\s*\[([^\]]+)\]\((https?:\/\/www\.ufcstats\.com\/fighter-details\/[a-f0-9]+)\)\s*\|\s*\[([^\]]+)\]\(https?:\/\/www\.ufcstats\.com\/fighter-details\/[a-f0-9]+\)/g;
  let fallback = null;
  for (const match of String(markdown || '').matchAll(rowRe)) {
    const fullName = normalizeName(`${match[1]} ${match[3]}`);
    fallback ||= match[2];
    if (target && fullName === target) return match[2];
  }
  return target ? null : fallback;
}

export function parseUfcStatsPage(markdown) {
  const text = String(markdown || '');
  const recordMatch = text.match(/Record:\s*(\d+-\d+-\d+)/i);
  const stats = {
    record: parseRecord(recordMatch?.[1] || null),
    fights: parseFightHistory(text),
  };
  for (const key of ['SLpM', 'Str. Acc.', 'SApM', 'Str. Def.', 'TD Avg.', 'TD Acc.', 'TD Def.', 'Sub. Avg.']) {
    const re = new RegExp(String.raw`-\s*_${key.replace(/\./g, '\\.')}:_\s*([0-9.]+)%?`, 'i');
    const m = text.match(re);
    if (!m) continue;
    const normalized = key.toLowerCase().replace(/\s+/g, '_').replace(/\./g, '').replace(/__+/g, '_');
    stats[normalized] = Number(m[1]);
  }
  const stanceMatch = text.match(/Stance:\s*([A-Za-z]+)/i);
  if (stanceMatch) stats.stance = stanceMatch[1];
  const reachMatch = text.match(/Reach:\s*(\d+\.?\d*)/i);
  if (reachMatch) stats.reach = Number(reachMatch[1]);
  const heightMatch = text.match(/Height:\s*([0-9'"\s]+)\b/i);
  if (heightMatch) stats.height = heightMatch[1].trim();
  return stats;
}

export function scrapeFighterSearch(fighterName) {
  const query = encodeURIComponent(lastNameInitial(fighterName));
  const url = `http://www.ufcstats.com/statistics/fighters?char=${query}&page=all`;
  const result = spawnSync('firecrawl', ['scrape', url, '--wait-for', '5000', '--only-main-content'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) return { ok: false, error: result.stderr || 'scrape failed', url: null };
  const detailUrl = searchFighterUrl(result.stdout, fighterName);
  return { ok: !!detailUrl, url: detailUrl, error: detailUrl ? null : 'fighter not found in search results' };
}

export function fetchFighter(fighterName, { cacheDir = null } = {}) {
  const search = scrapeFighterSearch(fighterName);
  if (!search.ok) return { ok: false, error: search.error || 'search failed', stats: null, source_url: null };
  const res = spawnSync('firecrawl', ['scrape', search.url, '--wait-for', '5000', '--only-main-content'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (res.status !== 0) return { ok: false, error: res.stderr || 'detail scrape failed', stats: null, source_url: search.url };
  const stats = parseUfcStatsPage(res.stdout);
  return {
    ok: true,
    error: null,
    stats: {
      ...stats,
      __source_quality: { source_url: search.url, source_method: 'firecrawl' },
    },
    source_url: search.url,
  };
}

export { searchFighterUrl };

