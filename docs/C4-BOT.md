# SAGE C4 — dossier technique pour le bot claim stakes

Tout ce qui suit a ete lu **directement sur la chaine** (testnet z.ink,
programme `C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF`) ou dans l'IDL de
`@staratlas/dev-sage`. Chaque chiffre est verifiable avec les scripts du depot.

Ce document sert de reference pour construire un bot autonome. Il distingue
clairement **ce qui est etabli** de **ce qui reste a verifier**.

---

## 1. Reseau et acces

| Element | Valeur |
| --- | --- |
| RPC | `https://testnet-rpc.z.ink` (CORS ouvert) |
| WebSocket | `wss://testnet-rpc.z.ink` (non documente, mais fonctionnel) |
| Programme SAGE C4 | `C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF` |
| Compte `game` | `EKEj47SzaCjPM3m4T4vRXrrsVtkEmiNgPMMFye3AkXj4` (~2,7 Mo) |
| Mainnet | **non publie** — la doc interdit de le deviner par convention de nommage |

Limites du RPC mesurees : un lot JSON-RPC de plus de 8 requetes de 100 cles
renvoie `413`. Un `getProgramAccounts` complet sur les systemes = 2,75 Mo.

---

## 2. Sequence d'actions pour un cycle complet

C'est le coeur de l'autonomie. Les instructions existent, leurs arguments et
leurs comptes sont connus.

### 2.1 Poser une claim stake

```
placeClaimStakeInstanceWithHub
  arguments : keyIndex, claimStakeDefinitionId, hubBuildingId, initialRentAmount
  comptes   : 13 (game, validation de profil x4, profileFaction,
                  claimStakeInstance, system, starbasePlayer, ...)
```

La stake et son hub central sont poses **en une seule transaction**. Il faut
donc avoir choisi le tier ET le hub avant d'agir.

### 2.2 Construire les extracteurs

```
placeClaimStakeBuildings
  arguments : keyIndex, sequenceId, buildingChanges
```

`buildingChanges` permet d'ajouter ou retirer plusieurs batiments d'un coup :
une seule transaction suffit pour tout le plan produit par l'optimiseur.

### 2.3 Faire tourner la production

```
claimStakesResourceProduction
  arguments : AUCUN
  comptes   : funder, profile, claimStakeInstance, celestialBody, ...
```

**Point important : aucun `keyIndex`.** Cette instruction est une manivelle
publique — n'importe qui peut la declencher, y compris pour la stake d'un
autre joueur. Le bot peut donc faire avancer la production sans permission
particuliere, en ne payant que les frais de transaction.

Meme logique pour `payClaimStakesRent`.

### 2.4 Logistique par vaisseau

```
startClaimStakesFleetTransfer   (keyIndex, toLoad, toUnload)
exitClaimStakesFleetTransfer    (aucun argument)
recoverClaimStakesFleetTransfer (keyIndex)   -> si le transfert s'interrompt
forceExitClaimStakesFleetTransfer            -> sortie de secours
```

C'est la boucle « charger dans le vaisseau, aller deposer, recuperer la
production ». Le transfert est un etat : il faut le terminer par `exit`,
sinon la flotte reste bloquee. Le bot doit donc gerer la reprise
(`recover` / `forceExit`) apres un plantage.

### 2.5 Entretien et fin de vie

```
claimStakesRentTopUp (keyIndex, amount)      -> recharger le loyer
deconstructClaimStakeInstance                -> demonter
respawnClaimStakeInstance / completeClaimStakeRespawn
evictClaimStakeInstance                      -> expulsion si loyer epuise
```

---

## 3. Modele economique

### 3.1 Claim stakes

| Tier | Slots |
| --- | --- |
| 1 | 65 |
| 2 | 487 |
| 3 | 2 049 |
| 4 | 6 251 |
| 5 | 15 553 |

Les objets a poser sont des cargos : `Claim Stake Tier 1` = cargoId 12700,
puis 12701 a 12704. Ils occupent 256 de cout de stockage chacun — a prendre
en compte dans la capacite du vaisseau transporteur.

`rentMultiplier` et `placementFeeMultiplier` valent **1.0** pour tous les
tiers (virgule fixe 2^56).

### 3.2 Batiments

870 batiments decodes, dont **189 extracteurs** et **97 sources d'energie**.

| Batiment | Slots | Energie | Effet |
| --- | --- | --- | --- |
| Asteroid Central Hub Tier 1 | 33 | +100 | obligatoire, consomme 10 Fuel |
| Extracteur Tier 1 (type courant) | 8 | −25 | extrait ~20 unites |
| Asteroid Extraction Hub Tier 1 | 4 | +50 | energie d'appoint |

