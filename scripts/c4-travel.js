// scripts/c4-travel.js
// Planificateur de trajet pour le bot : combien de carburant, de nourriture
// et de temps pour aller d'un systeme A a un systeme B, avec marge.
//
//   node scripts/c4-travel.js --from Lampblack --to Serinbrakh [--ship "Nom"]
//   node scripts/c4-travel.js --list-ships
//
// Donnees : ships_c4.json (stats lues dans le compte `game`) et c4_data.json
// (coordonnees des 945 systemes, lues on-chain).
//
// NIVEAU DE CONFIANCE — a lire avant de s'y fier :
//  - Les STATS des vaisseaux sont des faits lus on-chain. Verifiees sur un
//    vaisseau connu : Pearce X4 -> cargo 389, fuel 267, ce qui correspond au
//    jeu reel.
//  - Les distances sont exactes (coordonnees on-chain).
//  - En revanche les FORMULES de consommation ne sont pas confirmees. Les
//    constantes d'echelle ci-dessous sont des hypotheses de travail. Elles
//    doivent etre calibrees en observant un vrai deplacement de flotte
//    (relever le carburant avant/apres un warp de distance connue).
//    Tant que ce n'est pas fait, TRAITER LES QUANTITES COMME DES ORDRES DE
//    GRANDEUR, et garder la marge de securite.

const fs = require("fs");
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// ── constantes a calibrer (voir avertissement ci-dessus) ──
const SCALE_FUEL = 1e6;     // les taux sont stockes en millioniemes
const SCALE_SPEED = 1e6;    // idem pour les vitesses
const MARGIN = 1.25;        // marge de securite : on emporte 25 % de plus

const ships = JSON.parse(fs.readFileSync("ships_c4.json", "utf8"));
const c4 = JSON.parse(fs.readFileSync("c4_data.json", "utf8"));

if (args.includes("--list-ships")) {
  const t = ships.filter((s) => s.cargo > 100 && s.crew < 100)
    .sort((a, b) => b.cargo - a.cargo).slice(0, 25);
  console.log("Vaisseaux triés par capacité de cargo :\n");
  console.log("NOM".padEnd(40) + "CARGO".padStart(8) + "FUEL".padStart(8) +
    "WARP".padStart(9) + "PORTEE".padStart(8) + "CREW".padStart(6));
  for (const s of t) {
    console.log(s.name.slice(0, 40).padEnd(40) + String(s.cargo).padStart(8) +
      String(s.fuel).padStart(8) + String(s.warp).padStart(9) +
      String(s.maxWarp).padStart(8) + String(s.crew).padStart(6));
  }
  process.exit(0);
}

const findSys = (n) => c4.systems.find((s) => s.n.toLowerCase() === String(n).toLowerCase());
const from = findSys(argv("--from", "")), to = findSys(argv("--to", ""));
if (!from || !to) {
  console.error("Systeme introuvable. Exemple :");
  console.error("  node scripts/c4-travel.js --from Lampblack --to Serinbrakh");
  process.exit(1);
}
const shipName = argv("--ship", "Pearce X4 Default Config");
const ship = ships.find((s) => s.name === shipName) ||
  ships.find((s) => s.name.toLowerCase().includes(shipName.toLowerCase()));
if (!ship) { console.error("Vaisseau introuvable. Utiliser --list-ships."); process.exit(1); }

// distance en unites de la carte (coordonnees on-chain, echelle C4)
const dx = to.x - from.x, dy = to.y - from.y;
const dist = Math.sqrt(dx * dx + dy * dy);

// ── warp : limite par maxWarpDistance, avec temps de recharge entre sauts ──
const warpRange = ship.maxWarp;
const warpJumps = Math.ceil(dist / warpRange);
const warpFuel = (ship.warpFuel / SCALE_FUEL) * dist + ship.exitFuel * warpJumps;
const warpTime = (dist / (ship.warp / SCALE_SPEED)) + (warpJumps - 1) * ship.cool;

// ── subwarp : plus lent, moins cher, sans limite de portee ──
const subFuel = (ship.subFuel / SCALE_FUEL) * dist + ship.exitFuel;
const subTime = dist / (ship.sub / SCALE_SPEED);

const fmt = (s) => s < 60 ? `${s.toFixed(0)} s`
  : s < 3600 ? `${(s / 60).toFixed(1)} min`
  : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} j`;

console.log(`\nTrajet : ${from.n}  ->  ${to.n}`);
console.log(`Distance : ${dist.toFixed(1)} unites`);
console.log(`Vaisseau : ${ship.name}`);
console.log(`   cargo ${ship.cargo} | reservoir ${ship.fuel} | portee warp ${ship.maxWarp} | equipage ${ship.crew}\n`);

const rows = [
  ["WARP", warpJumps + " saut(s)", warpFuel, warpTime],
  ["SUBWARP", "direct", subFuel, subTime],
];
console.log("MODE".padEnd(10) + "DETAIL".padEnd(14) + "CARBURANT".padStart(11) + "DUREE".padStart(12));
for (const [m, d, f, t] of rows) {
  console.log(m.padEnd(10) + d.padEnd(14) + f.toFixed(1).padStart(11) + fmt(t).padStart(12));
}

const best = warpFuel <= ship.fuel ? rows[0] : rows[1];
const fuelNeeded = best[2] * MARGIN;
// nourriture : consommee par l'equipage pendant le trajet
const food = (ship.food / SCALE_FUEL) * best[3] * Math.max(1, ship.crew) * MARGIN;

console.log(`\nRecommandation : ${best[0]}`);
console.log(`   carburant a embarquer : ${fuelNeeded.toFixed(1)}  (marge ${Math.round((MARGIN - 1) * 100)} %)`);
console.log(`   nourriture            : ${food.toFixed(1)}`);
console.log(`   duree                 : ${fmt(best[3])}`);
if (fuelNeeded > ship.fuel) {
  console.log(`\n   ATTENTION : le reservoir (${ship.fuel}) ne suffit pas. Prevoir une escale`);
  console.log(`   ou un vaisseau a plus grande autonomie.`);
}
console.log(`\nLes stats du vaisseau sont lues on-chain. Les FORMULES de consommation`);
console.log(`restent a calibrer sur un deplacement reel : traiter ces quantites comme`);
console.log(`des ordres de grandeur et conserver la marge.`);
