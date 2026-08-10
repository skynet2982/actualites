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
const PAGE_DIR = './dist/page';
const HISTORY_FILE = './dist/history.json';
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// In-article "read also" links: how many to follow per article, and the
// total cap across the whole build, so a link-heavy page can't blow up
// build time. Only one level deep — links found inside those linked
// articles are left as-is, no further recursion.
const LINKS_PER_ARTICLE = 4;
const MAX_LINKED_ARTICLES = 20;
// How many articles stay in the paginated history, and how many
// url->local-page mappings we keep around across runs to resolve
// in-article links against articles fetched in a previous build.
const MAX_HISTORY = 200;
const MAX_RESOLVED = 1000;
const PAGE_SIZE = 20;

fs.mkdirSync('./dist', { recursive: true });
fs.mkdirSync(ARTICLES_DIR, { recursive: true });
fs.mkdirSync(PAGE_DIR, { recursive: true });

function createFile(fileName, data) {
  fs.writeFile(fileName, data, (err) => {
    if (!err) {
      console.log('File created: ' + fileName);
    }
  });
}

// dist/history.json is seeded by the GitHub Actions workflow from the
// previously deployed gh-pages before this script runs, so build state
// (which articles we've already fetched, and the full article history)
// survives across runs even though every run starts from a clean checkout.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return {
      items: Array.isArray(raw.items) ? raw.items : [],
      resolved: Array.isArray(raw.resolved) ? raw.resolved : [],
    };
  } catch {
    return { items: [], resolved: [] };
  }
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
function headlineOf(entry) {
  const suffix = ` - ${entry.source}`;
  return entry.title.endsWith(suffix) ? entry.title.slice(0, -suffix.length) : entry.title;
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
function inArticleLinksOf(html, baseUrl) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: baseUrl });
  const hostname = new URL(baseUrl).hostname;
  const resolvedUrls = new Set();
  dom.window.document.querySelectorAll('a[href]').forEach((a) => {
    try {
      const resolved = new URL(a.getAttribute('href'), baseUrl);
      if (
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        resolved.hostname === hostname &&
        resolved.href !== baseUrl
      ) {
        resolvedUrls.add(resolved.href);
      }
    } catch {
      // not a usable URL (mailto:, javascript:, etc.) — ignore
    }
  });
  return resolvedUrls;
}

// Rewrites <a href> in an article's HTML to local reader pages wherever the
// resolved (absolute) URL is a known key in resolvedSlugMap; everything
// else is left untouched (still points at the original site).
function rewriteInArticleLinks(html, baseUrl, resolvedSlugMap) {
  if (resolvedSlugMap.size === 0) return html;
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: baseUrl });
  dom.window.document.querySelectorAll('a[href]').forEach((a) => {
    let resolved;
    try {
      resolved = new URL(a.getAttribute('href'), baseUrl).href;
    } catch {
      return;
    }
    const slug = resolvedSlugMap.get(resolved);
    if (slug) {
      a.setAttribute('href', `${slug}.html`);
      a.removeAttribute('target');
    }
  });
  return dom.window.document.body.innerHTML;
}

function historyCardTemplate(entry, basePrefix) {
  const date = new Date(entry.pubDate);
  const displayDate = date.toLocaleString("fr-FR", { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: "Europe/Paris" });
  const isoDate = date.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const href = entry.slug ? `${basePrefix}articles/${entry.slug}.html` : entry.realUrl;
  return `<a class="card" rel="noopener" target="_blank" href="${href}" title="${escapeHtml(entry.title)}">
    <span class="card-source">${escapeHtml(entry.source || '')}</span>
    <h3 class="card-title">${escapeHtml(headlineOf(entry))}</h3>
    <time class="card-date" datetime="${isoDate}">${displayDate}</time>
  </a>`
}

// Relative href from the page currently being rendered (page 1 = dist/,
// page N>1 = dist/page/) to another page (page 1 = dist/index.html,
// page N>1 = dist/page/N.html — same directory as any page N>1).
function pageHref(targetPage, fromPage) {
  if (targetPage === 1) return '../index.html';
  return fromPage === 1 ? `page/${targetPage}.html` : `${targetPage}.html`;
}

function paginationNav(pageNum, totalPages) {
  if (totalPages <= 1) return '';
  const prev = pageNum > 1
    ? `<a class="page-link" href="${pageHref(pageNum - 1, pageNum)}">&larr; Plus récent</a>`
    : `<span class="page-link is-disabled">&larr; Plus récent</span>`;
  const next = pageNum < totalPages
    ? `<a class="page-link" href="${pageHref(pageNum + 1, pageNum)}">Plus ancien &rarr;</a>`
    : `<span class="page-link is-disabled">Plus ancien &rarr;</span>`;
  return `<nav class="pagination" aria-label="Pagination">
    ${prev}
    <span class="page-status">Page ${pageNum} / ${totalPages}</span>
    ${next}
  </nav>`;
}

(async () => {
  const state = loadState();
  const historyByGuid = new Map(state.items.filter((h) => h.slug).map((h) => [h.guid, h]));

  const feeds = [];
  for (const section of sources.sections) {
    for (const src of section.items) {
      feeds.push(await parser.parseURL(src.url));
    }
  }

  const allItems = feeds.flatMap((feed) => feed.items);

  // Split into items we've already processed in a previous run (reuse as-is,
  // no network calls) and genuinely new ones.
  const newItems = [];
  for (const item of allItems) {
    const existing = historyByGuid.get(item.guid);
    if (existing) {
      item.slug = existing.slug;
      item.realUrl = existing.realUrl;
    } else {
      newItems.push(item);
    }
  }

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
  for (const item of newItems) {
    const result = await decoder.decode(item.link);
    if (result && result.status) {
      item.realUrl = result.decoded_url;
    } else {
      console.warn(`Could not decode Google News link for "${item.title}": ${result && result.message}`);
      item.realUrl = item.link;
    }
  }

  // extracted: canonical fetch URL -> { title, byline, content, finalUrl, slug }.
  const extracted = new Map();

  await Promise.all(newItems.map(async (item) => {
    try {
      const article = await extractArticle(item.realUrl);
      const slug = slugFor(item.realUrl);
      extracted.set(item.realUrl, { ...article, title: article.title || item.title, slug });
      item.slug = slug;
    } catch (err) {
      console.warn(`Fallback to direct link for "${item.title}": ${err.message}`);
      item.slug = null;
    }
  }));

  // Persistent + this-run resolved-URL -> slug lookup. Used to avoid
  // re-fetching in-article links already resolved in a past run, and to
  // rewrite hrefs against everything we've ever extracted, not just what's
  // new this run.
  const resolvedSlugMap = new Map(state.resolved.map((r) => [r.url, r.slug]));
  for (const [url, article] of extracted) resolvedSlugMap.set(url, article.slug);

  const linkCandidates = new Set();
  for (const article of extracted.values()) {
    const links = [...inArticleLinksOf(article.content, article.finalUrl)].slice(0, LINKS_PER_ARTICLE);
    for (const url of links) {
      if (linkCandidates.size >= MAX_LINKED_ARTICLES) break;
      if (!resolvedSlugMap.has(url)) linkCandidates.add(url);
    }
  }

  await Promise.all([...linkCandidates].map(async (url) => {
    try {
      const article = await extractArticle(url);
      const slug = slugFor(url);
      extracted.set(url, { ...article, slug });
      resolvedSlugMap.set(url, slug);
    } catch {
      // Not every same-site link is an article (category pages, tag pages,
      // share links...) — silently leave those pointing at the original site.
    }
  }));

  for (const article of extracted.values()) {
    const page = templates.article({
      title: article.title || 'Article',
      byline: article.byline,
      content: rewriteInArticleLinks(article.content, article.finalUrl, resolvedSlugMap),
      sourceUrl: article.finalUrl,
    });
    createFile(`${ARTICLES_DIR}/${article.slug}.html`, page);
  }

  // Merge this run's items into the persisted history: replace/add entries
  // by guid, keep everything else, sort newest-first, cap at MAX_HISTORY.
  // Items that fall off the cap keep their reader page on disk (still
  // reachable, just no longer listed) rather than being deleted — deleting
  // them could break "à lire aussi" links from articles still in history.
  const processedByGuid = new Map(allItems.map((item) => [item.guid, {
    guid: item.guid,
    title: item.title,
    source: item.source,
    pubDate: item.pubDate,
    slug: item.slug,
    realUrl: item.realUrl,
  }]));
  const mergedItems = [...processedByGuid.values(), ...state.items.filter((h) => !processedByGuid.has(h.guid))]
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, MAX_HISTORY);
  const mergedResolved = [...resolvedSlugMap].map(([url, slug]) => ({ url, slug })).slice(-MAX_RESOLVED);

  createFile(HISTORY_FILE, JSON.stringify({ items: mergedItems, resolved: mergedResolved }));

  const pages = [];
  for (let i = 0; i < mergedItems.length || i === 0; i += PAGE_SIZE) {
    pages.push(mergedItems.slice(i, i + PAGE_SIZE));
    if (mergedItems.length === 0) break;
  }

  pages.forEach((pageItems, i) => {
    const pageNum = i + 1;
    const basePrefix = pageNum === 1 ? './' : '../';
    let body = `<section class="news-section">`;
      body += '<div class="news-grid">';
      body += pageItems.map((entry) => historyCardTemplate(entry, basePrefix)).join('');
      body += '</div>';
    body += `</section>`;
    body += paginationNav(pageNum, pages.length);

    const html = templates.document(body, { basePrefix });
    const fileName = pageNum === 1 ? './dist/index.html' : `${PAGE_DIR}/${pageNum}.html`;
    createFile(fileName, html);
  });
})();
