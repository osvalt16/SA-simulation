// scripts/fetch-c4-buildings.js
// Extrait du compte `game` de SAGE C4 (testnet z.ink) le catalogue necessaire
// a l'economie des claim stakes, et ecrit c4_buildings.json :
//   - table des cargos (id -> nom)
//   - definitions de claim stakes (slots par tier)
//   - definitions de batiments (slots, energie, equipage, cout, extraction)
//
// Tout est localise par MOTIF et non par offset fixe, pour resister aux mises
// a jour du programme. Aucune dependance npm.
//
// Layouts verifies on-chain le 2026-07-31 :
//   cargoType          : id u16 + name[64] + mint[32] + ... (126 o, pas fixe)
//   claimStakeDefinition : name[64] + cargoId u16 + tier u8 + slots u32
//                          + rentMultiplier u64 + placementFeeMultiplier u64
//                          + hubValue u16 + tags... (multiplicateurs en
//                          virgule fixe : 2^56 = 1.0)
//   buildingDefinition : id u16 + name[64] + slots u32 + crewSlots i16
//                        + neededCrew u16 + constructionTime i64 + power i16
//                        + resourceStorage u64 + hubValue u16 + minimumTier u8
//                        + xpValue u32, puis les cartes refunds /
//                        constructionCost / researchRequirements /
//                        netResourceProduction / resourceExtraction
//                        (chaque carte : u32 de comptage + entrees de 10 o)

const fs = require("fs");

const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const DISC_STAR_SYSTEM = Buffer.from("cf207b0909fbdda9", "hex");
const CARGO_ENTRY = 126;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = BigInt("0x" + buf.toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let z = 0; for (const b of buf) { if (b === 0) z++; else break; }
  return "1".repeat(z) + s;
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
// Nom zero-padde de 64 octets, entierement imprimable
function nameAt(g, o, len = 64) {
  if (o + len > g.length) return null;
  const raw = g.subarray(o, o + len);
  const e = raw.indexOf(0);
  if (e < 3 || e > 44) return null;
  for (let i = 0; i < e; i++) if (raw[i] < 32 || raw[i] > 126) return null;
  for (let i = e; i < len; i++) if (raw[i] !== 0) return null;
  return raw.subarray(0, e).toString("utf8");
}
const asI64 = (v) => (v >= (1n << 63n) ? v - (1n << 64n) : v);

function readMap(g, o, signed) {
  const n = g.readUInt32LE(o); o += 4;
  if (n > 200) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const id = g.readUInt16LE(o);
    const raw = g.readBigUInt64LE(o + 2);
    out.push([id, Number(signed ? asI64(raw) : raw)]);
    o += 10;
  }
  return { list: out, off: o };
}

