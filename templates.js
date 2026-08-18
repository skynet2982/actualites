module.exports.document = function (body, { basePrefix = './', switchLinks = [], activeCategory } = {}) {
  const switchHtml = switchLinks.length > 1 ? `<div class="category-switch">
    ${switchLinks.map((l) => `<a class="category-btn${l.slug === activeCategory ? ' is-active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
  </div>` : '';
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Extrait de Google Actualités">
    <link rel="shortcut icon" type="image/x-icon" href="https://cdn-icons-png.flaticon.com/512/2537/2537856.png">
    <title>Actualités</title>
    <link type="text/css" rel="stylesheet" href="${basePrefix}styles.css" media="all">
  </head>
  <body>
    <main>
      <header class="bg-dark mb-4">
        <nav class="container navbar navbar-dark">
        <div class="container-fluid">
          <a href="${basePrefix}index.html"><h1 class="text-light h2 mb-0">Actualités</h1></a>
        </div>
        </nav>
      </header>
      <div class="container mb-3">
        <div class="row mb-3">
          <div class="col">
            <strong>Dernière mise à jour</strong>: ${new Date().toLocaleString("fr-FR", {timeZone: "Europe/Paris"})}
          </div>
        </div>
        <div class="util-actions mb-3">
          <button type="button" class="util-btn" id="refresh-btn" title="Rafraîchir la page" aria-label="Rafraîchir la page">🔄</button>
          <button type="button" class="util-btn" id="qr-btn" title="Afficher le QR code du site" aria-label="Afficher le QR code du site">📱</button>
        </div>
        ${switchHtml}
        ${body}
      </div>
      <div class="qr-overlay" id="qr-overlay" hidden>
        <div class="qr-modal">
          <button type="button" class="qr-close" id="qr-close" aria-label="Fermer">✕</button>
          <div id="qr-code"></div>
          <p class="qr-url" id="qr-url"></p>
        </div>
      </div>
    </main>
    <script src="${basePrefix}qrcode.min.js"></script>
    <script>
      document.getElementById('refresh-btn').addEventListener('click', function () {
        location.reload();
      });
      (function () {
        var overlay = document.getElementById('qr-overlay');
        var rendered = false;
        document.getElementById('qr-btn').addEventListener('click', function () {
          if (!rendered) {
            var siteUrl = new URL('${basePrefix}', location.href).href.replace(/index\\.html$/, '');
            var qr = qrcode(0, 'M');
            qr.addData(siteUrl);
            qr.make();
            document.getElementById('qr-code').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4 });
            document.getElementById('qr-url').textContent = siteUrl;
            rendered = true;
          }
          overlay.hidden = false;
        });
        document.getElementById('qr-close').addEventListener('click', function () {
          overlay.hidden = true;
        });
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) overlay.hidden = true;
        });
      })();
    </script>
  </body>
  </html>`;
}

module.exports.article = function ({ title, byline, content, sourceUrl }) {
  return `<!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} — Actualités</title>
    <link type="text/css" rel="stylesheet" href="../styles.css" media="all">
  </head>
  <body>
    <main class="container mb-3" style="max-width: 700px;">
      <p style="margin-top: 1rem;"><a href="../index.html">&larr; Retour aux actualités</a></p>
      <article>
        <h1>${title}</h1>
        ${byline ? `<p style="color: var(--bs-gray-600, #6c757d);">${byline}</p>` : ''}
        <p class="small"><a rel="noopener" target="_blank" href="${sourceUrl}">Voir l'article original</a></p>
        <hr>
        <div class="article-content">${content}</div>
      </article>
    </main>
  </body>
  </html>`;
}
