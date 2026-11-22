# BDO Arena of Solare (Asia) – Guess the Winner

A small quiz: you see two teams (classes + player names) from a real recent top-Asia 3v3 match and guess who won.

- `public/` – the static site (GitHub Pages)
- `scripts/update-data.js` – downloads the last 5 days of matches (top 100 Asia players, all six players rated 1800+) into `public/data.json`
- `.github/workflows/update.yml` – runs the script every 12 hours and redeploys the site; older matches drop out automatically

Match data comes from down-attack.com's Arena of Solare pages.

## How the Daily's questions are chosen
- A Daily has 12 matches (the last 2 are harder: ranks only, no names).
- From 23 Nov 2026 each day's questions come from a 24-hour window of real matches (10:00 two days before to 10:00 the day before, Malaysia time). The windows never overlap, so a question never comes back.
- The update job (`scripts/update-data.js`, `scripts/daily.js`) picks the day's questions once and publishes them as `daily/<day>.json`. Later updates copy that file unchanged, so everybody gets the same questions all day.
