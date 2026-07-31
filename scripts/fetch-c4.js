// scripts/fetch-c4.js
// Lit les systemes stellaires de SAGE C4 (PTR) sur le TESTNET z.ink et ecrit
// c4_data.json a la racine du depot (lu par l'overlay C4 de index.html).
//
// ATTENTION : donnees de TESTNET (https://testnet-rpc.z.ink). Le PTR est reset
// entre les phases ; les program IDs peuvent changer au mainnet. Verifier le
// program ID dans @staratlas/dev-sage a chaque montee de version.
//
// Aucune dependance npm : decodage manuel du compte StarSystem d'apres l'IDL
// Codama de @staratlas/dev-sage 0.52.0 (sageStarFrame 0.49.0). Layout verifie
// on-chain le 2026-07-31 :
//   8   discriminator cf207b0909fbdda9
//   1   version u8
//   32  gameId
//   2   systemId u16
//   64  name (zero-padded)
//   3   region Option fixe (prefix u8 + regionId u16)
//   16  coordinates [2]i64  <- valeur reelle = i64 / 1e15
//   8   seqId u64
//   4+n*(2+48) connections : map u32-prefixee systemId(u16) -> connectionCost (6 x u64)
//   4+m*32     celestialBodies : set u32-prefixe de pubkeys
//   1+...      starbase Option : faction u8 (0 Unaligned, 1 MUD, 2 ONI, 3 UST),
//              level u8 (enum level0..), reste ignore
//
// Lance par .github/workflows/update-c4.yml.

const fs = require("fs");

const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const DISC_STAR_SYSTEM = Buffer.from("cf207b0909fbdda9", "hex");
// CelestialBody (156 octets fixes) : 8 disc, 1 version, 2 id u16, 64 name,
// 32 game, 32 system (pubkey du StarSystem), 8 systemSeqId, 8 lastSync,
// 1 type (0 = planete, 1 = asteroide)
const DISC_CELESTIAL = Buffer.from("b9251d7a0ed88e6d", "hex");
const COORD_SCALE = 1e15;
const FACTIONS = ["UNALIGNED", "MUD", "ONI", "UST"];
const MAX_CHANGES = 120; // historique d'evolution conserve (voir plus bas)

// Gisements : chaque compte CelestialBody porte, apres l'en-tete fixe, une
// liste count-prefixee de gisements. Deux formats verifies on-chain :
//   planete   : 10 octets par entree  (cargoId u16 + richesse u64 virgule fixe)
//   asteroide : 26 octets par entree  (idem + quantite minable u64 + drapeau u64)
// La richesse est en virgule fixe sur 48 bits de partie fractionnaire.
// Elle est uniforme sur un meme corps (verifie sur les 3901 corps).
const RICH_SCALE = 2 ** 48;
// Le nom des gisements vient de la table officielle des cargos, stockee dans
// le compte `game` (~2,8 Mo) : suite d'entrees de 126 octets
// { cargoId u16, name[64], mint[32], ... }. On la localise par motif plutot
// que par offset fixe, pour resister aux mises a jour du programme.
const CARGO_ENTRY = 126;
const CARGO_NAME_LEN = 64;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = BigInt("0x" + buf.toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let zeros = 0;
  for (const b of buf) { if (b === 0) zeros++; else break; }
  return "1".repeat(zeros) + s;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}

function decodeStarSystem(d) {
  let o = 8;
  o += 1; // version
  o += 32; // gameId
  const sid = d.readUInt16LE(o); o += 2;
  const name = d.subarray(o, o + 64).toString("utf8").split("\0")[0].trim(); o += 64;
  const hasRegion = d[o];
  const region = hasRegion ? d.readUInt16LE(o + 1) : null; o += 3;
  const x = Number(d.readBigInt64LE(o)) / COORD_SCALE; o += 8;
  const y = Number(d.readBigInt64LE(o)) / COORD_SCALE; o += 8;
  o += 8; // seqId
  const nConn = d.readUInt32LE(o); o += 4;
  const conn = [];
  for (let i = 0; i < nConn; i++) { conn.push(d.readUInt16LE(o)); o += 2 + 48; }
  const nCb = d.readUInt32LE(o); o += 4;
  o += nCb * 32;
  let faction = null, level = 0;
  if (d[o]) { faction = d[o + 1]; level = d[o + 2]; }
  // `so` = offset du champ starbase. Publie pour que le navigateur puisse
  // relire EN DIRECT seulement ces 3 octets (option + faction + niveau) via
  // getMultipleAccounts + dataSlice, au lieu de retelecharger 2,75 Mo.
  return { id: sid, n: name, rg: region, x: x, y: y, cb: nCb, conn: conn, f: faction, sb: level, so: o };
}

// Lit la liste de gisements d'un CelestialBody. Renvoie {rich, res:[[id, qty]]}
function decodeBodyResources(d) {
  for (const size of [10, 26]) {
    for (let o = 156; o < d.length - 14; o++) {
      const n = d.readUInt32LE(o);
      if (n < 1 || n > 90) continue;
      if (o + 4 + n * size > d.length) continue;
      const res = []; let prev = -1, ok = true, rich = null;
      for (let k = 0; k < n; k++) {
        const b = o + 4 + k * size;
        const id = d.readUInt16LE(b);
        const r = Number(d.readBigUInt64LE(b + 2)) / RICH_SCALE;
        if (id < 300 || id > 900 || id <= prev || r < 0.5 || r > 12) { ok = false; break; }
        prev = id;
        if (rich === null) rich = Math.round(r * 100) / 100;
        res.push(size === 26 ? [id, Number(d.readBigUInt64LE(b + 10))] : [id]);
      }
      if (ok && n >= 2) return { rich: rich, res: res };
    }
  }
  return null;
}

// Localise la table des cargos dans le compte `game` et en extrait id -> nom.
function decodeCargoNames(g) {
  const valid = (off) => {
    const id = g.readUInt16LE(off);
    const raw = g.subarray(off + 2, off + 2 + CARGO_NAME_LEN);
    const end = raw.indexOf(0);
    if (end < 3 || end > 40) return null;
    for (let i = 0; i < end; i++) if (raw[i] < 32 || raw[i] > 126) return null;
    for (let i = end; i < CARGO_NAME_LEN; i++) if (raw[i] !== 0) return null;
    return { id: id, name: raw.subarray(0, end).toString('utf8') };
  };
  // cherche une suite d'au moins 20 entrees consecutives a pas constant
  for (let o = 0; o < g.length - CARGO_ENTRY * 20; o++) {
    const first = valid(o);
    if (!first || first.id < 250 || first.id > 400) continue;
    let count = 0, prev = -1, p = o;
    while (p < g.length - CARGO_ENTRY) {
      const v = valid(p);
      if (!v || v.id <= prev) break;
      prev = v.id; count++; p += CARGO_ENTRY;
    }
    if (count >= 20) {
      const map = {};
      p = o; prev = -1;
      while (p < g.length - CARGO_ENTRY) {
        const v = valid(p);
        if (!v || v.id <= prev) break;
        prev = v.id; map[v.id] = v.name; p += CARGO_ENTRY;
      }
      return map;
    }
  }
  return null;
}

async function main() {
  console.log("RPC:", RPC);
  const disc = DISC_STAR_SYSTEM.toString("base64");
  const accounts = await rpc("getProgramAccounts", [C4_SAGE, {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: disc, encoding: "base64" } }],
  }]);
  console.log("Comptes StarSystem:", accounts.length);

  const systems = [];
  const byPubkey = {}; // pubkey du compte StarSystem -> systeme (pour rattacher les corps)
  let errors = 0;
  for (const a of accounts) {
    try {
      const s = decodeStarSystem(Buffer.from(a.account.data[0], "base64"));
      if (!s.n || !isFinite(s.x) || !isFinite(s.y)) { errors++; continue; }
      s.pk = a.pubkey; // adresse du compte, pour la relecture live ciblee
      s.x = Math.round(s.x * 1000) / 1000;
      s.y = Math.round(s.y * 1000) / 1000;
      systems.push(s);
      byPubkey[a.pubkey] = s;
    } catch (e) { errors++; }
  }

  // --- Corps celestes : rattaches a leur systeme (planetes puis asteroides) ---
  try {
    const cbAccounts = await rpc("getProgramAccounts", [C4_SAGE, {
      encoding: "base64",
      // Pas de filtre dataSize : le compte a une partie dynamique au-dela des
      // 156 octets fixes (champs plus recents que l'IDL npm — ressources ?).
      filters: [
        { memcmp: { offset: 0, bytes: DISC_CELESTIAL.toString("base64"), encoding: "base64" } },
      ],
    }]);
    console.log("Comptes CelestialBody:", cbAccounts.length);
    let attached = 0, withRes = 0;
    const resSets = [], setIndex = new Map();
    for (const a of cbAccounts) {
      const d = Buffer.from(a.account.data[0], "base64");
      if (d.length < 156) continue;
      const name = d.subarray(11, 75).toString("utf8").split("\0")[0].trim();
      const sysKey = b58(d.subarray(107, 139));
      const type = d[155]; // 0 planete, 1 asteroide
      const s = byPubkey[sysKey];
      if (!s || !name) continue;
      if (!s.bodies) s.bodies = [];
      const r = decodeBodyResources(d);
      // [nom, type, richesse, indexPalette, quantites?]
      // Les 3901 corps ne se partagent que ~240 ensembles de gisements
      // distincts : on les factorise dans une palette (resSets) plutot que
      // de repeter la liste dans chaque corps (917 Ko -> ~250 Ko).
      if (r) {
        const key = r.res.map((x) => x[0]).join(",");
        let idx = setIndex.get(key);
        if (idx === undefined) { idx = resSets.length; setIndex.set(key, idx); resSets.push(r.res.map((x) => x[0])); }
        const qty = r.res.map((x) => (x.length > 1 ? x[1] : 0));
        s.bodies.push(qty.some((q) => q > 0) ? [name, type, r.rich, idx, qty] : [name, type, r.rich, idx]);
        withRes++;
      } else s.bodies.push([name, type]);
      attached++;
    }
    for (const s of systems) if (s.bodies) s.bodies.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    globalThis.__resSets = resSets;
    console.log("Corps rattaches:", attached, "| avec gisements:", withRes, "| ensembles distincts:", resSets.length);
  } catch (e) {
    console.warn("Corps celestes indisponibles :", e.message);
  }
  if (errors) console.warn("Comptes ignores (decodage):", errors);
  if (!systems.length) throw new Error("aucun systeme decode — layout ou program ID a re-verifier");
  systems.sort((a, b) => a.id - b.id);

  const factionCounts = {};
  let starbases = 0;
  for (const s of systems) {
    if (s.f != null) { const f = FACTIONS[s.f] || String(s.f); factionCounts[f] = (factionCounts[f] || 0) + 1; }
    if (s.sb > 0) starbases++;
  }

  // --- Noms officiels des gisements, lus dans le compte `game` ---
  const allResSets = globalThis.__resSets || [];
  let cargoNames = null;
  try {
    const gameId = b58(Buffer.from(accounts[0].account.data[0], "base64").subarray(9, 41));
    const info = await rpc("getAccountInfo", [gameId, { encoding: "base64" }]);
    if (info && info.value) {
      const g = Buffer.from(info.value.data[0], "base64");
      cargoNames = decodeCargoNames(g);
      console.log("Table des cargos:", cargoNames ? Object.keys(cargoNames).length : 0, "entrees",
        "(compte game de", Math.round(g.length / 1024), "Ko)");
    }
  } catch (e) {
    console.warn("Table des cargos indisponible :", e.message);
  }
  // ne garde que les cargos effectivement presents comme gisements
  const usedIds = new Set();
  for (const set of allResSets) for (const id of set) usedIds.add(id);
  const resourceNames = {};
  if (cargoNames) for (const id of usedIds) if (cargoNames[id]) resourceNames[id] = cargoNames[id];
  console.log("Gisements nommes:", Object.keys(resourceNames).length, "/", usedIds.size);

  // --- Evolution : compare avec le c4_data.json precedent (niveaux de
  // starbase et changements de faction), conserve les MAX_CHANGES derniers ---
  let changes = [];
  try {
    const prev = JSON.parse(fs.readFileSync("c4_data.json", "utf8"));
    changes = prev.changes || [];
    const now = new Date().toISOString();
    const prevById = {};
    for (const s of prev.systems || []) prevById[s.id] = s;
    for (const s of systems) {
      const p = prevById[s.id];
      if (!p) continue;
      if ((p.sb || 0) !== (s.sb || 0))
        changes.push({ t: now, id: s.id, n: s.n, k: "sb", from: p.sb || 0, to: s.sb || 0 });
      if ((p.f == null ? -1 : p.f) !== (s.f == null ? -1 : s.f))
        changes.push({ t: now, id: s.id, n: s.n, k: "faction", from: p.f, to: s.f });
    }
    // reset du PTR probable si beaucoup de systemes ont disparu : on repart a zero
    if (prev.systems && systems.length < prev.systems.length * 0.5) {
      console.warn("[!] Forte baisse du nombre de systemes : reset PTR probable, historique vide.");
      changes = [];
    }
    changes = changes.slice(-MAX_CHANGES);
  } catch (e) { /* premier run : pas d'historique */ }

  const out = {
    updated: new Date().toISOString(),
    network: "z.ink testnet (PTR — donnees susceptibles d'etre reset)",
    program: C4_SAGE,
    rpc: "https://testnet-rpc.z.ink",   // lu par le navigateur pour le mode direct
    count: systems.length,
    starbases: starbases,
    factions: factionCounts,
    factionNames: FACTIONS,
    resourceNames: resourceNames,
    resSets: allResSets,
    changes: changes,
    systems: systems,
  };
  fs.writeFileSync("c4_data.json", JSON.stringify(out));
  console.log("Ecrit c4_data.json :", systems.length, "systemes,", starbases, "starbases,",
    changes.length, "changements suivis,", JSON.stringify(factionCounts));
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
