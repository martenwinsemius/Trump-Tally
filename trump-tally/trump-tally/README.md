# Trump false-claims tally

Static site + a small Cloudflare Worker, all on Cloudflare's free tier.

- `public/index.html`, `public/feed.json`: the site and the reviewed list (edit `feed.json` to add reviewed claims).
- `src/worker.js`: `GET /api/feed` and `POST /api/sync`. Sync searches NOS, NU.nl and NRC RSS feeds (max once per 15 min for everyone) and stores hits in Workers KV, so every visitor sees the same result.
- `wrangler.jsonc`: config. Put your KV namespace id in it.

## Deploy

    npx wrangler login
    npx wrangler kv namespace create FEED     # copy the id into wrangler.jsonc
    npx wrangler deploy

Local test: `npx wrangler dev`.

## Notes

- Automatically found articles are headlines + links only, shown as "Not reviewed", and are not counted in the tally.
- Check each source's terms (e.g. NOS RSS terms: non-commercial, headline with clear attribution, no ads).
- RSS URLs live at the top of `src/worker.js`; if a feed breaks, edit it there.