Consequence directe : **une stake T1 est saturee a 4 extracteurs**
(33 + 4×8 = 65 slots, bilan energie exactement 0). Le hub mange la moitie
des slots — c'est pourquoi le passage en T2 change l'echelle.

Chaque extracteur est **specifique a une ressource** (« Magmaroot Extractor »,
« Aluminum Ore Extractor »...). Le choix du gisement determine le batiment.

### 3.3 Couts (lus sur la PLANETE)

`baseClaimStakeRentRate` et `baseClaimStakePlacementFee` sont des tableaux
`[7][5]` (7 categories x 5 tiers) places juste apres l'en-tete du compte
`CelestialBody`, avant la liste des gisements.

- Loyer : `2^32` en virgule fixe = **1.0**, soit ~0,00086 ATLAS/jour
- Frais de placement : **1 ATLAS**, une seule fois

**Ces valeurs sont identiques sur les 76 290 cases relevees.** Ce sont des
marqueurs : l'equilibrage economique n'est pas fait. Aujourd'hui les couts ne
differencient donc aucun emplacement. A re-verifier a chaque phase du PTR.

Les claim stakes en activite portent un solde de loyer d'environ 50 ATLAS.

### 3.4 Gisements

Chaque `CelestialBody` porte sa liste de gisements : `cargoId` + richesse en
virgule fixe 48 bits. La richesse est **uniforme sur un meme corps** (verifie
sur les 3 901 corps) et va de 1.0 a 4.6.

Les asteroides portent en plus une **quantite minable** par gisement, qui
evolue en direct (6 changements observes en 80 s sur 49 723 entrees).

Les noms viennent de la table des cargos du compte `game` : entrees de
126 octets `{ id u16, name[64], mint[32], ... }`, localisee par motif.

---

## 4. Prix

C4 a **son propre marche** : 56 comptes `localMarket` actifs, chacun
rattache a un systeme et une starbase, pour un seul type de cargo, avec un
carnet `bids` / `asks`.

C'est la bonne source de prix pour C4 — et la seule qui couvre les
**81 gisements sur 93 absents de tous les catalogues existants**.

En attendant leur decodage, l'optimiseur utilise les prix du jeu actuel
(`market_prices.json`), qui ne couvrent que 12 ressources, en ATLAS
(8 decimales — l'USDC en a 6, s'y tromper fausse tout d'un facteur 100).

---

## 5. Leviers d'optimisation

Par ordre d'impact estime :

1. **Emplacement** — la richesse va de 1.0 a 4.6, soit un facteur 4,6 sur la
   production a materiel identique. C'est de loin le levier principal.
2. **Choix du gisement** — a richesse egale, l'ecart de prix entre ressources
   depasse le facteur 7 (Diamond a 0,0021 contre Hydrogen a 0,00029 ATLAS).
   L'optimiseur classe par valeur par slot, pas par volume.
3. **Remplissage des slots** — viser 0 slot perdu et un bilan energie a 0.
   Le plan optimal en T1 : 1 hub + 4 extracteurs, exactement 65 slots.
4. **Tier** — le hub coute 33 slots quel que soit le tier : plus le tier est
   haut, plus ce cout fixe est dilue.
5. **Disponibilite des parcelles** — `claimStakePlots` vaut 10 000 ou 0 selon
   la categorie et le tier. Un 0 signifie qu'on ne peut pas poser ce tier
   sur cette categorie de corps. **A verifier avant toute transaction.**
6. **Manivelles publiques** — `claimStakesResourceProduction` sans permission
   permet de declencher la production a volonte.

---

## 6. Ce qui reste a faire

- [ ] Decoder les carnets `bids` / `asks` des 56 `localMarket` -> vrais prix C4
- [ ] Decoder `claimedPlots` sur la planete -> parcelles reellement libres
- [ ] Lire l'inventaire du joueur (`starbasePlayer`, pods de cargo)
- [ ] Extraire capacite, vitesse et carburant des vaisseaux transporteurs
- [ ] Encoder les instructions Anchor et assembler les comptes
- [ ] Gerer la reprise apres interruption d'un transfert de flotte

## 7. Securite

- Le bot doit tourner **chez toi**, jamais dans le navigateur : une page web
  ne tourne pas 24h/24 et ne doit pas detenir de cle.
- Utiliser une **cle deleguee** ajoutee au profil de joueur, avec les seules
  permissions de jeu (`DO_MINING`, `MOVE_FLEET`, `DOCK`, `UNDOCK`,
  `ADD_REMOVE_CARGO`, `DO_CRAFTING`...) et **sans droit de retrait**, avec
  une date d'expiration. C'est le mecanisme prevu par le jeu.
- Une cle SVM donne la meme adresse sur z.ink et sur Solana mainnet.
