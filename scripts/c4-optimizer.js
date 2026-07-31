// scripts/c4-optimizer.js
// Cerveau du bot claim stakes : classe les emplacements possibles par valeur
// produite, a partir de donnees reelles.
//
// Entrees (toutes deja produites par le depot) :
//   c4_data.json      gisements et richesse de chaque corps, lus on-chain
//   c4_buildings.json catalogue des claim stakes et batiments, lu on-chain
//   market_prices.json carnet d'ordres du Galactic Marketplace
//
// Modele : une claim stake offre N slots. On y pose un hub central
// (obligatoire, fournit l'energie de base), puis on remplit les slots
// restants d'extracteurs, sous deux contraintes : slots et bilan energetique
// positif. On choisit les extracteurs qui rapportent le plus.
//
// HYPOTHESES, a garder en tete avant d'y croire :
//  - la richesse du corps multiplie le taux d'extraction (non confirme
//    on-chain ; c'est le comportement des versions precedentes du jeu) ;
//  - les prix viennent du marche du jeu ACTUEL, faute de marche sur le PTR ;
//  - loyer et frais de placement ne sont pas deduits : leurs multiplicateurs
//    valent 1.0 mais le tarif de base est porte par la starbase, variable ;
//  - on valorise au meilleur prix ACHETEUR (ce qu'on encaisse tout de suite),
//    ce qui est plus prudent que le prix vendeur.
//
// Usage :
//   node scripts/c4-optimizer.js [--tier N] [--top N] [--resource "Nom"]

const fs = require("fs");

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TIER = parseInt(argv("--tier", "1"), 10);
const TOP = parseInt(argv("--top", "15"), 10);
const ONLY = argv("--resource", null);
const MODE = argv("--mode", "value");   // "value" = prix marche, "volume" = unites extraites
const PRICE_UNKNOWN = MODE === "volume" ? 1 : 0;  // en mode valeur, une ressource non cotee vaut 0

const c4 = JSON.parse(fs.readFileSync("c4_data.json", "utf8"));
const cat = JSON.parse(fs.readFileSync("c4_buildings.json", "utf8"));
let prices = {};
try { prices = JSON.parse(fs.readFileSync("market_prices.json", "utf8")).prices || {}; } catch (e) {}

// ── prix : meilleur ordre d'achat par symbole, rattache au nom de ressource ──
// market_prices.json est indexe par symbole ; on rapproche par nom via le
// catalogue des NFT quand c'est possible, sinon la ressource est ignoree.
const priceByName = {};
for (const sym in prices) {
  const p = prices[sym];
  const bid = (p.buyers && p.buyers.length) ? p.buyers[0].p : null;
  const ask = (p.sellers && p.sellers.length) ? p.sellers[0].p : null;
  priceByName[sym.toUpperCase()] = { bid: bid, ask: ask };
}
// Correspondance nom de ressource -> symbole du marche, issue du catalogue
// officiel (galaxy.staratlas.com/nfts), enregistre dans res_symbols.json.
// ATTENTION : seule une minorite des gisements de C4 est cotee aujourd'hui.
// Les autres sont nouveaux et n'ont aucun prix de reference.
let SYMBOLS = {};
try { SYMBOLS = JSON.parse(fs.readFileSync("res_symbols.json", "utf8")); } catch (e) {}
function priceOf(name) {
  const sym = SYMBOLS[name];
  if (sym && priceByName[sym]) return priceByName[sym];
  const direct = priceByName[name.replace(/\s+/g, "").toUpperCase()];
  return direct || null;
}

// ── catalogue ──
const stake = cat.claimStakes.find((s) => s.tier === TIER);
if (!stake) { console.error("Tier inconnu :", TIER); process.exit(1); }
const buildings = Object.values(cat.buildings);
const hubs = buildings.filter((b) => /Central Hub/.test(b.name) && b.power > 0)
  .sort((a, b) => a.slots - b.slots);
// une source d'energie = power > 0, sans extraction, hors hub central
const powerSources = buildings.filter((b) => b.power > 0 && !b.extract.length && !/Central Hub/.test(b.name))
  .sort((a, b) => (b.power / b.slots) - (a.power / a.slots));
// extracteurs : un seul gisement, taux > 0
const extractors = buildings.filter((b) => b.extract.length === 1 && b.extract[0][1] > 0 && b.power < 0);
const bestExtractorFor = {};
for (const b of extractors) {
  const res = b.extract[0][0];
  const cur = bestExtractorFor[res];
  // a tier egal on garde le meilleur rendement par slot
  if (!cur || (b.extract[0][1] / b.slots) > (cur.extract[0][1] / cur.slots)) bestExtractorFor[res] = b;
}

// ── evaluation d'un corps ──
const resSets = c4.resSets || [];
const names = c4.resourceNames || {};
function evaluate(body) {
  if (body.length < 4) return null;
  const rich = body[2], ids = resSets[body[3]] || [];
  const hub = hubs[0];
  if (!hub || hub.slots >= stake.slots) return null;

  // candidats : gisements presents, extractibles et cotes
  const cands = [];
  for (const id of ids) {
    const nm = names[id];
    if (!nm || (ONLY && nm !== ONLY)) continue;
    const ex = bestExtractorFor[nm];
    if (!ex) continue;
    const pr = priceOf(nm);
    const rate = ex.extract[0][1] * rich;          // hypothese : richesse multiplicative
    const price = (pr && pr.bid) ? pr.bid : 0;     // 0 = ressource non cotee
    // Sans prix on classe au volume extrait : c'est le cas de la majorite des
    // gisements de C4, absents du marche actuel.
    const score = price > 0 ? rate * price : rate * PRICE_UNKNOWN;
    cands.push({ name: nm, ex: ex, rate: rate, price: price, priced: price > 0,
                 valuePerSlot: score / ex.slots });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.valuePerSlot - a.valuePerSlot);

  // remplissage : hub, puis extracteurs, en ajoutant de l'energie au besoin
  let slots = stake.slots - hub.slots, power = hub.power, value = 0;
  const plan = [{ n: hub.name, q: 1 }];
  const add = (b, q) => { const e = plan.find((x) => x.n === b.name); if (e) e.q += q; else plan.push({ n: b.name, q: q }); };
  const psrc = powerSources[0];
  for (const c of cands) {
    while (slots >= c.ex.slots) {
      if (power + c.ex.power < 0) {                 // il faut d'abord de l'energie
        if (!psrc || slots < psrc.slots + c.ex.slots) break;
        slots -= psrc.slots; power += psrc.power; add(psrc, 1);
        continue;
      }
      slots -= c.ex.slots; power += c.ex.power; add(c.ex, 1);
      value += c.priced ? c.rate * c.price : (MODE === 'volume' ? c.rate : 0);
    }
  }
  if (value <= 0) return null;
  return { value: value, plan: plan, slotsLeft: slots, power: power, rich: rich, top: cands[0].name };
}

// ── balayage de tous les corps ──
const out = [];
for (const sys of c4.systems) {
  for (const body of (sys.bodies || [])) {
    const r = evaluate(body);
    if (r) out.push({ sys: sys.n, faction: sys.f, body: body[0], type: body[1] ? "asteroide" : "planete", ...r });
  }
}
out.sort((a, b) => b.value - a.value);

console.log(`\nClaim Stake Tier ${TIER} — ${stake.slots} slots`);
console.log(`Hub central : ${hubs[0] ? hubs[0].name : "aucun"} | corps evalues : ${out.length}`);
if (ONLY) console.log(`Filtre ressource : ${ONLY}`);
const nPriced = Object.keys(bestExtractorFor).filter((n) => { const p = priceOf(n); return p && p.bid; }).length;
console.log(MODE === "volume"
  ? `\nClassement au VOLUME extrait (unites par cycle) — toutes ressources.\n`
  : `\nClassement a la VALEUR (unites x meilleur prix acheteur).\n` +
    `Seules ${nPriced} ressources sur ${Object.keys(bestExtractorFor).length} sont cotees ; les autres comptent pour 0.\n` +
    `Utiliser --mode volume pour classer au volume brut.\n`);
console.log("  #  SYSTEME              CORPS                  FACTION  RICH  VALEUR   PRINCIPAL");
out.slice(0, TOP).forEach((r, i) => {
  console.log(`  ${String(i + 1).padStart(2)} ${r.sys.slice(0, 20).padEnd(20)} ${r.body.slice(0, 22).padEnd(22)} ` +
    `${String(r.faction).padEnd(8)} ${String(r.rich).padEnd(5)} ${r.value.toFixed(1).padStart(7)}  ${r.top}`);
});
if (out.length) {
  const b = out[0];
  console.log(`\nPlan de construction du meilleur emplacement (${b.body}, systeme ${b.sys}) :`);
  for (const p of b.plan) console.log(`   ${String(p.q).padStart(3)} x ${p.n}`);
  console.log(`   slots restants : ${b.slotsLeft} | bilan energie : ${b.power}`);
}
console.log("\nRappel : PTR sans marche reel, prix issus du jeu actuel, loyer non deduit.");
