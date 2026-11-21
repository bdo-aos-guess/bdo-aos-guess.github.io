// Downloads the newest AOS Asia matches of the top players and writes a static data file.
// Usage: node scripts/update-data.js public/data.json
// Keeps only the last KEEP_DAYS days (older matches are simply not written, i.e. deleted).
const fs = require('fs');
const path = require('path');

const SOURCE = 'https://down-attack.com/api/v1/solare';
const REGION = 'ASIA';
const TOP_PLAYERS = 100;
const KEEP_DAYS = 5;
const MIN_RATING = 1800; // only matches where all 6 players are at least this rating are saved
const GAP_MS = 500;     // be gentle with the source site
const MAX_PAGES = 4;    // 40 matches per page

const CLASSES = {
  0: 'Warrior', 1: 'Hashashin', 2: 'Sage', 3: 'Wukong', 4: 'Ranger', 5: 'Guardian', 6: 'Scholar',
  7: 'Drakania', 8: 'Sorceress', 9: 'Nova', 10: 'Corsair', 11: 'Lahn', 12: 'Berserker', 15: 'Maegu',
  16: 'Tamer', 17: 'Shai', 19: 'Striker', 20: 'Musa', 21: 'Maehwa', 23: 'Mystic', 24: 'Valkyrie',
  25: 'Kunoichi', 26: 'Ninja', 27: 'Dark Knight', 28: 'Wizard', 29: 'Archer', 30: 'Woosa', 31: 'Witch',
  32: 'Seraph', 33: 'Dosa', 34: 'Deadeye', 35: 'Agent',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'aos-guess-quiz/1.0' } });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${e.message} ${url}`);
      await sleep(1500 * i);
    }
  }
}

const slim = (p) => ({ n: p.user_nickname, c: CLASSES[p.class_type] || `Class ${p.class_type}`, k: p.kill_count, d: p.death_count, r: p.rank_rating, k2: p.current_ranking });
const rnd = () => Math.random().toString(36).slice(2, 6).padEnd(4, 'x');
// light scrambling so the winner is not readable at a glance in the file
const hideWinner = (isA) => Buffer.from(rnd() + (isA ? '1' : '0') + rnd()).toString('base64');

function toMatch(m) {
  if (!m.allies || !m.enemies || m.allies.length !== 3 || m.enemies.length !== 3) return null;
  if (typeof m.is_winner !== 'boolean') return null;
  const all = [...m.allies, ...m.enemies];
  if (!all.every((p) => p.rank_rating >= MIN_RATING)) return null;
  return {
    key: `${m.match_date}|${m.play_time_seconds}|${all.map((p) => p.user_no).sort().join(',')}`,
    t: m.match_date, s: m.play_time_seconds,
    a: m.allies.map(slim), b: m.enemies.map(slim), w: hideWinner(m.is_winner),
  };
}

(async () => {
  const out = process.argv[2] || 'public/data.json';
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const nicks = [];
  for (let page = 1; nicks.length < TOP_PLAYERS; page++) {
    const r = await getJSON(`${SOURCE}/ranking?region=${REGION}&page=${page}&limit=30`);
    nicks.push(...r.players.map((p) => p.user_nickname));
    if (!r.pagination.has_more) break;
    await sleep(GAP_MS);
  }
  const pool = new Map();
  let failed = 0;
  let done = 0;
  for (const nick of nicks.slice(0, TOP_PLAYERS)) {
    if (++done % 10 === 0) console.log(`progress: ${done}/${Math.min(nicks.length, TOP_PLAYERS)} players, ${pool.size} matches`);
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await getJSON(`${SOURCE}/player?region=${REGION}&nick=${encodeURIComponent(nick)}&page=${page}&limit=40`);
        const list = r.matches || [];
        for (const raw of list) {
          if (new Date(raw.match_date).getTime() < cutoff) continue; // older than KEEP_DAYS: dropped
          const m = toMatch(raw);
          if (m) pool.set(m.key, m);
        }
        const oldest = list.length ? new Date(list[list.length - 1].match_date).getTime() : 0;
        if (!r.pagination || !r.pagination.has_more || oldest < cutoff) break;
        await sleep(GAP_MS);
      }
    } catch (e) { failed++; console.warn('player failed:', nick, e.message); }
    await sleep(GAP_MS);
  }
  const matches = [...pool.values()].sort((x, y) => (y.t > x.t ? 1 : -1)).map(({ key, ...m }) => m);
  if (matches.length < 50) { console.error(`Only ${matches.length} matches found, refusing to overwrite data.`); process.exit(1); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), keepDays: KEEP_DAYS, matches }));
  console.log(`Wrote ${matches.length} matches (last ${KEEP_DAYS} days, ${failed} players failed) to ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
