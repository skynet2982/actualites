const fs = require('fs');
const crypto = require('crypto');
let Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const createDOMPurify = require('dompurify');
const { GoogleDecoder } = require('google-news-url-decoder');
const templates = require('./templates.js');
let parser = new Parser({ customFields: { item: ['source'] } });
let decoder = new GoogleDecoder();
const sources = JSON.parse(fs.readFileSync('sources.json'));

const ARTICLES_DIR = './dist/articles';
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// In-article "read also" links: how many to follow per article, and the
// total cap across the whole build, so a link-heavy page can't blow up
// build time. Only one level deep — links found inside those linked
// articles are left as-is, no further recursion.
const LINKS_PER_ARTICLE = 4;
const MAX_LINKED_ARTICLES = 20;

fs.mkdirSync('./dist', { recursive: true });
fs.mkdirSync(ARTICLES_DIR, { recursive: true });

function createFile(fileName, data) {
  fs.writeFile(fileName, data, (err) => {
    if (!err) {
      console.log('File created: ' + fileName);
    }
  });
}

function slugFor(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Google News RSS titles are formatted as "Headline - source.fr"; the
// source is already exposed separately as item.source, so drop the
// redundant suffix for display.
function headlineOf(item) {
  const suffix = ` - ${item.source}`;
  return item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title;
}

// Fetches the article and extracts a clean, ad-free version with
// Readability (the same engine Firefox Reader View and the now-defunct
// clearthis.page used).
async function extractArticle(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const html = await res.text();
  const dom = new JSDOM(html, { url: res.url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  if (!parsed || !parsed.content) {
    throw new Error('Readability could not extract an article');
  }
  const DOMPurify = createDOMPurify(dom.window);
  return {
    title: parsed.title,
    byline: parsed.byline,
    content: DOMPurify.sanitize(parsed.content),
    finalUrl: res.url,
  };
}

// Finds same-site links inside an article's body (e.g. "à lire aussi"
// blocks) — the kind of in-article link that should also open as a clean
// reader page instead of dumping the reader back onto the ad-filled site.
// Returns a Map of the literal href text found (so it can be matched again
// later) to its resolved absolute URL.
function inArticleLinksOf(html, baseUrl) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: baseUrl });
  const hostname = new URL(baseUrl).hostname;
  const links = new Map();
  dom.window.document.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    try {
      const resolved = new URL(raw, baseUrl);
      if (
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        resolved.hostname === hostname &&
        resolved.href !== baseUrl
      ) {
        links.set(raw, resolved.href);
      }
    } catch {
      // not a usable URL (mailto:, javascript:, etc.) — ignore
    }
  });
  return links;
}

// Rewrites <a href> in an article's HTML to local reader pages wherever the
// literal href text is a known key in hrefMap; everything else is left
// untouched (still points at the original site).
function rewriteInArticleLinks(html, hrefMap) {
  if (hrefMap.size === 0) return html;
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  dom.window.document.querySelectorAll('a[href]').forEach((a) => {
    const local = hrefMap.get(a.getAttribute('href'));
    if (local) {
      a.setAttribute('href', local);
      a.removeAttribute('target');
    }
  });
  return dom.window.document.body.innerHTML;
}

function itemTemplate(item) {
  const date = new Date(item.pubDate);
  const displayDate = date.toLocaleString("fr-FR", { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: "Europe/Paris" });
  const isoDate = date.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  return `<a class="card" rel="noopener" target="_blank" href="${item.readerHref}" title="${escapeHtml(item.title)}">
    <span class="card-source">${escapeHtml(item.source || '')}</span>
    <h3 class="card-title">${escapeHtml(headlineOf(item))}</h3>
    <time class="card-date" datetime="${isoDate}">${displayDate}</time>
  </a>`
}

