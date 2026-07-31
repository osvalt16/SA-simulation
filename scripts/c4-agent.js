// scripts/c4-agent.js
// Agent autonome SAGE C4 — boucle d'observation et de decision.
//
//   node scripts/c4-agent.js --profile <adresse de ton profil>
//   node scripts/c4-agent.js --profile <adresse> --once     (un seul passage)
//
// Ce qu'il fait, en continu et sans aucune cle :
//   1. surveille la chaine en TEMPS REEL (WebSocket programSubscribe)
//   2. scanne l'etat de TA partie : profil, flottes, claim stakes, production
//   3. suit l'activite de TOUS les joueurs et les marches galactiques
//   4. hierarchise les actions a faire et les journalise
//
// Ce qu'il ne fait PAS encore : signer et envoyer. Chaque decision est donc
// affichee et enregistree dans c4_agent_state.json, prete a etre executee
// des que la couche de signature sera branchee (cle deleguee, locale).
//
// Ordre de priorite des decisions, du plus urgent au moins urgent :
//   1. loyer bas          -> risque de perdre la parcelle (irreversible)
//   2. production dormante -> manivelle publique, gratuite, gain immediat
//   3. flotte immobile     -> capital qui ne travaille pas
//   4. opportunite de pose -> croissance

const fs = require("fs");
const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const WS = RPC.replace(/^http/, "ws");
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const STATE_FILE = "c4_agent_state.json";

const DISC = {
  claimStakeInstance: "c8263e33ff9d28a3",
  fleet: "6dcffb306a0288a3",
  starbasePlayer: "c0ea905648130563",
  localMarket: "1cf2d61d5e73a799",
  starSystem: "cf207b0909fbdda9",
};

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PROFILE = argv("--profile", process.env.C4_PROFILE || null);
const ONCE = args.includes("--once");
const INTERVAL = parseInt(argv("--interval", "300"), 10) * 1000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
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
const b64disc = (hex) => Buffer.from(hex, "hex").toString("base64");
async function accountsOf(disc, slice) {
  const cfg = { encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: b64disc(disc), encoding: "base64" } }] };
  if (slice) cfg.dataSlice = slice;
  return rpc("getProgramAccounts", [C4_SAGE, cfg]);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── etat persistant, pour detecter ce qui bouge entre deux passages ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return { runs: 0, seen: {}, actions: [], history: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

// ── 1. scan de la partie du joueur ──
async function scanPlayer(profile) {
  const out = { profile: profile, stakes: [], starbases: 0 };
  const stakes = await accountsOf(DISC.claimStakeInstance);
  const now = Math.floor(Date.now() / 1000);
  for (const a of stakes) {
    const d = Buffer.from(a.account.data[0], "base64");
    const owner = b58enc(d.subarray(9, 41));
    if (profile && owner !== profile) continue;
    // solde de loyer et derniere production, aux offsets releves on-chain
    const rentBalance = Number(d.readBigUInt64LE(8 + 1 + 96 + 2 + 4 + 4 + 8 + 8 + 8 + 8));
    let lastTick = 0;
    for (let o = d.length - 8; o > 150; o--) {
      const v = Number(d.readBigInt64LE(o));
      if (v > 1.7e9 && v < now + 86400) { lastTick = v; break; }
    }
    out.stakes.push({ pk: a.pubkey, owner: owner, rentBalance: rentBalance,
      lastTick: lastTick, idleHours: lastTick ? (now - lastTick) / 3600 : null });
  }
  return out;
}

// ── 2. etat global du jeu ──
async function scanWorld() {
  const [stakes, sbp, markets] = await Promise.all([
    accountsOf(DISC.claimStakeInstance, { offset: 0, length: 0 }),
    accountsOf(DISC.starbasePlayer, { offset: 0, length: 0 }),
    accountsOf(DISC.localMarket),
  ]);
  let withOrders = 0;
  for (const m of markets) {
    const d = Buffer.from(m.account.data[0], "base64");
    if (d.length > 132) withOrders++;      // carnet non vide
  }
  return { claimStakes: stakes.length, players: sbp.length,
    markets: markets.length, marketsActive: withOrders };
}

// ── 3. decisions, par ordre d'urgence ──
function decide(player, world) {
  const acts = [];
  for (const s of player.stakes) {
    if (s.rentBalance < 1e9) {
      acts.push({ p: 1, kind: "loyer", target: s.pk,
        why: `solde ${(s.rentBalance / 1e8).toFixed(1)} ATLAS — risque d'expulsion`,
        ix: "claimStakesRentTopUp" });
    }
    if (s.idleHours != null && s.idleHours > 6) {
      acts.push({ p: 2, kind: "production", target: s.pk,
        why: `production dormante depuis ${s.idleHours.toFixed(0)} h`,
        ix: "claimStakesResourceProduction (manivelle publique, sans permission)" });
    }
  }
  if (!player.stakes.length) {
    acts.push({ p: 4, kind: "expansion", target: null,
      why: "aucune claim stake detectee sur ce profil",
      ix: "placeClaimStakeInstanceWithHub — voir c4-optimizer.js pour la cible" });
  }
  acts.sort((a, b) => a.p - b.p);
  return acts;
}

// ── 4. surveillance temps reel ──
function watch(onChange) {
  let ws, tries = 0;
  const connect = () => {
    try { ws = new WebSocket(WS); } catch (e) { return; }
    ws.onopen = () => {
      tries = 0;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "programSubscribe",
        params: [C4_SAGE, { encoding: "base64",
          filters: [{ memcmp: { offset: 0, bytes: b64disc(DISC.starSystem), encoding: "base64" } }] }] }));
      log("temps reel : abonne aux changements de systemes");
    };
    ws.onmessage = (e) => {
      const j = JSON.parse(e.data);
      if (j.method === "programNotification") onChange(j.params.result.value.pubkey);
    };
    ws.onclose = () => {
      const wait = Math.min(60000, 5000 * 2 ** Math.min(tries++, 4));
      log(`temps reel interrompu, nouvelle tentative dans ${wait / 1000} s`);
      setTimeout(connect, wait);
    };
    ws.onerror = () => {};
  };
  connect();
}

