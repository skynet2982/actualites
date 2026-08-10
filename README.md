# Actualités

A static news digest built from Google News RSS. It pulls headlines for a
handful of French cities/regions, resolves each Google News redirect to the
real publisher URL, fetches the article and extracts a clean, ad-free reading
view (à la Firefox Reader View), then publishes the whole thing as a static
site — no ads, no tracking, no paywalled redirect loops.

![screenshot](screenshot.png)

## How it works

On every build (`node index.js`):

1. **Fetch** — each category in [sources.json](sources.json) lists one or
   more Google News RSS feed URLs; all are fetched and merged.
2. **Decode** — Google News RSS links are opaque redirects
   (`news.google.com/rss/articles/...`); each one is decoded to the real
   publisher URL (`google-news-url-decoder`), one at a time and sequentially,
   which avoids a response-reordering bug in Google's batch decode endpoint.
3. **Extract** — the real article page is fetched and run through
   [Readability](https://github.com/mozilla/readability) to strip ads/nav/etc,
   then sanitized with DOMPurify. If a source page also carries a
   `schema.org articleSection` (JSON-LD) or `<meta property="article:section">`,
   that becomes a visible theme label on the article's card (e.g. "Faits
   divers", "Politique").
4. **Follow "à lire aussi" links** — same-site links found inside an
   extracted article are given a clean reader page too (capped per article
   and per build), so readers don't get bounced back to the ad-filled
   original site.
5. **Render** — static HTML pages are generated per category, paginated
   20 articles/page, with up to 200 articles kept in a persisted history
   per category (`dist/history.json`) so past articles stay reachable across
   builds even once new ones push them off the front page.

## Categories

Categories live in [sources.json](sources.json). The **first entry is the
default landing page** (`dist/index.html`); every other category gets its own
subfolder (`dist/<slug>/`). Order in the file also sets the order of the
category-switch buttons at the top of the site.

To add a city, add an entry with a Google News RSS feed for it — either a
location "topic" feed (visit Google News, browse to the location, copy the
RSS-style topic URL) or a plain search feed:

```json
{
  "slug": "bordeaux",
  "label": "Bordeaux",
  "feeds": ["https://news.google.com/rss/search?q=Bordeaux&hl=fr&gl=FR&ceid=FR:fr"]
}
```

## Development

```bash
npm install
npm run build   # runs node index.js, writes the static site to dist/
```

Open `dist/index.html` (or serve the `dist/` folder) to preview locally.
`dist/history.json` and `dist/articles/` persist state between builds — the
GitHub Actions workflow restores them from the deployed `gh-pages` branch
before each run so history survives across clean checkouts.

## Deployment

[.github/workflows/build.yml](.github/workflows/build.yml) rebuilds and
redeploys automatically: every 30 minutes on a schedule, and on every push to
`main`. It publishes `dist/` to the `gh-pages` branch, which GitHub Pages then
serves.

## Project structure

- `sources.json` — categories and their RSS feeds
- `index.js` — the whole build pipeline (fetch → decode → extract → render)
- `templates.js` — HTML templates (page shell, article reader page)
- `dist/styles.css` — the only hand-maintained file under `dist/`; everything
  else in `dist/` is generated and gitignored

## License

MIT — see [LICENSE](LICENSE).
