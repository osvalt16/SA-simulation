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
- `MINERAL_META` (categorie et rarete des minerais) est indexe PAR NOM, jamais par position : C4 fournit son propre ordre de `resourceNames`, issu des ids de cargo on-chain.
- Preferer du code lisible a une abstraction trop compliquee.

## Structure actuelle

- `index.html` : application principale (carte canvas, panneaux systemes, crafting, overlay marketplace, prix live). Tout est inline. La carte affichee est SAGE C4 (c4_data.json + direct on-chain) : c'est le jeu cible, destine au mainnet.
- `marketplace.html` : marketplace de guilde. Acces par code `SAGE-XXXX-XXXX` + wallet Phantom, donnees stockees sur jsonbin.io, offres en ATLAS.
- `scripts/fetch-prices.js` : lit le carnet d'ordres on-chain du Galactic Marketplace (programme `traderDnaR...`, ordres USDC uniquement) et ecrit `market_prices.json`. Lance par GitHub Action, necessite le secret `SOLANA_RPC` (le RPC public refuse `getProgramAccounts`).
- `.github/workflows/update-prices.yml` : met a jour `market_prices.json` toutes les 30 min (commit bot avec `[skip ci]`).
- `.github/workflows/update-ships.yml` : met a jour `ships_images.json` toutes les heures depuis `galaxy.staratlas.com/nfts`.
- `scripts/fetch-rentals.js` : lit les contrats de location de flottes SRSLY (`SRSLY1fq...`) on-chain SANS dependance npm (decodage manuel des comptes Anchor, layout documente en tete de fichier) et ecrit `rentals_data.json`. Le RPC public suffit.
- `.github/workflows/update-rentals.yml` : met a jour `rentals_data.json` toutes les 6 h.
- `scripts/fetch-c4.js` : produit le SNAPSHOT de secours et la base des corps celestes. Lit les systemes SAGE C4 sur le TESTNET z.ink (`https://testnet-rpc.z.ink`, programme `C4SAge...`) et ecrit `c4_data.json`. Decodage manuel d'apres l'IDL Codama de `@staratlas/dev-sage` (layout documente en tete de fichier).
- `.github/workflows/update-c4.yml` : met a jour `c4_data.json` toutes les 12 h.

Donnees JSON a la racine (chargees par `index.html` avec cache-busting `?v=DATA_VERSION`) :

- `map_data.json` : galaxie du jeu actuel. N'est PLUS AFFICHEE : elle sert de source des gisements et des planetes pour la carte C4 (appariement par position), car C4 ne publie pas encore ses ressources on-chain. Ne pas supprimer. Sert aussi de galaxie de secours si c4_data.json est injoignable.
- `graph_data.json` : plus utilise (le GPS a ete retire : ses itineraires reposaient sur le graphe du jeu actuel, sans equivalent publie on-chain pour C4). Conserve dans le depot au cas ou.
- `hulls_data.json` : contours des regions et regions neutres.
- `ships_data.json` : stats des vaisseaux.
- `ships_images.json` : images/thumbnails des vaisseaux (auto-genere, ne pas editer a la main).
- `crafts_starbase.json` : recettes de crafting starbase. PLUS UTILISE depuis le retrait de l'onglet Crafts (il n'est donc plus telecharge : 777 Ko economises). Conserve dans le depot si le crafting revient sur C4.
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

## Economie des claim stakes (bot en preparation)

- `scripts/fetch-c4-buildings.js` extrait du compte `game` on-chain : table des cargos (3640), definitions de claim stakes (5 tiers : 65 / 487 / 2049 / 6251 / 15553 slots) et 870 batiments dont 189 extracteurs et 97 sources d'energie. Tout est localise par MOTIF, jamais par offset fixe.
- Les multiplicateurs de loyer et de frais de placement des claim stakes valent tous 1.0 (virgule fixe 2^56) : le tarif de base est porte par la starbase, pas par la definition.
- `scripts/c4-optimizer.js` classe les 3901 corps celestes et produit un plan de construction (hub central + extracteurs) sous contrainte de slots et de bilan energetique.
- `fetch-prices.js` capte les DEUX devises : les vaisseaux et structures se negocient surtout en USDC, les ressources brutes en ATLAS. Attention aux decimales : 6 pour l'USDC, 8 pour l'ATLAS. Les deux carnets restent separes (`sellers`/`buyers` pour l'USDC, `sellersAtlas`/`buyersAtlas` pour l'ATLAS) : melanger des prix de devises differentes dans une meme liste triee n'aurait aucun sens.
- LIMITE RESTANTE : seuls 12 des 93 gisements de C4 ont un prix. Les 81 autres sont nouveaux et absents du catalogue officiel, sur tous les marches. Pour eux, `--mode volume` classe au volume extrait.

