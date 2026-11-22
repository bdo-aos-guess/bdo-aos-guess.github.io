// BDO AOS quiz - Daily leaderboard API on Cloudflare Workers (free plan) + D1 database.
//
//   GET  /top?scope=today|all   -> top 20 (public, no login needed)
//   POST /me     {token}                  -> the Discord user behind a login token + today's result (if already played)
//   POST /daily  {token, day, answers, points} -> saves the player's Daily result (one per Discord account per day)
//
// Players must log in with Discord to play the Daily. The token is checked with Discord itself
// (GET /oauth2/@me): it must have been issued to OUR Discord app and carry the "identify" scope.
// Names always come from Discord, never from the browser. Tokens are never stored.

import { handleDiscord, postDailyAnnouncement } from './bot.js';

const DISCORD_ME = 'https://discord.com/api/v10/oauth2/@me';
const MYT_MS = 8 * 3600e3;                 // the Daily day runs on Malaysia time (UTC+8)
const MAX_PER_ROUND = 750;                 // 150 base points x 5 (highest streak multiplier)
const MIN_PER_CORRECT = 50;                // (100 base) x 0.5 (hint used) is the least a correct answer can give
const TOP_CACHE_MS = 20_000;

const mem = { top: new Map(), users: new Map(), hits: new Map() };   // small per-instance caches

export const dayNow = (now = Date.now()) => new Date(now + MYT_MS).toISOString().slice(0, 10);

const json = (obj, status, cors) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors },
});

function corsFor(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: ok
      ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400', vary: 'Origin' }
      : { vary: 'Origin' },
  };
}

export const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);

function tooMany(request) {                 // best-effort flood guard: 60 requests / minute / IP / instance
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  const now = Date.now(), e = mem.hits.get(ip);
  if (!e || now - e.t > 60_000) { mem.hits.set(ip, { t: now, n: 1 }); if (mem.hits.size > 5000) mem.hits.clear(); return false; }
  return ++e.n > 60;
}

async function discordUser(token, env, deps) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]{20,200}$/.test(token)) return null;
  const cached = mem.users.get(token);
  if (cached && cached.exp > Date.now()) return cached.user;
  let res;
  try { res = await deps.fetch(DISCORD_ME, { headers: { authorization: 'Bearer ' + token } }); } catch { return null; }
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j || !j.application || String(j.application.id) !== String(env.DISCORD_CLIENT_ID)) return null;   // issued to another app
  if (!Array.isArray(j.scopes) || !j.scopes.includes('identify')) return null;
  const u = j.user;
  if (!u || !/^\d{15,25}$/.test(String(u.id))) return null;
  const user = {
    id: String(u.id),
    name: cleanName(u.global_name || u.username) || 'Player',
    avatar: typeof u.avatar === 'string' && /^[A-Za-z0-9_]{5,64}$/.test(u.avatar) ? u.avatar : null,
  };
  mem.users.set(token, { user, exp: Date.now() + 60_000 });
  if (mem.users.size > 2000) mem.users.clear();
  return user;
}

async function readTop(env, scope, day) {
  const key = scope + ':' + day, hit = mem.top.get(key);
  if (hit && Date.now() - hit.at < TOP_CACHE_MS) return hit.rows;
  let rows;
  if (scope === 'all') {
    // name / avatar come from the player's most recent row (SQLite picks the row of MAX(updated))
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, name, avatar, SUM(points) AS points, SUM(correct) AS correct, COUNT(*) AS days, MAX(updated) AS last
         FROM daily_scores GROUP BY id ORDER BY points DESC, correct DESC, last ASC LIMIT 20`).all());
  } else {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, name, avatar, correct, points, rounds FROM daily_scores WHERE day = ?1
         ORDER BY correct DESC, points DESC, updated ASC LIMIT 20`).bind(day).all());
  }
  mem.top.set(key, { at: Date.now(), rows });
  if (mem.top.size > 40) mem.top.clear();
  return rows;
}

const rankOf = async (env, day, correct, points) => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_scores WHERE day = ?1 AND (correct > ?2 OR (correct = ?2 AND points > ?3))')
    .bind(day, correct, points).first();
  return (r ? r.n : 0) + 1;
};

const botHelpers = { dayNow, readTop: (env, scope, day) => readTop(env, scope, day), rankOf: (env, day, c, p) => rankOf(env, day, c, p) };

export async function handle(request, env, deps = { fetch }) {
  const url = new URL(request.url);
  // Discord slash commands: signed by Discord, so no browser origin check here
  if (url.pathname === '/discord' && request.method === 'POST') return handleDiscord(request, env, botHelpers);
  const cors = corsFor(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
  if (!cors.ok) return json({ error: 'origin not allowed' }, 403, cors.headers);
  if (tooMany(request)) return json({ error: 'slow down' }, 429, cors.headers);

  try {
    const day = dayNow();

    if (url.pathname === '/top' && request.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'today';
      return json({ scope, day, rows: await readTop(env, scope, day) }, 200, cors.headers);
    }

    if (request.method === 'POST' && (url.pathname === '/me' || url.pathname === '/daily')) {
      if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'too large' }, 413, cors.headers);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'bad request' }, 400, cors.headers);
      const user = await discordUser(body.token, env, deps);
      if (!user) return json({ error: 'login' }, 401, cors.headers);

      const mine = await env.DB.prepare('SELECT correct, points, rounds, answers FROM daily_scores WHERE day = ?1 AND id = ?2').bind(day, user.id).first();

      if (url.pathname === '/me') {
        let today = null;
        if (mine) today = { ...mine, rank: await rankOf(env, day, mine.correct, mine.points) };
        return json({ id: user.id, name: user.name, avatar: user.avatar, day, today }, 200, cors.headers);
      }

      // ---- save a Daily result ----
      if (body.day !== day) return json({ error: 'day changed', day }, 409, cors.headers);     // the day rolled over while playing
      if (mine) return json({ ok: true, already: true, ...mine, rank: await rankOf(env, day, mine.correct, mine.points) }, 200, cors.headers);
      const { answers, points } = body;
      if (typeof answers !== 'string' || !/^[cwt]{5,15}$/.test(answers) || !Number.isInteger(points)) return json({ error: 'invalid result' }, 400, cors.headers);
      const rounds = answers.length, correct = (answers.match(/c/g) || []).length;
      const okPoints = correct === 0 ? points === 0 : points >= correct * MIN_PER_CORRECT && points <= correct * MAX_PER_ROUND;
      if (!okPoints) return json({ error: 'invalid result' }, 400, cors.headers);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO daily_scores (day, id, name, avatar, correct, points, rounds, answers, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(day, user.id, user.name, user.avatar, correct, points, rounds, answers, Date.now()).run();
      mem.top.clear();
      return json({ ok: true, already: false, correct, points, rounds, answers, rank: await rankOf(env, day, correct, points) }, 200, cors.headers);
    }
    return json({ error: 'not found' }, 404, cors.headers);
  } catch (e) {
    return json({ error: 'server error' }, 500, cors.headers);
  }
}

export default {
  fetch: (request, env) => handle(request, env, { fetch }),
  // timer (see wrangler.toml): announce the new Daily + yesterday's winners in a Discord channel (needs the DISCORD_WEBHOOK_URL secret)
  scheduled: (event, env, ctx) => { ctx.waitUntil(postDailyAnnouncement(env, botHelpers, { fetch }).catch(() => {})); },
};
