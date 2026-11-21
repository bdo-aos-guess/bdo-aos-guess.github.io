# BDO Arena of Solare (Asia) – Guess the Winner

A small quiz: you see two teams (classes + player names) from a real recent top-Asia 3v3 match and guess who won.

- `public/` – the static site (GitHub Pages)
- `scripts/update-data.js` – downloads the last 5 days of matches (top 100 Asia players, all six players rated 1800+) into `public/data.json`
- `.github/workflows/update.yml` – runs the script every 12 hours and redeploys the site; older matches drop out automatically

Match data comes from down-attack.com's Arena of Solare pages.