## Decisions techniques importantes

- Le projet doit rester compatible GitHub Pages : pas de backend, pas de build.
- Les donnees live sont mises a jour par GitHub Actions qui committent dans le depot ; le site les lit en meme origine (pas de CORS).
- Seuls les ordres en USDC sont gardes pour les prix marketplace.
- Le marketplace de guilde repose sur jsonbin.io faute de backend : lecture/ecriture du JSON complet, donc risque d'ecrasement si deux ecritures simultanees. A garder en tete avant d'ajouter des fonctionnalites d'ecriture frequente.
- La carte C4 est en DIRECT par PUSH : le navigateur s'abonne en WebSocket (`wss://testnet-rpc.z.ink`, non documente mais fonctionnel) via `programSubscribe` filtre sur les comptes StarSystem ; la chaine pousse les changements des leur survenue. Le sondage n'est pas supprime : il passe a 5 minutes tant que le push repond et revient a 60 s des que la connexion tombe (une coupure silencieuse figerait la carte en laissant croire qu'elle est a jour). Reconnexion automatique avec attente croissante plafonnee a 60 s. Trafic : ~25 Ko/h en push contre ~9,4 Mo/h en sondage seul.
- Repli sondage : le navigateur relit la chaine z.ink toutes les 60 s (CORS ouvert sur `testnet-rpc.z.ink`). Pour eviter de retelecharger les 2,75 Mo de comptes StarSystem, on ne relit que les 3 octets qui changent (option starbase + faction + niveau) : `fetch-c4.js` publie par systeme son adresse `pk` et l'offset `so` de ce champ, le navigateur regroupe les systemes par offset identique (26 groupes) et interroge `getMultipleAccounts` + `dataSlice`, par lots de 8 requetes JSON-RPC (au-dela le RPC renvoie 413). Cout : ~157 Ko par rafraichissement, soit 17x moins. Si le RPC est injoignable, la carte reste affichee avec les donnees du snapshot et l'indicateur passe en rouge.
- `c4_data.json` reste le filet de securite (affichage instantane, corps celestes, historique long) : ne pas retirer le workflow.
- C4 rejoue la MEME galaxie que SAGE actuel : les 945 systemes s'apparient 1:1 par position au facteur `C4_K = 72.05777674976633` pres, et le nombre de corps celestes est identique. `c4ToMap()` convertit donc c4_data.json au format de map_data.json, ce qui permet de reutiliser tout le moteur de rendu, de zoom et de panneaux sans le dupliquer. En C4, les gisements sont LUS ON-CHAIN : chaque compte CelestialBody porte sa liste de gisements (cargoId + richesse en virgule fixe 48 bits ; quantite minable en plus pour les asteroides), et le compte `game` (~2,7 Mo) contient la table officielle des cargos (entrees de 126 octets : id + nom + mint) qui donne les noms. Les 3901 corps ne se partagent que 239 ensembles de gisements distincts : ils sont factorises en palettes (`resSets`) pour tenir dans 317 Ko. Du jeu actuel ne subsistent que l'orbite, l'angle et la taille des planetes, utilises pour le rendu de la vue systeme.
- Transition SAGE C4 / z.ink en preparation : le mainnet C4 est attendu fin 2026 et remplacera Starbased (dont les donnees actuelles du site deviendront obsoletes). L'overlay C4 lit deja le testnet ; au mainnet il faudra re-verifier le program ID et l'IDL de `@staratlas/dev-sage`, puis basculer la carte principale.
- Toute dependance externe doit etre justifiee dans la PR.
