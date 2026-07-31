// scripts/fetch-prices.js
// Lit le carnet d'ordres ON-CHAIN du Galactic Marketplace (Star Atlas) et ecrit
// market_prices.json a la racine du depot. Lu ensuite par index.html (meme origine,
// donc aucun blocage CORS sur GitHub Pages).
//
// Lance par la GitHub Action .github/workflows/update-prices.yml
// Necessite la variable secrete SOLANA_RPC (une URL RPC qui autorise getProgramAccounts,
// ex. un endpoint gratuit Helius). Le RPC public mainnet-beta refuse cette requete.

const fs = require("fs");
const { Connection, PublicKey } = require("@solana/web3.js");
const { GmClientService } = require("@staratlas/factory");

// Programme du Galactic Marketplace (mainnet)
const GM_PROGRAM_ID = new PublicKey("traderDnaR5w6Tcoi3NFm53i48FTDNbGjBSZwWXDRrg");
// Deux devises sont cotees sur le Galactic Marketplace. Les vaisseaux et
// structures se negocient surtout en USDC, mais les RESSOURCES BRUTES se
// negocient en ATLAS : ne garder que l'USDC les faisait toutes disparaitre.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATLAS_MINT = "ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx";
const DECIMALS = { USDC: 6, ATLAS: 8 };   // ATLAS a 8 decimales, pas 6
function currencyOf(o) {
  const c = currOf(o);
  if (c === USDC_MINT) return "USDC";
  if (c === ATLAS_MINT) return "ATLAS";
  return null;
}

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TOP = 8; // nb de vendeurs/acheteurs gardes par objet

function isSell(o) {
  return String(o.orderType || o.side || "").toLowerCase().indexOf("sell") >= 0;
}
function isBuy(o) {
  return String(o.orderType || o.side || "").toLowerCase().indexOf("buy") >= 0;
}
function priceOf(o, cur) {
  // uiPrice = prix humain (ex 207.0). Sinon on divise par les decimales de la
  // devise : 6 pour l'USDC, 8 pour l'ATLAS (s'y tromper fausse tout d'un facteur 100).
  if (typeof o.uiPrice === "number") return o.uiPrice;
  if (o.price != null) {
    const n = Number(o.price);
    if (!isNaN(n)) return n / Math.pow(10, DECIMALS[cur] || 6);
  }
  return null;
}
function qtyOf(o) {
  const q = o.orderQtyRemaining != null ? o.orderQtyRemaining
          : (o.orderOriginationQty != null ? o.orderOriginationQty : o.quantity);
  const n = Number(q); return isNaN(n) ? 1 : n;
}
function mintOf(o) { return String(o.orderMint || o.itemMint || o.assetMint || ""); }
function currOf(o) { return String(o.currencyMint || o.quoteMint || ""); }

async function loadCatalog() {
  // mint -> symbol pour TOUS les objets du catalogue : vaisseaux, pieces, structures, etc.
  // (avant on ne gardait que les vaisseaux/pieces, ce qui faisait disparaitre les
  //  ordres des structures comme les Claim Stakes ou les Power Plants).
  const res = await fetch("https://galaxy.staratlas.com/nfts");
  const list = await res.json();
  const map = {};
  for (const n of list) {
    if (!n || !n.mint || !n.symbol) continue;
    map[String(n.mint)] = n.symbol;
  }
  return map;
}

async function main() {
  if (!process.env.SOLANA_RPC) {
    console.warn("[!] SOLANA_RPC absent : utilisation du RPC public, qui refuse en general getProgramAccounts. Ajoute un secret SOLANA_RPC (ex. Helius gratuit).");
  }
  console.log("RPC:", RPC.replace(/(api-key=)[^&]+/i, "$1***"));

  const mintToSymbol = await loadCatalog();
  console.log("Catalogue: ", Object.keys(mintToSymbol).length, "objets mappes (vaisseaux, pieces, structures...)");

  const connection = new Connection(RPC, "confirmed");
  const gm = new GmClientService();

  console.log("Lecture des ordres on-chain (getAllOpenOrders)...");
  const orders = await gm.getAllOpenOrders(connection, GM_PROGRAM_ID);
  console.log("Ordres recus:", orders.length);

  // Regroupe par symbole connu, en USDC seulement
  const bySym = {};
  for (const o of orders) {
    const cur = currencyOf(o);
    if (!cur) continue;
    const sym = mintToSymbol[mintOf(o)];
    if (!sym) continue;
    const p = priceOf(o, cur);
    if (p == null) continue;
    if (!bySym[sym]) bySym[sym] = { sellers: [], buyers: [], sellersAtlas: [], buyersAtlas: [] };
    const row = { p: p, q: qtyOf(o), c: cur };
    // Les deux carnets restent SEPARES : melanger des prix en USDC et en ATLAS
    // dans une meme liste triee n'aurait aucun sens.
    const sell = cur === "ATLAS" ? "sellersAtlas" : "sellers";
    const buy = cur === "ATLAS" ? "buyersAtlas" : "buyers";
    if (isSell(o)) bySym[sym][sell].push(row);
    else if (isBuy(o)) bySym[sym][buy].push(row);
  }

  // Trie : vendeurs prix croissant (meilleur = le moins cher), acheteurs prix decroissant
  const prices = {};
  let kept = 0;
  for (const sym in bySym) {
    const e = bySym[sym];
    const s = e.sellers.sort((a, b) => a.p - b.p).slice(0, TOP);
    const b = e.buyers.sort((a, b) => b.p - a.p).slice(0, TOP);
    const sa = e.sellersAtlas.sort((a, b) => a.p - b.p).slice(0, TOP);
    const ba = e.buyersAtlas.sort((a, b) => b.p - a.p).slice(0, TOP);
    if (s.length || b.length || sa.length || ba.length) {
      const row = { sellers: s, buyers: b };
      if (sa.length) row.sellersAtlas = sa;
      if (ba.length) row.buyersAtlas = ba;
      prices[sym] = row;
      kept++;
    }
  }

  const out = { updated: new Date().toISOString(), count: kept, prices: prices };
  fs.writeFileSync("market_prices.json", JSON.stringify(out));
  console.log("Ecrit market_prices.json :", kept, "objets avec des ordres.");

  // --- price_history.json : meilleur vendeur/acheteur par objet a chaque run ---
  // Format : { updated, points: { SYM: [[unixSec, bestSell, bestBuy], ...] } }
  // Garde ~7 jours de points (le fichier est lu par index.html pour les sparklines).
  const MAX_PTS = 336; // 7 jours a 1 point / 30 min
  let hist = { points: {} };
  try { hist = JSON.parse(fs.readFileSync("price_history.json", "utf8")); } catch (e) {}
  if (!hist.points) hist.points = {};
  const t = Math.floor(Date.now() / 1000);
  const r5 = (v) => (v == null ? null : Number(Number(v).toPrecision(5)));
  for (const sym in prices) {
    const s = prices[sym].sellers, b = prices[sym].buyers;
    if (!hist.points[sym]) hist.points[sym] = [];
    hist.points[sym].push([t, r5(s.length ? s[0].p : null), r5(b.length ? b[0].p : null)]);
    if (hist.points[sym].length > MAX_PTS) hist.points[sym] = hist.points[sym].slice(-MAX_PTS);
  }
  hist.updated = out.updated;
  fs.writeFileSync("price_history.json", JSON.stringify(hist));
  console.log("Ecrit price_history.json :", Object.keys(hist.points).length, "objets.");
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
