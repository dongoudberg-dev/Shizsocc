# Shizsociety — Cloudflare Edition

A Cloudflare Workers + D1 implementation. It does **not** use Express, Node SQLite, or a Node server.

## What's included
- Premium dark purple responsive design, custom inline SVG logo and icons (no emoji buttons).
- Username claims from 1 to 20 characters: letters, numbers and underscores.
- Case-insensitive global uniqueness enforced by a D1 UNIQUE constraint.
- Public profiles at `/u/username`.
- Profile editor with display name, bio, avatar URL, accent, backgrounds and social links.
- Owner dashboard at `/owner`: login, list all claimed names, edit display name/bio/views, delete profiles.
- Owner session is an HttpOnly, Secure, SameSite cookie signed using `OWNER_SECRET`.
- User edit token is generated once; only its SHA-256 hash is stored in D1.

## Deploy from a computer (recommended)
1. Install Node.js 20+.
2. Unzip this folder and open a terminal in it.
3. Run `npm install`.
4. Run `npx wrangler login`.
5. Create D1: `npx wrangler d1 create shizsociety-db`.
6. Copy the `database_id` from the command output into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
7. Create and apply the schema: `npx wrangler d1 migrations apply shizsociety-db --remote`.
8. Set secrets:
   - `npx wrangler secret put OWNER_PASSWORD`
   - `npx wrangler secret put OWNER_SECRET` (use a long random secret, at least 32 characters)
9. Deploy: `npm run deploy`.
10. In Cloudflare Workers & Pages, open the `shizsociety` Worker → Settings → Domains & Routes → Add Custom Domain → choose `shizsociety.online`.

## Run locally
- `npm install`
- `npx wrangler d1 migrations apply shizsociety-db --local`
- Add local secrets to `.dev.vars` (do not upload this file):
  ```
  OWNER_PASSWORD="your-long-password"
  OWNER_SECRET="a-random-secret-at-least-32-characters-long"
  ```
- `npm run dev`

## iPhone note
Cloudflare's dashboard on mobile can create a Worker, but it does not provide a simple upload-and-run flow for this complete source project plus D1 migrations/secrets. Use a computer with Wrangler, or a browser-based development environment that can run Node/npm and Wrangler. Do not upload this ZIP as a Pages static site: the API and database would not run.

## Security / production notes
- Keep `OWNER_PASSWORD` and `OWNER_SECRET` private. Never put them in public HTML or `wrangler.jsonc`.
- Use a strong unique owner password and a randomly generated `OWNER_SECRET`.
- The owner login endpoint should be protected further with Cloudflare rate limiting / Turnstile before a public launch.
- Profile views count page loads and can include bots/refreshes.
- Profile edit keys live in the claimant's browser local storage. Clearing site data can lose access to editing.
- Add a privacy policy, terms, backups and abuse reporting before broad public launch.
