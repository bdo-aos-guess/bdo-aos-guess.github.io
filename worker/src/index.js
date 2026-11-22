// BDO AOS quiz - leaderboard API on Cloudflare Workers (free plan) + D1 database.
//
//   GET  /top      -> top 20 scores (public)
//   POST /me       -> {token}                              -> the Discord user behind a login token
//   POST /submit   -> {token, score, rounds, streak, acc}  -> saves / improves that Discord user's entry
//
// A score is only accepted together with a REAL Discord login token. The token is checked with Discord itself
// (GET /oauth2/@me), it must have been issued to OUR Discord app and carry the "identify" scope. The name on the
// leaderboard always comes from Discord, never from what the browser says. Tokens are never stored.

const DISCORD_ME = 'https://discord.com/api/v10/oauth2/@me';
const MAX_SCORE_PER_ROUND = 750;            // 150 base points x 5 (highest streak multiplier)
const LIMITS = { score: 1000000, rounds: 50000 };
const SUBMIT_COOLDOWN_MS = 10_000;          // one save per 10 s per player
const TOP_CACHE_MS = 20_000;

const mem = { top: null, users: new Map(), hits: new Map() };   // small per-instance caches

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
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function tooMany(request) {                 // best-effort flood guard: 40 requests / minute / IP / instance
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  const now = Date.now(), e = mem.hits.get(ip);
  if (!e || now - e.t > 60_000) { mem.hits.set(ip, { t: now, n: 1 }); if (mem.hits.size > 5000) mem.hits.clear(); return false; }
  return ++e.n > 40;
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

async function readTop(env) {
  if (mem.top && Date.now() - mem.top.at < TOP_CACHE_MS) return mem.top.rows;
  const { results } = await env.DB.prepare(
    'SELECT id, name, avatar, score, rounds, streak, acc FROM scores ORDER BY score DESC, updated ASC LIMIT 20').all();
  mem.top = { at: Date.now(), rows: results };
  return results;
}

export async function handle(request, env, deps = { fetch }) {
  const cors = corsFor(request, env);
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
  if (!cors.ok) return json({ error: 'origin not allowed' }, 403, cors.headers);
  if (tooMany(request)) return json({ error: 'slow down' }, 429, cors.headers);

  try {
    if (url.pathname === '/top' && request.method === 'GET') return json({ rows: await readTop(env) }, 200, cors.headers);

    if (request.method === 'POST' && (url.pathname === '/me' || url.pathname === '/submit')) {
      if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'too large' }, 413, cors.headers);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'bad request' }, 400, cors.headers);
      const user = await discordUser(body.token, env, deps);
      if (!user) return json({ error: 'login' }, 401, cors.headers);

      if (url.pathname === '/me') return json({ id: user.id, name: user.name, avatar: user.avatar }, 200, cors.headers);

      const { score, rounds, streak, acc } = body;
      if (!isInt(score, 0, LIMITS.score) || !isInt(rounds, 1, LIMITS.rounds) || !isInt(streak, 0, rounds) || !isInt(acc, 0, 100)
          || score > rounds * MAX_SCORE_PER_ROUND) return json({ error: 'invalid score' }, 400, cors.headers);

      const old = await env.DB.prepare('SELECT score, updated FROM scores WHERE id = ?').bind(user.id).first();
      const now = Date.now();
      if (old && now - old.updated < SUBMIT_COOLDOWN_MS) return json({ error: 'too fast' }, 429, cors.headers);

      await env.DB.prepare(
        `INSERT INTO scores (id, name, avatar, score, rounds, streak, acc, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, avatar = excluded.avatar, updated = excluded.updated,
           rounds = CASE WHEN excluded.score > scores.score THEN excluded.rounds ELSE scores.rounds END,
           streak = CASE WHEN excluded.score > scores.score THEN excluded.streak ELSE scores.streak END,
           acc    = CASE WHEN excluded.score > scores.score THEN excluded.acc    ELSE scores.acc    END,
           score  = MAX(scores.score, excluded.score)`)
        .bind(user.id, user.name, user.avatar, score, rounds, streak, acc, now).run();

      const best = Math.max(old ? old.score : 0, score);
      const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?').bind(best).first();
      mem.top = null;
      return json({ ok: true, best, improved: !old || score > old.score, rank: (above ? above.n : 0) + 1 }, 200, cors.headers);
    }
    return json({ error: 'not found' }, 404, cors.headers);
  } catch (e) {
    return json({ error: 'server error' }, 500, cors.headers);
  }
}

export default { fetch: (request, env) => handle(request, env, { fetch }) };