async function cycle(state) {
  state.runs++;
  const world = await scanWorld();
  log(`monde : ${world.claimStakes} claim stakes, ${world.players} joueurs, ` +
      `${world.marketsActive}/${world.markets} marches actifs`);

  if (!PROFILE) {
    log("aucun profil fourni (--profile) : scan global uniquement.");
    log("   -> passe ton adresse de profil pour obtenir des decisions personnalisees.");
  } else {
    const player = await scanPlayer(PROFILE);
    log(`ta partie : ${player.stakes.length} claim stake(s)`);
    const acts = decide(player, world);
    if (!acts.length) log("rien a faire : tout est a jour.");
    for (const a of acts) {
      log(`  [P${a.p}] ${a.kind.toUpperCase()} — ${a.why}`);
      log(`         action : ${a.ix}${a.target ? "  sur " + a.target.slice(0, 12) + "…" : ""}`);
    }
    state.actions = acts;
  }
  state.history.push({ t: new Date().toISOString(), world: world });
  if (state.history.length > 500) state.history = state.history.slice(-500);
  saveState(state);
}

async function main() {
  console.log("Agent SAGE C4 — observation et decision\n");
  log("RPC:", RPC);
  const state = loadState();

  if (!ONCE && typeof WebSocket !== "undefined") {
    let pending = 0;
    watch(() => { pending++; });
    setInterval(() => {
      if (pending) { log(`temps reel : ${pending} systeme(s) modifie(s) depuis le dernier point`); pending = 0; }
    }, 60000);
  }

  await cycle(state);
  if (ONCE) { log("passage unique termine."); process.exit(0); }
  log(`prochain passage dans ${INTERVAL / 1000} s — Ctrl+C pour arreter`);
  setInterval(() => cycle(state).catch((e) => log("erreur de cycle :", e.message)), INTERVAL);
}

main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });
