// The Daily's 12 questions, chosen ONCE per day and then frozen.
//
// - From 2026-11-23 a day's questions come from a 24-hour window of real matches: [10:00 two days before, 10:00 the day
//   before) Malaysia time. Windows follow each other without overlap, so a question never comes back.
// - The set is published as daily/<day>.json. Every time the site is rebuilt, a set that is already published is
//   copied unchanged ("frozen"), so everybody gets exactly the same questions all day, whatever copy of the data they have.
// - A set is created only after its window has been over for 2 hours, so the match data already contains all of it.
// - The page uses this file; if it is missing the page works out the same set itself from the match data.
//
// The picking (hash32 / keyOf / window) is the same as in public/index.html (loadDaily).

const MYT_MS = 8 * 3600e3;
const DAILY_LEN = 12;
const ONE_DAY_FROM = '2026-11-23';
const EPOCH = Date.parse('2026-11-21T16:00:00Z');            // Daily #1 = 22 Nov 2026 00:00 Malaysia time
const SAFETY_MS = 2 * 3600e3;

const hash32 = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
const keyOf = (m) => m.t + '|' + m.s + '|' + m.a[0].n + '|' + m.b[0].n;
const dayStartOf = (id) => Date.parse(id + 'T00:00:00Z') - MYT_MS;            // that day's 00:00 Malaysia time, in UTC ms
const dayIdOf = (ms) => new Date(ms + MYT_MS).toISOString().slice(0, 10);
const windowOf = (id) => ({ from: dayStartOf(id) - 38 * 3600e3, to: dayStartOf(id) - 14 * 3600e3 });
const numberOf = (id) => Math.floor((dayStartOf(id) - EPOCH) / 864e5) + 1;

/** Picks the 12 questions for `id` from the match list (null if there are not enough matches in the window). */
function pickDaily(matches, id) {
  const { from, to } = windowOf(id);
  const pool = matches.filter((m) => { const t = new Date(m.t).getTime(); return t >= from && t < to; });
  if (pool.length < DAILY_LEN) return null;
  const ranked = pool.map((m) => ({ m, h: hash32(id + '|' + keyOf(m)) }))
    .sort((x, y) => x.h - y.h || (keyOf(x.m) < keyOf(y.m) ? -1 : 1)).slice(0, DAILY_LEN);
  return { id, number: numberOf(id), matches: ranked.map(({ m, h }) => ({ ...m, f: h & 1 })) };
}

const valid = (d, id) => !!d && d.id === id && Array.isArray(d.matches) && d.matches.length === DAILY_LEN
  && d.matches.every((m) => m && typeof m.t === 'string' && Array.isArray(m.a) && Array.isArray(m.b) && m.a.length === 3 && m.b.length === 3 && typeof m.w === 'string');

/**
 * The set for day `id`: the already published one if there is one (frozen), otherwise a new one -
 * but only when it is allowed to be created yet. Returns null when there is nothing to publish for that day.
 */
async function dailyFor(id, matches, { now = Date.now(), siteUrl, fetchFn = fetch } = {}) {
  if (id < ONE_DAY_FROM) return null;                          // before that the page works the old way
  try {
    const r = await fetchFn(String(siteUrl).replace(/\/?$/, '/') + 'daily/' + id + '.json', { headers: { 'user-agent': 'aos-guess-quiz/1.0' } });
    if (r.ok) { const d = await r.json(); if (valid(d, id)) return d; }
  } catch { /* nothing published yet, or no connection: fall through */ }
  if (now < windowOf(id).to + SAFETY_MS) return null;          // the window has not been over for 2 hours yet
  const made = pickDaily(matches, id);
  return made && valid(made, id) ? made : null;
}

module.exports = { pickDaily, dailyFor, dayIdOf, windowOf, hash32, keyOf, DAILY_LEN, ONE_DAY_FROM, MYT_MS };
