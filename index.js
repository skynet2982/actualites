const fs = require('fs');
const crypto = require('crypto');
let Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const createDOMPurify = require('dompurify');
const { GoogleDecoder } = require('google-news-url-decoder');
const templates = require('./templates.js');
let parser = new Parser();
let decoder = new GoogleDecoder();
const sources = JSON.parse(fs.readFileSync('sources.json'));

const ARTICLES_DIR = './dist/articles';
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

// Builds a local, decluttered reader page for the item. Falls back to
// linking the resolved article directly (soft paywalls, bot-blocked sites,
// fetch timeouts) so a single failing source never breaks the whole build.
async function buildArticlePage(item) {
  const slug = slugFor(item.realUrl);
  try {
    const article = await extractArticle(item.realUrl);
    const page = templates.article({
      title: article.title || item.title,
      byline: article.byline,
      content: article.content,
      sourceUrl: article.finalUrl,
    });
    createFile(`${ARTICLES_DIR}/${slug}.html`, page);
    item.readerHref = `./articles/${slug}.html`;
  } catch (err) {
    console.warn(`Fallback to direct link for "${item.title}": ${err.message}`);
    item.readerHref = item.realUrl;
  }
}

function itemTemplate(item) {
  const dateStr = new Date(item.pubDate).toLocaleString("fr-FR", {timeZone: "Europe/Paris"});
  return `<li class="mb-1">
    <a rel="noopener" target="_blank" href="${item.readerHref}" title="${item.title}">${item.title}</a>
    <time datetime="${dateStr}" class="ps-2 small">${dateStr}</time>
  </li>`
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

  await Promise.all(allItems.map(buildArticlePage));

  let output = ``;

  feeds.forEach((feed) => {
    output += `<section class="row">`;
      output += `<div class="col">`;
        output += `<h2 class="h3">${feed.title}</h2>`;
        output += '<ul class="mb-4">';
        output += feed.items.map(itemTemplate).join('');
        output += '</ul>';
      output += `</div>`;
    output += `</section>`;
  });

  output = templates.document(output);

  createFile('./dist/index.html', output);
})();
