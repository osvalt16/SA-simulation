# Contexte de developpement - SAGE C4

Ce fichier sert de reference rapide pour les devs du projet. Il doit rester simple, concret et a jour.

## Objectif du projet

SAGE C4 est un site statique (GitHub Pages) autour de Star Atlas / SAGE :

- une carte galactique interactive (systemes, planetes, regions, factions, ressources) ;
- un simulateur de crafting starbase (arbres de recettes, mineraux, temps) ;
- un affichage des prix live du Galactic Marketplace (carnet d'ordres on-chain) ;
- un marketplace prive de guilde (`marketplace.html`) avec acces par code et wallet Phantom.

Priorite actuelle : fiabiliser les donnees live (prix, vaisseaux) et l'experience marketplace sans backend dedie.

## Regles de code

- Le site reste 100 % statique : HTML, CSS et JS simples, sans build ni framework.
- `index.html` est une application monofichier : CSS et JS sont inline. C'est un choix assume, ne pas eclater en modules sans decision explicite.
- Toute nouvelle fonction exposee aux handlers HTML (`onclick`, etc.) doit etre attachee a `window.xxx = xxx`.
- Ne jamais referencer une variable globale potentiellement absente directement : passer par `window.xxx || valeurParDefaut` (cf. bug `BIOME_MINERALS`).
- Pas de variables globales implicites : toujours `let` / `const` / `var`.
- Tout texte saisi par un utilisateur (note d'offre, pseudo...) doit passer par `esc()` avant insertion via `innerHTML` (anti-XSS).
- Ne pas dupliquer une fonction utilitaire : chercher si elle existe deja (ex. `fmtTime`).
- Les commentaires expliquent les choix non evidents, pas le code lui-meme.
- Preferer du code lisible a une abstraction trop compliquee.

## Structure actuelle

- `index.html` : application principale (carte canvas, panneaux systemes, crafting, overlay marketplace, prix live). Tout est inline.
- `marketplace.html` : marketplace de guilde. Acces par code `SAGE-XXXX-XXXX` + wallet Phantom, donnees stockees sur jsonbin.io, offres en ATLAS.
- `scripts/fetch-prices.js` : lit le carnet d'ordres on-chain du Galactic Marketplace (programme `traderDnaR...`, ordres USDC uniquement) et ecrit `market_prices.json`. Lance par GitHub Action, necessite le secret `SOLANA_RPC` (le RPC public refuse `getProgramAccounts`).
- `.github/workflows/update-prices.yml` : met a jour `market_prices.json` toutes les 30 min (commit bot avec `[skip ci]`).
- `.github/workflows/update-ships.yml` : met a jour `ships_images.json` toutes les heures depuis `galaxy.staratlas.com/nfts`.
- `scripts/fetch-rentals.js` : lit les contrats de location de flottes SRSLY (`SRSLY1fq...`) on-chain SANS dependance npm (decodage manuel des comptes Anchor, layout documente en tete de fichier) et ecrit `rentals_data.json`. Le RPC public suffit.
- `.github/workflows/update-rentals.yml` : met a jour `rentals_data.json` toutes les 6 h.
- `scripts/fetch-c4.js` : lit les systemes SAGE C4 sur le TESTNET z.ink (`https://testnet-rpc.z.ink`, programme `C4SAge...`) et ecrit `c4_data.json`. Decodage manuel d'apres l'IDL Codama de `@staratlas/dev-sage` (layout documente en tete de fichier).
- `.github/workflows/update-c4.yml` : met a jour `c4_data.json` toutes les 12 h.

Donnees JSON a la racine (chargees par `index.html` avec cache-busting `?v=DATA_VERSION`) :

- `map_data.json` : systemes, planetes, ressources, coordonnees.
- `graph_data.json` : aretes du graphe (warp lanes) pour le GPS.
- `hulls_data.json` : contours des regions et regions neutres.
- `ships_data.json` : stats des vaisseaux.
- `ships_images.json` : images/thumbnails des vaisseaux (auto-genere, ne pas editer a la main).
- `crafts_starbase.json` : recettes de crafting starbase.
- `market_prices.json` : top 8 vendeurs/acheteurs par objet (auto-genere, ne pas editer a la main).
- `price_history.json` : historique ~7 jours du meilleur ask/bid par objet, alimente par `fetch-prices.js` a chaque run (auto-genere). Charge en lazy par les sparklines du detail marketplace.
- `rentals_data.json` : contrats de location de flottes SRSLY (auto-genere). Charge en lazy par l'overlay Locations.
- `c4_data.json` : systemes stellaires SAGE C4 du testnet z.ink, avec corps celestes (planetes/asteroides) et journal des changements de starbase/faction entre deux runs (auto-genere). Charge en lazy par l'overlay C4 PTR.

Dependance externe assumee : l'API publique CoinGecko pour le ticker ATLAS/POLIS et les conversions USD (silencieux si indisponible).

## Donnees et securite

- Ne jamais commit de secret exploitable : le secret `SOLANA_RPC` reste dans les secrets GitHub Actions.
- Limite connue : la cle jsonbin.io de `marketplace.html` est visible cote client. N'y stocker AUCUNE donnee sensible (uniquement codes d'acces, wallets publics et offres).
- Limite connue : le controle admin par wallet est purement cote client. C'est du confort d'interface, pas de la securite.
- Les fichiers auto-generes (`market_prices.json`, `ships_images.json`) sont commits par les bots : ne pas les modifier a la main, corriger le script ou le workflow a la place.
- Tout nouveau workflow qui push doit declarer `permissions: contents: write` et un groupe `concurrency`.

## Workflow Git

- Travailler sur une branche par sujet.
- Faire des commits petits, lisibles et testables.
- Un commit = une intention claire.
- Ne pas melanger refactor, fix bug et nouvelle feature dans le meme commit.
- Avant commit : charger la page, verifier la console navigateur, tester le mode concerne (carte, crafting, marketplace).
- Les commits automatiques des bots utilisent `[skip ci]` pour eviter les boucles.

## Format des commits

Utiliser un format simple inspire de Conventional Commits :

```text
type(scope): resume court

Details utiles si necessaire :
- ce qui a change
- pourquoi
- comment tester
```

Types recommandes : `feat`, `fix`, `refactor`, `style`, `docs`, `test`, `chore`.

Scopes utiles : `map`, `craft`, `marketplace`, `prices`, `ci`, `data`, `context`.

Exemples :

```text
fix(map): corrige le filtre par biome des mineraux

- BIOME_MINERALS n'existait pas et cassait le filtre
- test manuel : panneau mineraux, changer de biome
```

```text
feat(prices): affiche le spread achat/vente dans le detail objet
```

## Pull requests et relecture

- Decrire le probleme resolu.
- Lister les fichiers importants modifies.
- Ajouter les tests manuels faits.
- Signaler clairement ce qui reste fragile ou incomplet.
- Ne pas valider une PR qui casse le chargement de la carte, le GPS, le crafting ou l'acces au marketplace.

## Tests manuels minimum

Pour une modification carte / UI :

- Charger la page, verifier la console (aucune erreur).
- Zoomer, deplacer, cliquer un systeme, ouvrir le panneau.
- Verifier desktop et mobile (tactile : pinch zoom, drag).

Pour une modification crafting :

- Ouvrir un craft, verifier l'arbre de recettes et les temps.
- Epingle/desepingle des mineraux, verifier la carte.

Pour une modification marketplace :

- Tester l'entree par code et la reconnexion wallet.
- Publier une offre, la voir dans "mes offres", la retirer.
- Verifier le rendu d'une note contenant `<b>test</b>` (doit s'afficher en texte brut).

Pour une modification prix / workflows :

- Lancer le workflow en manuel (`workflow_dispatch`) et verifier le JSON produit.
- Verifier que `index.html` affiche bien les nouveaux prix (cache-busting).

## Decisions techniques importantes

- Le projet doit rester compatible GitHub Pages : pas de backend, pas de build.
- Les donnees live sont mises a jour par GitHub Actions qui committent dans le depot ; le site les lit en meme origine (pas de CORS).
- Seuls les ordres en USDC sont gardes pour les prix marketplace.
- Le marketplace de guilde repose sur jsonbin.io faute de backend : lecture/ecriture du JSON complet, donc risque d'ecrasement si deux ecritures simultanees. A garder en tete avant d'ajouter des fonctionnalites d'ecriture frequente.
- Transition SAGE C4 / z.ink en preparation : le mainnet C4 est attendu fin 2026 et remplacera Starbased (dont les donnees actuelles du site deviendront obsoletes). L'overlay C4 lit deja le testnet ; au mainnet il faudra re-verifier le program ID et l'IDL de `@staratlas/dev-sage`, puis basculer la carte principale.
- Toute dependance externe doit etre justifiee dans la PR.
