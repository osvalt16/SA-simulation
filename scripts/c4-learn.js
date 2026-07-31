// scripts/c4-learn.js
// Module d'apprentissage du bot : il apprend les regles du jeu en OBSERVANT,
// au lieu de les deviner ou de les apprendre a ses depens.
//
//   node scripts/c4-learn.js            un passage : instantane + comparaison
//   node scripts/c4-learn.js --watch    en continu
//
// Idee directrice : 1 400 joueurs bougent leurs flottes en permanence et
// tout est public. Le bot n'a pas besoin de depenser son propre carburant
// pour decouvrir combien coute un warp — il lui suffit de regarder les
// autres. C'est gratuit, sans risque, et bien plus rapide qu'un
// apprentissage par essais et erreurs.
//
// Ce qu'il apprend, et qui s'accumule dans c4_knowledge.json :
//   - la POSITION des champs qui bougent dans les comptes de flotte
//     (il ne fait pas confiance a mes calculs d'offsets : il les verifie) ;
//   - la CONSOMMATION reelle de carburant, deduite des variations observees ;
//   - les ERREURS deja rencontrees, pour ne jamais les repeter.
//
// Le fichier de connaissance est cumulatif : plus le bot tourne, plus ses
// estimations se resserrent.

const fs = require("fs");
const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const DISC_FLEET = "6dcffb306a0288a3";
const SNAP = "c4_fleet_snapshot.json";
const KNOW = "c4_knowledge.json";
const WATCH = process.argv.includes("--watch");
const PERIOD = 120000;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadKnowledge() {
  try { return JSON.parse(fs.readFileSync(KNOW, "utf8")); }
  catch (e) {
    return {
      version: 1,
      // champs repérés comme variables dans les comptes de flotte
      volatileOffsets: {},
      // observations de consommation : { offset, drops: [...] }
      fuelObservations: [],
      // erreurs rencontrees, pour ne pas les refaire
      knownErrors: {},
      updated: null,
    };
  }
}

async function snapshot() {
  const res = await rpc("getProgramAccounts", [C4_SAGE, { encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(DISC_FLEET, "hex").toString("base64"), encoding: "base64" } }] }]);
  const out = {};
  for (const a of res) out[a.pubkey] = a.account.data[0];
  return { t: Date.now(), fleets: out };
}

// Compare deux instantanes et retient TOUT ce qui a bouge, sans presupposer
// la structure : c'est ainsi que le bot verifie mes offsets au lieu de les
// croire sur parole.
function diff(prev, cur, know) {
  let moved = 0, fields = 0;
  const offsetHits = {};
  for (const pk in cur.fleets) {
    const a = prev.fleets[pk];
    if (!a) continue;
    const A = Buffer.from(a, "base64"), B = Buffer.from(cur.fleets[pk], "base64");
    if (A.equals(B) || A.length !== B.length) continue;
    moved++;
    // repere les u64 qui ont change, alignes sur 1 octet (on ne suppose rien)
    for (let o = 0; o + 8 <= A.length; o++) {
      const x = A.readBigUInt64LE(o), y = B.readBigUInt64LE(o);
      if (x === y) continue;
      offsetHits[o] = (offsetHits[o] || 0) + 1;
      fields++;
      // une BAISSE d'une valeur plausible ressemble a une consommation
      if (y < x && x < 10n ** 12n && x - y < 10n ** 9n) {
        know.fuelObservations.push({ pk: pk.slice(0, 8), off: o,
          from: Number(x), to: Number(y), drop: Number(x - y),
          dt: Math.round((cur.t - prev.t) / 1000) });
      }
    }
  }
  // ne garde que les offsets les plus souvent modifies : ce sont les champs reels
  const top = Object.entries(offsetHits).sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [off, n] of top) know.volatileOffsets[off] = (know.volatileOffsets[off] || 0) + n;
  if (know.fuelObservations.length > 4000) know.fuelObservations = know.fuelObservations.slice(-4000);
  return { moved, fields, top };
}

function report(know) {
  const offs = Object.entries(know.volatileOffsets).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (offs.length) {
    log("champs les plus mobiles dans les comptes de flotte (offset : occurrences)");
    log("   " + offs.map(([o, n]) => `${o}:${n}`).join("  "));
  }
  // regroupe les baisses par offset : celui qui en concentre le plus est le
  // meilleur candidat pour le reservoir de carburant
  const byOff = {};
  for (const o of know.fuelObservations) (byOff[o.off] = byOff[o.off] || []).push(o.drop);
  const ranked = Object.entries(byOff).map(([o, d]) => ({ off: +o, n: d.length,
    median: d.slice().sort((a, b) => a - b)[Math.floor(d.length / 2)] }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
  if (ranked.length) {
    log("candidats reservoir de carburant :");
    for (const r of ranked) log(`   offset ${r.off} — ${r.n} baisses observees, mediane ${r.median}`);
    log("   -> quand un offset se detache nettement, c'est le reservoir.");
    log("      la mediane des baisses donne la consommation reelle par deplacement.");
  } else {
    log("aucune baisse observee pour l'instant : laisser tourner avec --watch.");
  }
}

async function cycle(know) {
  const cur = await snapshot();
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(SNAP, "utf8")); } catch (e) {}
  log(`instantane : ${Object.keys(cur.fleets).length} flottes`);
  if (prev) {
    const d = diff(prev, cur, know);
    log(`depuis le dernier passage (${Math.round((cur.t - prev.t) / 1000)} s) : ` +
        `${d.moved} flotte(s) modifiee(s), ${d.fields} champ(s) touche(s)`);
    know.updated = new Date().toISOString();
    fs.writeFileSync(KNOW, JSON.stringify(know, null, 1));
    report(know);
  } else {
    log("premier instantane enregistre — relancer pour comparer.");
  }
  fs.writeFileSync(SNAP, JSON.stringify(cur));
}

async function main() {
  console.log("Apprentissage par observation — SAGE C4\n");
  const know = loadKnowledge();
  log("observations de carburant deja accumulees :", know.fuelObservations.length);
  await cycle(know);
  if (WATCH) {
    log(`surveillance continue, toutes les ${PERIOD / 1000} s — Ctrl+C pour arreter`);
    setInterval(() => cycle(know).catch((e) => log("erreur :", e.message)), PERIOD);
  }
}

main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });
