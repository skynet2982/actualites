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
const PRIMARY_CATEGORY = sources.categories[0].slug;

const ARTICLES_DIR = './dist/articles';
const HISTORY_FILE = './dist/history.json';
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// In-article "read also" links: how many to follow per article, and the
// total cap across the whole build, so a link-heavy page can't blow up
// build time. Only one level deep — links found inside those linked
// articles are left as-is, no further recursion.
const LINKS_PER_ARTICLE = 4;
const MAX_LINKED_ARTICLES = 20;
// How many articles stay in the paginated history (per category), and how
// many url->local-page mappings we keep around across runs to resolve
// in-article links against articles fetched in a previous build.
const MAX_HISTORY = 200;
const MAX_RESOLVED = 1000;
const PAGE_SIZE = 20;

fs.mkdirSync('./dist', { recursive: true });
fs.mkdirSync(ARTICLES_DIR, { recursive: true });

function createFile(fileName, data) {
  fs.mkdirSync(fileName.substring(0, fileName.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(fileName, data);
  console.log('File created: ' + fileName);
}

// dist/history.json is seeded by the GitHub Actions workflow from the
// previously deployed gh-pages before this script runs, so build state
// (which articles we've already fetched, and the full article history per
// category) survives across runs even though every run starts from a clean
// checkout.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return {
      resolved: Array.isArray(raw.resolved) ? raw.resolved : [],
      categories: raw.categories && typeof raw.categories === 'object' ? raw.categories : {},
    };
  } catch {
    return { resolved: [], categories: {} };
  }
}

function slugFor(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

// Article extraction (fetch + JSDOM parse + Readability + DOMPurify) is
// memory-heavy, and a brand-new category starts with zero history, so every
// one of its items is "new" — running all of them at once nearly OOM-killed
// the build the first time a few hundred-item categories were added at once.
// Cap how many run concurrently instead of firing off the whole batch.
const EXTRACTION_CONCURRENCY = 8;
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

// The RSS feeds themselves carry no per-item category, but most publishers
// embed one in the article page: either schema.org NewsArticle
// "articleSection" (JSON-LD, possibly wrapped in an @graph) or the
// og-style <meta property="article:section">. Read before Readability
// strips the page down, since it mutates the document.
function sectionOf(document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const candidates = node && Array.isArray(node['@graph']) ? node['@graph'] : [node];
      for (const candidate of candidates) {
        const section = candidate && candidate.articleSection;
        const value = Array.isArray(section) ? section[0] : section;
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
  }
  const meta = document.querySelector('meta[property="article:section"]');
  return meta && meta.content && meta.content.trim() ? meta.content.trim() : null;
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
  const section = sectionOf(dom.window.document);
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
    section,
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

function historyCardTemplate(entry, rootPrefix) {
  const date = new Date(entry.pubDate);
  const displayDate = date.toLocaleString("fr-FR", { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: "Europe/Paris" });
  const isoDate = date.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const href = entry.slug ? `${rootPrefix}articles/${entry.slug}.html` : entry.realUrl;
  return `<a class="card" rel="noopener" target="_blank" href="${href}" title="${escapeHtml(entry.title)}">
    <div class="card-tags">
      <span class="card-source">${escapeHtml(entry.source || '')}</span>
      ${entry.section ? `<span class="card-section">${escapeHtml(entry.section)}</span>` : ''}
    </div>
    <h3 class="card-title">${escapeHtml(headlineOf(entry))}</h3>
    <time class="card-date" datetime="${isoDate}">${displayDate}</time>
  </a>`
}

// Every generated listing page lives at one of:
//   dist/index.html                (primary category, page 1)
//   dist/page/N.html               (primary category, page N>1)
//   dist/<slug>/index.html         (other category, page 1)
//   dist/<slug>/page/N.html        (other category, page N>1)
function categoryDir(slug) {
  return slug === PRIMARY_CATEGORY ? '' : `${slug}/`;
}

function pagePath(slug, pageNum) {
  const dir = categoryDir(slug);
  return pageNum === 1 ? `${dir}index.html` : `${dir}page/${pageNum}.html`;
}

function rootPrefixFor(slug, pageNum) {
  const depth = (slug === PRIMARY_CATEGORY ? 0 : 1) + (pageNum === 1 ? 0 : 1);
  return '../'.repeat(depth);
}

function pageHref(targetPage, currentSlug, currentPage) {
  return rootPrefixFor(currentSlug, currentPage) + pagePath(currentSlug, targetPage);
}

function paginationNav(pageNum, totalPages, slug) {
  if (totalPages <= 1) return '';
  const prev = pageNum > 1
    ? `<a class="page-link" href="${pageHref(pageNum - 1, slug, pageNum)}">&larr; Plus récent</a>`
    : `<span class="page-link is-disabled">&larr; Plus récent</span>`;
  const next = pageNum < totalPages
    ? `<a class="page-link" href="${pageHref(pageNum + 1, slug, pageNum)}">Plus ancien &rarr;</a>`
    : `<span class="page-link is-disabled">Plus ancien &rarr;</span>`;
  return `<nav class="pagination" aria-label="Pagination">
    ${prev}
    <span class="page-status">Page ${pageNum} / ${totalPages}</span>
    ${next}
  </nav>`;
}

function paginate(items) {
  const pages = [];
  for (let i = 0; i < items.length || i === 0; i += PAGE_SIZE) {
    pages.push(items.slice(i, i + PAGE_SIZE));
    if (items.length === 0) break;
  }
  return pages;
}

(async () => {
  const state = loadState();
  const resolvedSlugMap = new Map(state.resolved.map((r) => [r.url, r.slug]));
  const extracted = new Map(); // canonical fetch URL -> { title, byline, content, finalUrl, slug }
  const mergedItemsByCategory = {};

  for (const category of sources.categories) {
    const historyItems = (state.categories[category.slug] && state.categories[category.slug].items) || [];
    const historyByGuid = new Map(historyItems.filter((h) => h.slug).map((h) => [h.guid, h]));

    const feeds = await Promise.all(category.feeds.map((url) => parser.parseURL(url)));
    const allItems = feeds.flatMap((feed) => feed.items);

    // Split into items we've already processed in a previous run (reuse
    // as-is, no network calls) and genuinely new ones.
    const newItems = [];
    for (const item of allItems) {
      const existing = historyByGuid.get(item.guid);
      if (existing) {
        item.slug = existing.slug;
        item.realUrl = existing.realUrl;
        item.section = existing.section;
      } else {
        newItems.push(item);
      }
    }

    // Google News RSS links (news.google.com/rss/articles/...) are opaque
    // redirects that dead-end on an EU cookie-consent page when fetched
    // directly. Decoding them locally gets us the real publisher URL,
    // gaa_* tokens included (Google's "News Showcase" grant that unlocks
    // some paywalled articles for readers coming from Google News).
    //
    // NOTE: decoder.decodeBatch() sends all links in one grouped Google
    // batchexecute call and re-matches results by their position in the
    // response array, but Google does not guarantee that response order
    // matches request order for that endpoint — it silently mismatched
    // articles in practice. Decoding one link at a time, sequentially,
    // avoids that reordering bug entirely (each call is self-contained).
    for (const item of newItems) {
      const result = await decoder.decode(item.link);
      if (result && result.status) {
        item.realUrl = result.decoded_url;
      } else {
        console.warn(`Could not decode Google News link for "${item.title}": ${result && result.message}`);
        item.realUrl = item.link;
      }
    }

    await mapWithConcurrency(newItems, EXTRACTION_CONCURRENCY, async (item) => {
      try {
        const article = await extractArticle(item.realUrl);
        const slug = slugFor(item.realUrl);
        extracted.set(item.realUrl, { ...article, title: article.title || item.title, slug });
        resolvedSlugMap.set(item.realUrl, slug);
        item.slug = slug;
        item.section = article.section;
      } catch (err) {
        console.warn(`Fallback to direct link for "${item.title}": ${err.message}`);
        item.slug = null;
      }
    });

    // Merge this run's items into the persisted history: replace/add
    // entries by guid, keep everything else, sort newest-first, cap at
    // MAX_HISTORY. Items that fall off the cap keep their reader page on
    // disk (still reachable, just no longer listed) rather than being
    // deleted — deleting them could break "à lire aussi" links from
    // articles still in history.
    const processedByGuid = new Map(allItems.map((item) => [item.guid, {
      guid: item.guid,
      title: item.title,
      source: item.source,
      pubDate: item.pubDate,
      slug: item.slug,
      realUrl: item.realUrl,
      section: item.section,
    }]));
    mergedItemsByCategory[category.slug] = [...processedByGuid.values(), ...historyItems.filter((h) => !processedByGuid.has(h.guid))]
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, MAX_HISTORY);
  }

  // One extra pass across every category's freshly extracted articles:
  // follow same-site links (e.g. "à lire aussi") and give those a clean
  // reader page too, capped so a link-heavy article can't blow up the
  // build. resolvedSlugMap already carries past runs' resolutions, so this
  // also skips links we've resolved before, in any category.
  const linkCandidates = new Set();
  for (const article of extracted.values()) {
    const links = [...inArticleLinksOf(article.content, article.finalUrl)].slice(0, LINKS_PER_ARTICLE);
    for (const url of links) {
      if (linkCandidates.size >= MAX_LINKED_ARTICLES) break;
      if (!resolvedSlugMap.has(url)) linkCandidates.add(url);
    }
  }

  await mapWithConcurrency([...linkCandidates], EXTRACTION_CONCURRENCY, async (url) => {
    try {
      const article = await extractArticle(url);
      const slug = slugFor(url);
      extracted.set(url, { ...article, slug });
      resolvedSlugMap.set(url, slug);
    } catch {
      // Not every same-site link is an article (category pages, tag pages,
      // share links...) — silently leave those pointing at the original site.
    }
  });

  for (const article of extracted.values()) {
    const page = templates.article({
      title: article.title || 'Article',
      byline: article.byline,
      content: rewriteInArticleLinks(article.content, article.finalUrl, resolvedSlugMap),
      sourceUrl: article.finalUrl,
    });
    createFile(`${ARTICLES_DIR}/${article.slug}.html`, page);
  }

  const newState = {
    resolved: [...resolvedSlugMap].map(([url, slug]) => ({ url, slug })).slice(-MAX_RESOLVED),
    categories: Object.fromEntries(sources.categories.map((c) => [c.slug, { items: mergedItemsByCategory[c.slug] }])),
  };
  createFile(HISTORY_FILE, JSON.stringify(newState));

  for (const category of sources.categories) {
    const pages = paginate(mergedItemsByCategory[category.slug]);

    pages.forEach((pageItems, i) => {
      const pageNum = i + 1;
      const rootPrefix = rootPrefixFor(category.slug, pageNum);
      // Switching category always lands on its page 1 — href is relative
      // to *this* page, so it must use this page's own rootPrefix, not
      // page 1's (a page/2.html is one directory deeper than index.html).
      const switchLinks = sources.categories.map((c) => ({
        slug: c.slug,
        label: c.label,
        href: rootPrefix + pagePath(c.slug, 1),
      }));
      let body = `<section class="news-section">`;
        body += '<div class="news-grid">';
        body += pageItems.map((entry) => historyCardTemplate(entry, rootPrefix)).join('');
        body += '</div>';
      body += `</section>`;
      body += paginationNav(pageNum, pages.length, category.slug);

      const html = templates.document(body, { basePrefix: rootPrefix, switchLinks, activeCategory: category.slug });
      createFile(`./dist/${pagePath(category.slug, pageNum)}`, html);
    });
  }
})().catch((err) => {
  // Without this, a failure partway through (e.g. a feed fetch blocked on
  // CI) leaves whatever files were already written on disk, npm still exits
  // 0, and the deploy step happily publishes a half-built site.
  console.error('Build failed:', err);
  process.exitCode = 1;
});
