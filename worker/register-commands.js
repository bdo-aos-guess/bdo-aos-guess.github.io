// Registers the slash commands (/leaderboard, /rank, /daily) with Discord. Run it ONCE (and again only if you change the commands):
//
//   PowerShell:   $env:DISCORD_BOT_TOKEN = "paste-your-bot-token-here"; node register-commands.js
//
// The bot token is read from your own terminal only. It is never stored in a file or sent anywhere except to Discord.

const CLIENT_ID = '1573942282673979593';          // your Discord application's Client ID (public)
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error('Set DISCORD_BOT_TOKEN first (see the comment at the top of this file).'); process.exit(1); }

const commands = [
  {
    name: 'leaderboard',
    description: 'Show the Daily leaderboard',
    options: [{
      type: 3, name: 'board', description: 'Which leaderboard? (default: today)', required: false,
      choices: [{ name: 'Today', value: 'today' }, { name: 'All time', value: 'all' }],
    }],
  },
  { name: 'rank', description: 'Show your own position (only you can see it)' },
  { name: 'daily', description: 'Today\'s Daily: how many have played, who leads, and the link' },
];

(async () => {
  const res = await fetch('https://discord.com/api/v10/applications/' + CLIENT_ID + '/commands', {
    method: 'PUT',
    headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const body = await res.text();
  if (!res.ok) { console.error('Discord said no (' + res.status + '):', body); process.exit(1); }
  console.log('Registered', JSON.parse(body).map((c) => '/' + c.name).join('  '));
  console.log('Global commands can take a few minutes to show up in Discord.');
})();
