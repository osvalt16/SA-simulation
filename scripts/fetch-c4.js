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
  return { id: sid, n: name, rg: region, x: x, y: y, cb: nCb, conn: conn, f: faction, sb: level };
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
    let attached = 0;
    for (const a of cbAccounts) {
      const d = Buffer.from(a.account.data[0], "base64");
      if (d.length < 156) continue;
      const name = d.subarray(11, 75).toString("utf8").split("\0")[0].trim();
      const sysKey = b58(d.subarray(107, 139));
      const type = d[155]; // 0 planete, 1 asteroide
      const s = byPubkey[sysKey];
      if (!s || !name) continue;
      if (!s.bodies) s.bodies = [];
      s.bodies.push([name, type]);
      attached++;
    }
    for (const s of systems) if (s.bodies) s.bodies.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    console.log("Corps rattaches:", attached);
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
    count: systems.length,
    starbases: starbases,
    factions: factionCounts,
    factionNames: FACTIONS,
    changes: changes,
    systems: systems,
  };
  fs.writeFileSync("c4_data.json", JSON.stringify(out));
  console.log("Ecrit c4_data.json :", systems.length, "systemes,", starbases, "starbases,",
    changes.length, "changements suivis,", JSON.stringify(factionCounts));
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
