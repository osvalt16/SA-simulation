// scripts/c4-bot.js
// Premiere brique d'execution du bot SAGE C4.
//
// Construit une vraie transaction `claimStakesResourceProduction` (la
// manivelle de production) et la SIMULE sur la chaine. Cette instruction n'a
// pas de `keyIndex` : elle est permissionless, donc elle sert de test ideal
// pour valider tout l'encodage sans detenir la moindre cle.
//
//   node scripts/c4-bot.js            -> simule (aucune cle, aucun envoi)
//   node scripts/c4-bot.js --send     -> refuse : voir la note en bas
//
// Encodage manuel du format de transaction Solana, sans dependance npm :
// message legacy = en-tete(3) + cles(compact) + blockhash(32) + instructions.
//
// SECURITE : ce script n'ouvre, ne lit et ne demande AUCUNE cle privee.
// L'envoi reel devra se faire avec une cle DELEGUEE ajoutee au profil de
// joueur, limitee aux permissions de jeu et sans droit de retrait, stockee
// uniquement sur ta machine.

const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DISC = {
  claimStakeInstance: "c8263e33ff9d28a3",
  production: "aef795c5b9ff1466",
};

// ── base58 ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let z = 0; for (const b of buf) { if (b === 0) z++; else break; }
  return "1".repeat(z) + s;
}
function b58dec(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error("base58: " + c); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let buf = Buffer.from(hex, "hex");
  let z = 0; for (const c of str) { if (c === "1") z++; else break; }
  return Buffer.concat([Buffer.alloc(z), buf]).subarray(-(32));
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
async function gpa(disc, extra) {
  return rpc("getProgramAccounts", [C4_SAGE, Object.assign({
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(disc, "hex").toString("base64"), encoding: "base64" } }],
  }, extra || {})]);
}

// ── encodage compact-u16 (format Solana) ──
function compactU16(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); break; } }
  return Buffer.from(out);
}

// Construit un message legacy. `keys` = [{pk, signer, writable}] deja ordonne.
function buildMessage(keys, blockhash, progId, ixAccountIdx, data) {
  const numSigners = keys.filter((k) => k.signer).length;
  const numReadonlySigned = keys.filter((k) => k.signer && !k.writable).length;
  const numReadonlyUnsigned = keys.filter((k) => !k.signer && !k.writable).length;
  const header = Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]);
  const keyBytes = Buffer.concat(keys.map((k) => b58dec(k.pk)));
  const ix = Buffer.concat([
    Buffer.from([keys.findIndex((k) => k.pk === progId)]),
    compactU16(ixAccountIdx.length), Buffer.from(ixAccountIdx),
    compactU16(data.length), data,
  ]);
  return Buffer.concat([header, compactU16(keys.length), keyBytes, b58dec(blockhash),
    compactU16(1), ix]);
}

