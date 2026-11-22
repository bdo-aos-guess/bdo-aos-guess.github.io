// Discord slash-command bot for the Daily leaderboard (runs inside the same Cloudflare Worker, free plan).
//
//   /leaderboard [board: Today | All time]   -> the top 10, posted in the channel
//   /rank                                    -> your own position (only you can see it)
//   /daily                                   -> today's Daily: link, how many have played, when it resets
//
// Discord calls POST /discord for every command ("Interactions Endpoint URL"). Every call is signed by Discord;
// we check the signature with the app's PUBLIC key, so nobody else can talk to this endpoint.
// An optional timer (cron) posts yesterday's winners + "new Daily is ready" to a channel through a webhook.

const MYT_MS = 8 * 3600e3;
const EPOCH = Date.parse('2026-11-21T16:00:00Z');         // Daily #1 = 22 Nov 2026 00:00 Malaysia time
const GOLD = 0xd9b45a;
const MEDAL = ['🥇', '🥈', '🥉'];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const hexToBytes = (hex) => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; };
const num = (n) => Number(n || 0).toLocaleString('en-US');
// names come from Discord: neutralise Markdown so a name cannot restyle the message
export const md = (s) => String(s || '').replace(/([\\*_~`|>\[\]()#:@])/g, '\\$1');
export const dailyNumber = (day) => Math.floor((Date.parse(day + 'T00:00:00Z') - MYT_MS - EPOCH) / 864e5) + 1;
const nextReset = (now = Date.now()) => Math.floor(((Math.floor((now + MYT_MS) / 864e5) + 1) * 864e5 - MYT_MS) / 1000);

export async function verifySignature(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex || '') || !/^[0-9a-f]{64}$/i.test(publicKeyHex || '') || !/^\d{9,12}$/.test(timestamp || '')) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;            // stale / replayed request
    const msg = new TextEncoder().encode(timestamp + rawBody);
    const raw = hexToBytes(publicKeyHex);
    let key;
    try { key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']); }
    catch { key = await crypto.subtle.importKey('raw', raw, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']); }
    const alg = key.algorithm.name === 'Ed25519' ? 'Ed25519' : 'NODE-ED25519';
    return await crypto.subtle.verify(alg, key, hexToBytes(signatureHex), msg);
  } catch { return false; }
}

const linkRow = (env, label) => ({ type: 1, components: [{ type: 2, style: 5, label, url: env.SITE_URL || 'https://bdo-aos-guess.github.io/' }] });
const NO_PINGS = { parse: [] };

function boardEmbed(rows, scope, day, env) {
  const today = scope === 'today';
  const lines = rows.slice(0, 10).map((r, i) => {
    const place = i < 3 ? MEDAL[i] : '**' + (i + 1) + '.**';
    return today
      ? place + ' **' + md(r.name) + '** — ' + r.correct + '/' + r.rounds + ' · ' + num(r.points) + ' pts'
      : place + ' **' + md(r.name) + '** — ' + num(r.points) + ' pts · ' + r.days + (r.days === 1 ? ' day' : ' days');
  });
  const empty = today ? 'Nobody has finished today\'s Daily yet — be the first! 🏁' : 'No results yet.';
  return {
    title: today ? '🏆 Daily #' + dailyNumber(day) + ' leaderboard' : '🏆 All-time leaderboard',
    description: (lines.length ? lines.join('\n') : empty) + (today ? '\n\nResets <t:' + nextReset() + ':R>' : ''),
    color: GOLD,
    footer: { text: today ? day + ' · Malaysia time' : 'Total points over all Dailies' },
  };
}

async function cmdLeaderboard(i, env, h) {
  const opt = ((i.data.options || []).find((o) => o.name === 'board') || {}).value;
  const scope = opt === 'all' ? 'all' : 'today', day = h.dayNow();
  const rows = await h.readTop(env, scope, day);
  return json({ type: 4, data: { embeds: [boardEmbed(rows, scope, day, env)], components: [linkRow(env, 'Play today\'s Daily')], allowed_mentions: NO_PINGS } });
}

async function cmdRank(i, env, h) {
  const uid = String((i.member && i.member.user && i.member.user.id) || (i.user && i.user.id) || '');
  const day = h.dayNow();
  const me = await env.DB.prepare('SELECT correct, points, rounds FROM daily_scores WHERE day = ?1 AND id = ?2').bind(day, uid).first();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_scores WHERE day = ?1').bind(day).first();
  const all = await env.DB.prepare('SELECT SUM(points) AS p, SUM(correct) AS c, COUNT(*) AS d FROM daily_scores WHERE id = ?1').bind(uid).first();
  const lines = [];
  if (me) {
    const rank = await h.rankOf(env, day, me.correct, me.points);
    lines.push('**Today:** ' + me.correct + '/' + me.rounds + ' · ' + num(me.points) + ' pts — **#' + rank + '** of ' + num(total && total.n));
  } else {
    lines.push('**Today:** you have not finished today\'s Daily yet.');
  }
  if (all && all.d) {
    const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT id, SUM(points) AS p FROM daily_scores GROUP BY id HAVING p > ?1)').bind(all.p).first();
    lines.push('**All time:** ' + num(all.p) + ' pts over ' + all.d + (all.d === 1 ? ' day' : ' days') + ' — **#' + ((above ? above.n : 0) + 1) + '**');
  } else {
    lines.push('**All time:** no results yet. Log in with Discord on the website and play the Daily!');
  }
  return json({ type: 4, data: { embeds: [{ title: '📊 Your position', description: lines.join('\n'), color: GOLD }], flags: 64, allowed_mentions: NO_PINGS, components: me ? [] : [linkRow(env, 'Play today\'s Daily')] } });
}

async function cmdDaily(i, env, h) {
  const day = h.dayNow();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_scores WHERE day = ?1').bind(day).first();
  const top = await h.readTop(env, 'today', day);
  const lead = top[0] ? '\n👑 Leading: **' + md(top[0].name) + '** with ' + top[0].correct + '/' + top[0].rounds + ' (' + num(top[0].points) + ' pts)' : '';
  return json({ type: 4, data: {
    embeds: [{ title: '📅 Daily #' + dailyNumber(day), color: GOLD,
      description: '15 matches — same for everyone, one try per Discord account.\n**' + num(n && n.n) + '** ' + ((n && n.n) === 1 ? 'player has' : 'players have') + ' finished today.' + lead + '\n\nNext Daily <t:' + nextReset() + ':R>' }],
    components: [linkRow(env, 'Play today\'s Daily')], allowed_mentions: NO_PINGS } });
}

export async function handleDiscord(request, env, h) {
  const raw = await request.text();
  const ok = await verifySignature(raw, request.headers.get('x-signature-ed25519'), request.headers.get('x-signature-timestamp'), env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('invalid request signature', { status: 401 });
  let i; try { i = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }
  if (i.type === 1) return json({ type: 1 });                                  // Discord's PING check
  if (i.type === 2 && i.data) {
    try {
      if (i.data.name === 'leaderboard') return await cmdLeaderboard(i, env, h);
      if (i.data.name === 'rank') return await cmdRank(i, env, h);
      if (i.data.name === 'daily') return await cmdDaily(i, env, h);
    } catch { return json({ type: 4, data: { content: 'Something went wrong. Please try again in a moment.', flags: 64 } }); }
  }
  return json({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
}

// Cron (00:05 Malaysia time): post yesterday's winners and announce the new Daily. Needs the DISCORD_WEBHOOK_URL secret.
export async function postDailyAnnouncement(env, h, deps = { fetch }) {
  const hook = String(env.DISCORD_WEBHOOK_URL || '');
  if (!/^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) return { skipped: 'no valid webhook' };
  const today = h.dayNow(), yesterday = h.dayNow(Date.now() - 864e5);
  const rows = await h.readTop(env, 'today', yesterday);
  const embeds = [];
  if (rows.length) {
    embeds.push({ title: '🏆 Daily #' + dailyNumber(yesterday) + ' — final results', color: GOLD,
      description: rows.slice(0, 3).map((r, i) => MEDAL[i] + ' **' + md(r.name) + '** — ' + r.correct + '/' + r.rounds + ' · ' + num(r.points) + ' pts').join('\n') });
  }
  embeds.push({ title: '📅 Daily #' + dailyNumber(today) + ' is ready!', color: GOLD, description: '15 new matches. One try per Discord account — good luck!' });
  const res = await deps.fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'BDO AOS Daily', embeds, components: [linkRow(env, 'Play now')], allowed_mentions: NO_PINGS }) });
  return { status: res.status };
}
