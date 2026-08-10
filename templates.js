module.exports.document = function (body, { basePrefix = './' } = {}) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Extrait de la section Toulouse de Google Actualités">
    <link rel="shortcut icon" type="image/x-icon" href="https://cdn-icons-png.flaticon.com/512/2537/2537856.png">
    <title>Actualités Toulouse</title>
    <link type="text/css" rel="stylesheet" href="${basePrefix}styles.css" media="all">
  </head>
  <body>
    <main>
      <header class="bg-dark mb-4">
        <nav class="container navbar navbar-dark">
        <div class="container-fluid">
          <a href="${basePrefix}index.html"><h1 class="text-light h2 mb-0">Actualités Toulouse</h1></a>
        </div>
        </nav>
      </header>
      <div class="container mb-3">
        <div class="row mb-3">
          <div class="col">
            <strong>Dernière mise à jour</strong>: ${new Date().toLocaleString("fr-FR", {timeZone: "Europe/Paris"})}
          </div>
        </div>
        ${body}
      </div>
    </main>
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
    <title>${title} — Actualités Toulouse</title>
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