function main2(g) {
  // ── table des cargos : suite d'entrees de 126 o a ids croissants ──
  let cargoStart = -1;
  for (let o = 0; o + CARGO_ENTRY * 20 < g.length && cargoStart < 0; o++) {
    if (!nameAt(g, o + 2)) continue;
    let cnt = 0, prev = -1, p = o;
    while (p + CARGO_ENTRY < g.length) {
      const nm = nameAt(g, p + 2); if (!nm) break;
      const id = g.readUInt16LE(p);
      if (id <= prev) break;
      prev = id; cnt++; p += CARGO_ENTRY;
    }
    if (cnt >= 30) cargoStart = o;
  }
  const cargo = {};
  if (cargoStart >= 0) {
    let p = cargoStart, prev = -1;
    while (p + CARGO_ENTRY < g.length) {
      const nm = nameAt(g, p + 2); if (!nm) break;
      const id = g.readUInt16LE(p);
      if (id <= prev) break;
      prev = id; cargo[id] = nm; p += CARGO_ENTRY;
    }
  }
  const cname = (id) => cargo[id] || String(id);

  // ── claim stakes : reperees par leur nom ──
  const stakes = [];
  const FIXED = 2n ** 56n; // multiplicateurs en virgule fixe : 2^56 = 1.0
  for (let o = 0; o + 128 < g.length; o++) {
    const nm = nameAt(g, o);
    if (!nm || !/^Claim Stake Tier [1-5]$/.test(nm)) continue;
    let p = o + 64;
    const cargoId = g.readUInt16LE(p); p += 2;
    const tier = g[p] + 1; p += 1;
    const slots = g.readUInt32LE(p); p += 4;
    const rent = g.readBigUInt64LE(p); p += 8;
    const fee = g.readBigUInt64LE(p); p += 8;
    const hub = g.readUInt16LE(p);
    if (slots < 1 || slots > 100000) continue;
    if (stakes.some((s) => s.tier === tier)) continue;
    stakes.push({ name: nm, cargoId: cargoId, cargoName: cname(cargoId), tier: tier, slots: slots,
      rentMultiplier: Number(rent) / Number(FIXED), placementFeeMultiplier: Number(fee) / Number(FIXED),
      hubValue: hub });
  }
  stakes.sort((a, b) => a.tier - b.tier);

  // ── batiments ──
  const buildings = {};
  const re = /^[A-Z][\x20-\x7e]{4,44} Tier [1-5]$/;
  for (let o = 2; o + 200 < g.length; o++) {
    const nm = nameAt(g, o);
    if (!nm || !re.test(nm) || /Claim Stake/.test(nm) || buildings[nm]) continue;
    let p = o + 64;
    const slots = g.readUInt32LE(p); p += 4;
    p += 2;                                  // crewSlots
    const crew = g.readUInt16LE(p); p += 2;
    const ctime = Number(asI64(g.readBigUInt64LE(p))); p += 8;
    const power = g.readInt16LE(p); p += 2;
    const storage = Number(g.readBigUInt64LE(p)); p += 8;
    p += 2;                                  // hubValue
    const minTier = g[p] + 1; p += 1;
    p += 4;                                  // xpValue
    if (slots > 200 || crew > 500 || ctime <= 0 || ctime > 1e7 || power < -5000 || power > 5000) continue;
    const refunds = readMap(g, p, false); if (!refunds) continue;
    const cost = readMap(g, refunds.off, false); if (!cost) continue;
    const nres = g.readUInt32LE(cost.off); if (nres > 200) continue;
    const prod = readMap(g, cost.off + 4 + nres * 2, true); if (!prod) continue;
    const extr = readMap(g, prod.off, false); if (!extr) continue;
    buildings[nm] = { name: nm, tier: minTier, slots: slots, power: power, crew: crew,
      constructionTime: ctime, storage: storage,
      cost: cost.list.map(([c, v]) => [cname(c), v]),
      net: prod.list.map(([c, v]) => [cname(c), v]),
      extract: extr.list.map(([c, v]) => [cname(c), v]) };
  }
  return { cargo, stakes, buildings };
}

async function main() {
  console.log("RPC:", RPC);
  const accounts = await rpc("getProgramAccounts", [C4_SAGE, {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: DISC_STAR_SYSTEM.toString("base64"), encoding: "base64" } }],
    dataSlice: { offset: 9, length: 32 },
  }]);
  if (!accounts.length) throw new Error("aucun systeme : programme ou RPC a verifier");
  const gameId = b58(Buffer.from(accounts[0].account.data[0], "base64"));
  console.log("Compte game:", gameId);
  const info = await rpc("getAccountInfo", [gameId, { encoding: "base64" }]);
  const g = Buffer.from(info.value.data[0], "base64");
  console.log("Taille:", Math.round(g.length / 1024), "Ko");

  const { cargo, stakes, buildings } = main2(g);
  const list = Object.values(buildings);
  const out = {
    updated: new Date().toISOString(),
    network: "z.ink testnet (PTR)",
    game: gameId,
    cargoCount: Object.keys(cargo).length,
    cargo: cargo,
    claimStakes: stakes,
    buildings: buildings,
  };
  fs.writeFileSync("c4_buildings.json", JSON.stringify(out));
  console.log("Cargos:", Object.keys(cargo).length, "| claim stakes:", stakes.length,
    "| batiments:", list.length,
    "(dont", list.filter((b) => b.extract.length).length, "extracteurs et",
    list.filter((b) => b.power > 0).length, "sources d'energie)");
  for (const s of stakes) console.log("  ", s.name, "->", s.slots, "slots");
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
