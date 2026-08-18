# Actualités

Site statique qui compile les actualités de plusieurs villes/régions
françaises à partir des flux RSS de Google Actualités, résout chaque lien
vers l'éditeur d'origine, puis en extrait une version de lecture propre et
sans pub (à la Reader Mode de Firefox) — pas de pub, pas de tracker, pas de
boucle de redirection payante.

**En ligne :** https://skynet2982.github.io/actualites/

<img src="qrcode.png" alt="QR code vers le site" width="180">

## Fonctionnement

Le site se reconstruit tout seul toutes les 30 minutes via GitHub Actions
(voir [`build.yml`](.github/workflows/build.yml)) et se déploie sur la
branche `gh-pages`.

- **Récupération** — chaque catégorie de [`sources.json`](sources.json)
  liste un ou plusieurs flux RSS Google Actualités ; tous sont récupérés et
  fusionnés.
- **Décodage** — les liens RSS de Google Actualités sont des redirections
  opaques (`news.google.com/rss/articles/...`) ; chacun est résolu vers
  l'URL réelle de l'éditeur (`google-news-url-decoder`), un par un et de
  façon séquentielle, ce qui évite un bug de réordonnancement des réponses
  sur l'endpoint de décodage par lot de Google.
- **Extraction** — la page réelle de l'article est récupérée puis passée
  dans [Readability](https://github.com/mozilla/readability) pour en retirer
  pubs/menus/etc., puis assainie avec DOMPurify (jusqu'à 8 extractions en
  parallèle). Si la page source porte aussi un `articleSection` schema.org
  (JSON-LD) ou une balise `<meta property="article:section">`, ça devient une
  étiquette de thème visible sur la carte de l'article (ex. « Faits divers »,
  « Politique »).
- **Liens « à lire aussi »** — les liens internes au même site trouvés dans
  un article extrait reçoivent eux aussi une page de lecture propre (plafonné
  par article et par build), pour éviter de renvoyer le lecteur vers le site
  d'origine bourré de pubs.
- **Rendu** — les pages HTML sont générées par catégorie, paginées à 20
  articles par page, avec jusqu'à 200 articles conservés dans un historique
  persistant par catégorie (`dist/history.json`) — un article reste donc
  accessible d'un build à l'autre même une fois poussé hors de la page
  d'accueil par les suivants.
- **Deux boutons utilitaires** sous la date de dernière mise à jour :
  🔄 recharge la page (pratique en PWA, sans avoir à quitter l'appli), et
  📱 affiche un QR code du site (toujours le lien principal, pas la page ou
  l'article en cours) via `dist/qrcode.min.js`, une lib vendorisée (MIT,
  kazuhikoarase/qrcode-generator) générée entièrement côté client, sans
  requête réseau ni service tiers.

## Catégories

Les catégories vivent dans [`sources.json`](sources.json). La **première
entrée est la page d'accueil** (`dist/index.html`, actuellement « France ») ;
chaque autre catégorie a son propre sous-dossier (`dist/<slug>/`). L'ordre
dans le fichier fixe aussi l'ordre des boutons du sélecteur de catégorie en
haut du site.

Pour ajouter une ville, ajoute une entrée avec un flux RSS Google Actualités
pour elle — soit un flux « topic » de lieu (va sur Google Actualités,
navigue jusqu'au lieu, copie l'URL de type RSS), soit un simple flux de
recherche :

```json
{
  "slug": "bordeaux",
  "label": "Bordeaux",
  "feeds": ["https://news.google.com/rss/search?q=Bordeaux&hl=fr&gl=FR&ceid=FR:fr"]
}
```

## Structure

- `sources.json` — les catégories et leurs flux RSS.
- `index.js` — tout le pipeline de build (récupération → décodage →
  extraction → rendu).
- `templates.js` — les gabarits HTML (page de liste, page de lecture d'un
  article).
- `dist/styles.css`, `dist/qrcode.min.js` — les seuls fichiers versionnés
  sous `dist/` ; tout le reste y est généré à chaque build et ignoré par git.

## Développement local

```bash
npm install
npm run build   # génère dist/
```

Ouvre `dist/index.html` (ou sers le dossier `dist/`) pour prévisualiser en
local. `dist/history.json` et `dist/articles/` persistent l'état entre les
builds — le workflow GitHub Actions les restaure depuis la branche
`gh-pages` déployée avant chaque run, pour que l'historique survive aux
checkouts propres.

## Licence

MIT — voir [LICENSE](LICENSE).
