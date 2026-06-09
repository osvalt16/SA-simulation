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
// On ne garde que les ordres en USDC (comme le prix d'origine et l'affichage $ du marche)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TOP = 8; // nb de vendeurs/acheteurs gardes par objet

function isSell(o) {
  return String(o.orderType || o.side || "").toLowerCase().indexOf("sell") >= 0;
}
function isBuy(o) {
  return String(o.orderType || o.side || "").toLowerCase().indexOf("buy") >= 0;
}
function priceOf(o) {
  // uiPrice = prix humain (ex 207.0). Sinon on tente price/decimales.
  if (typeof o.uiPrice === "number") return o.uiPrice;
  if (o.price != null) { const n = Number(o.price); if (!isNaN(n)) return n / 1e6; }
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
    if (currOf(o) !== USDC_MINT) continue;
    const sym = mintToSymbol[mintOf(o)];
    if (!sym) continue;
    const p = priceOf(o);
    if (p == null) continue;
    if (!bySym[sym]) bySym[sym] = { sellers: [], buyers: [] };
    const row = { p: p, q: qtyOf(o), c: "USDC" };
    if (isSell(o)) bySym[sym].sellers.push(row);
    else if (isBuy(o)) bySym[sym].buyers.push(row);
  }

  // Trie : vendeurs prix croissant (meilleur = le moins cher), acheteurs prix decroissant
  const prices = {};
  let kept = 0;
  for (const sym in bySym) {
    const s = bySym[sym].sellers.sort((a, b) => a.p - b.p).slice(0, TOP);
    const b = bySym[sym].buyers.sort((a, b) => b.p - a.p).slice(0, TOP);
    if (s.length || b.length) { prices[sym] = { sellers: s, buyers: b }; kept++; }
  }

  const out = { updated: new Date().toISOString(), count: kept, prices: prices };
  fs.writeFileSync("market_prices.json", JSON.stringify(out));
  console.log("Ecrit market_prices.json :", kept, "objets avec des ordres.");
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
