// scripts/fetch-c4-markets.js
// Lit les marches locaux de SAGE C4 sur le testnet z.ink et ecrit
// c4_markets.json. C'est la SEULE source de prix propre a C4 : le marche du
// jeu actuel ne cote que 12 des 93 gisements de C4.
//
// Layout du compte localMarket (verifie on-chain : les 56 comptes se parsent
// integralement, sans octet restant) :
//   8   discriminator
//   1   version
//   32  system
//   8   starbaseSeqId
//   1   bump
//   32  marketInitializer
//   10  cargo (cargoId u16 + amount u64)
//   8   vault
//   ... bids (orderBookSide), puis asks (orderBookSide)
//
// orderBookSide : idCounter u64 + makers (u32 + n x 58) + orders (u32 + n x 56)
//   makerInfo : pubkey 32 + atlas u64 + cargo u64 + orderCount u16 + rentBytes u64
//   orderInfo : price u64 + quantity u64 + orderId u64 + maker 32
//
// ATTENTION : au 2026-07-31 ce marche est quasi vide (20 marches sur 56 ont
// au moins un ordre, souvent un seul). Les prix qui en sortent ne sont donc
// PAS exploitables pour optimiser. Ce script sert a constituer l'historique
// des maintenant, pour le jour ou l'economie se remplira.

const fs = require("fs");

const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const DISC_LOCAL_MARKET = Buffer.from("1cf2d61d5e73a799", "hex");
const MAKER = 58, ORDER = 56, BOOK_START = 100;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}

function readSide(d, o) {
  if (o + 16 > d.length) return null;
  o += 8;                                   // idCounter
  const nm = d.readUInt32LE(o); o += 4;
  if (nm > 50 || o + nm * MAKER + 4 > d.length) return null;
  o += nm * MAKER;
  const no = d.readUInt32LE(o); o += 4;
  if (no > 200 || o + no * ORDER > d.length) return null;
  const orders = [];
  for (let k = 0; k < no; k++) {
    orders.push({ p: Number(d.readBigUInt64LE(o)), q: Number(d.readBigUInt64LE(o + 8)) });
    o += ORDER;
  }
  return { orders: orders, end: o };
}

async function main() {
  console.log("RPC:", RPC);
  let cargo = {};
  try { cargo = JSON.parse(fs.readFileSync("c4_buildings.json", "utf8")).cargo || {}; } catch (e) {}

  const accounts = await rpc("getProgramAccounts", [C4_SAGE, {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: DISC_LOCAL_MARKET.toString("base64"), encoding: "base64" } }],
  }]);
  console.log("Marches locaux:", accounts.length);

  const markets = [];
  let parsed = 0, withOrders = 0;
  for (const a of accounts) {
    const d = Buffer.from(a.account.data[0], "base64");
    const cargoId = d.readUInt16LE(82);
    const stock = Number(d.readBigUInt64LE(84));
    const bids = readSide(d, BOOK_START);
    if (!bids) continue;
    const asks = readSide(d, bids.end);
    // controle d'integrite : la lecture doit consommer exactement le compte
    if (!asks || asks.end !== d.length) continue;
    parsed++;
    const bestBid = bids.orders.length ? Math.max(...bids.orders.map((o) => o.p)) : null;
    const bestAsk = asks.orders.length ? Math.min(...asks.orders.map((o) => o.p)) : null;
    if (bestBid != null || bestAsk != null) withOrders++;
    markets.push({ pk: a.pubkey, cargoId: cargoId, name: cargo[cargoId] || String(cargoId),
      stock: stock, bid: bestBid, ask: bestAsk,
      bids: bids.orders.slice(0, 8), asks: asks.orders.slice(0, 8) });
  }
  markets.sort((x, y) => (y.bid || 0) - (x.bid || 0));

  const out = { updated: new Date().toISOString(), network: "z.ink testnet (PTR)",
    count: markets.length, withOrders: withOrders, markets: markets };
  fs.writeFileSync("c4_markets.json", JSON.stringify(out));
  console.log("Ecrit c4_markets.json :", parsed, "marches parses integralement,",
    withOrders, "avec au moins un ordre.");
  if (withOrders < accounts.length / 2) {
    console.warn("[!] Marche encore tres peu fourni : ces prix ne sont pas exploitables pour optimiser.");
  }
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