(async () => {
  const feeds = [];
  for (const section of sources.sections) {
    for (const src of section.items) {
      feeds.push(await parser.parseURL(src.url));
    }
  }

  feeds.forEach((feed) => {
    feed.items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    feed.items = feed.items.slice(0, 20);
  });

  const allItems = feeds.flatMap((feed) => feed.items);

  // Google News RSS links (news.google.com/rss/articles/...) are opaque
  // redirects that dead-end on an EU cookie-consent page when fetched
  // directly. Decoding them locally gets us the real publisher URL, gaa_*
  // tokens included (Google's "News Showcase" grant that unlocks some
  // paywalled articles for readers coming from Google News).
  //
  // NOTE: decoder.decodeBatch() sends all links in one grouped Google
  // batchexecute call and re-matches results by their position in the
  // response array, but Google does not guarantee that response order
  // matches request order for that endpoint — it silently mismatched
  // articles in practice. Decoding one link at a time, sequentially, avoids
  // that reordering bug entirely (each call is self-contained).
  for (const item of allItems) {
    const result = await decoder.decode(item.link);
    if (result && result.status) {
      item.realUrl = result.decoded_url;
    } else {
      console.warn(`Could not decode Google News link for "${item.title}": ${result && result.message}`);
      item.realUrl = item.link;
    }
  }

  // extracted: fetch URL -> { title, byline, content, finalUrl, slug }.
  // Keyed by the exact URL we fetched, so later link-rewriting can match
  // the literal href text found in another article's body.
  const extracted = new Map();

  await Promise.all(allItems.map(async (item) => {
    try {
      const article = await extractArticle(item.realUrl);
      extracted.set(item.realUrl, { ...article, title: article.title || item.title, slug: slugFor(item.realUrl) });
      item.readerHref = `./articles/${slugFor(item.realUrl)}.html`;
    } catch (err) {
      console.warn(`Fallback to direct link for "${item.title}": ${err.message}`);
      item.readerHref = item.realUrl;
    }
  }));

  // One extra pass: follow same-site links found inside the articles we
  // just extracted (e.g. "à lire aussi") and give those a clean reader page
  // too, capped so a link-heavy article can't blow up the build.
  const linkCandidates = new Map();
  for (const article of extracted.values()) {
    const links = [...inArticleLinksOf(article.content, article.finalUrl)].slice(0, LINKS_PER_ARTICLE);
    for (const [raw, resolved] of links) {
      if (linkCandidates.size >= MAX_LINKED_ARTICLES) break;
      if (!extracted.has(raw)) linkCandidates.set(raw, resolved);
    }
  }

  await Promise.all([...linkCandidates].map(async ([raw, resolved]) => {
    try {
      const article = await extractArticle(resolved);
      extracted.set(raw, { ...article, slug: slugFor(resolved) });
    } catch (err) {
      // Not every same-site link is an article (category pages, tag pages,
      // share links...) — silently leave those pointing at the original site.
    }
  }));

  // Local reader pages all live flat in dist/articles/, and this map is only
  // ever used to rewrite links found *inside* article bodies (which are
  // themselves rendered from dist/articles/*.html) — so the target is a
  // same-directory sibling, not "./articles/...".
  const hrefMap = new Map([...extracted].map(([fetchUrl, article]) => [fetchUrl, `${article.slug}.html`]));

  for (const article of extracted.values()) {
    const page = templates.article({
      title: article.title || 'Article',
      byline: article.byline,
      content: rewriteInArticleLinks(article.content, hrefMap),
      sourceUrl: article.finalUrl,
    });
    createFile(`${ARTICLES_DIR}/${article.slug}.html`, page);
  }

  let output = ``;

  feeds.forEach((feed) => {
    output += `<section class="news-section">`;
      output += `<h2 class="h3">${escapeHtml(feed.title)}</h2>`;
      output += '<div class="news-grid">';
      output += feed.items.map(itemTemplate).join('');
      output += '</div>';
    output += `</section>`;
  });

  output = templates.document(output);

  createFile('./dist/index.html', output);
})();
