# JPM Film Tracker

A private page where each JPM Weddings couple watches their film move from footage to premiere.

- `docs/` the website (GitHub Pages). Demo mode runs automatically until `docs/config.js` is filled in, or at `#demo`.
- `supabase/` database, security rules and the branded sign-in email.
- `sync/sync.mjs` copies client-safe fields from Notion every hour (GitHub Actions).
- `SETUP.md` one-time setup and day-to-day use.

Privacy: couples sign in with a one-time email link, see only their own film, and the site is hidden from search engines. No money, internal notes, team names or proxy links ever leave Notion. Nothing is ever deleted.