async function main() {
  if (process.argv.includes("--send")) {
    console.error("Envoi refuse : ce script ne manipule aucune cle privee.");
    console.error("Voir docs/C4-BOT.md, section securite (cle deleguee, execution locale).");
    process.exit(2);
  }
  console.log("RPC:", RPC, "\n");

  // ── 1. une claim stake existante et ses comptes lies ──
  const stakes = await gpa(DISC.claimStakeInstance);
  if (!stakes.length) throw new Error("aucune claim stake trouvee (discriminant a verifier)");
  const d = Buffer.from(stakes[0].account.data[0], "base64");
  const claimStakeInstance = stakes[0].pubkey;
  const profile = b58enc(d.subarray(9, 41));          // owner
  const gameId = b58enc(d.subarray(41, 73));
  const celestialBody = b58enc(d.subarray(73, 105));
  console.log("Claim stake  :", claimStakeInstance);
  console.log("Profil       :", profile);
  console.log("Corps celeste:", celestialBody);

  // ── 2. le systeme, lu dans le compte du corps celeste ──
  const cb = await rpc("getAccountInfo", [celestialBody, { encoding: "base64" }]);
  const cbd = Buffer.from(cb.value.data[0], "base64");
  const starSystem = b58enc(cbd.subarray(107, 139));
  console.log("Systeme      :", starSystem);

  // ── 3. le StarbasePlayer correspondant (profil + systeme) ──
  const sbp = await gpa("c0ea905648130563");
  let starbasePlayer = null;
  for (const a of sbp) {
    const s = Buffer.from(a.account.data[0], "base64");
    if (b58enc(s.subarray(9, 41)) === profile && b58enc(s.subarray(42, 74)) === starSystem) {
      starbasePlayer = a.pubkey; break;
    }
  }
  if (!starbasePlayer) { starbasePlayer = sbp.length ? sbp[0].pubkey : null; console.log("(StarbasePlayer exact non trouve, on prend le premier pour la simulation)"); }
  console.log("StarbasePlayer:", starbasePlayer);

  // ── 4. le cache de devises ──
  // Il existe un cache de devises PAR PARTIE : prendre le mauvais fait
  // echouer la validation avec "Game mismatch". On retient celui dont les
  // donnees contiennent l'identifiant de la partie de la claim stake.
  const cc = await gpa("e7cb8e6cd2ea07bf");
  const gameBytes = b58dec(gameId);
  let currencyCache = null;
  for (const a of cc) {
    if (Buffer.from(a.account.data[0], "base64").includes(gameBytes)) { currencyCache = a.pubkey; break; }
  }
  if (!currencyCache && cc.length) currencyCache = cc[0].pubkey;
  console.log("CurrencyCache :", currencyCache || "(introuvable)");

  // ── 5. assemblage de la transaction ──
  // Payeur : pour SIMULER, le compte doit exister sur la chaine. On prend par
  // defaut un payeur de frais observe dans une transaction recente du
  // programme. En execution reelle, ce sera ta propre cle deleguee.
  const funder = process.env.C4_FUNDER || "2o44i6gbAsp5s7DLU52WtiVAqoiZzkQgy4CyuV1FcUbc";
  const accounts = [
    { pk: funder, signer: true, writable: true },
    { pk: profile, signer: false, writable: true },
    { pk: claimStakeInstance, signer: false, writable: true },
    { pk: celestialBody, signer: false, writable: true },
    { pk: starSystem, signer: false, writable: false },
    { pk: starbasePlayer, signer: false, writable: false },
    { pk: currencyCache, signer: false, writable: true },
    { pk: gameId, signer: false, writable: false },
    { pk: SYSTEM_PROGRAM, signer: false, writable: false },
  ];
  if (accounts.some((a) => !a.pk)) throw new Error("un compte requis est manquant");

  // cles du message : signataires-modifiables, puis modifiables, puis lecture seule, + programme
  const uniq = [];
  for (const a of accounts) if (!uniq.find((x) => x.pk === a.pk)) uniq.push(a);
  uniq.sort((a, b) => (b.signer - a.signer) || (b.writable - a.writable));
  if (!uniq.find((x) => x.pk === C4_SAGE)) uniq.push({ pk: C4_SAGE, signer: false, writable: false });
  const idx = accounts.map((a) => uniq.findIndex((x) => x.pk === a.pk));

  const { value: { blockhash } } = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  const msg = buildMessage(uniq, blockhash, C4_SAGE, idx, Buffer.from(DISC.production, "hex"));
  const tx = Buffer.concat([compactU16(1), Buffer.alloc(64), msg]);   // 1 signature vide
  console.log("\nTransaction construite :", tx.length, "octets,", uniq.length, "comptes");

  // ── 6. simulation sur la chaine, sans signature ──
  const sim = await rpc("simulateTransaction", [tx.toString("base64"),
    { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64", commitment: "processed" }]);
  console.log("\n--- resultat de la simulation ---");
  if (sim.value.err) {
    console.log("Erreur :", JSON.stringify(sim.value.err));
    console.log("Journal du programme :");
    for (const l of (sim.value.logs || []).slice(0, 14)) console.log("   ", l);
  } else {
    console.log("ACCEPTEE — l'encodage et les comptes sont corrects.");
    console.log("Unites de calcul :", sim.value.unitsConsumed);
    for (const l of (sim.value.logs || []).slice(0, 8)) console.log("   ", l);
  }
}

main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });
