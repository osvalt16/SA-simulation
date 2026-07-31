// scripts/c4-place-sim.js
// Simule la POSE COMPLETE d'une claim stake sur SAGE C4, sans aucune cle.
//
// L'instruction `placeClaimStakeInstanceWithHub` exige un `keyIndex` et la
// validation du profil de joueur : le signataire doit etre une cle enregistree
// sur le profil. En simulation (`sigVerify: false`) il suffit que l'ADRESSE
// soit la bonne — aucune cle privee n'est necessaire.
//
// Les 13 comptes et l'encodage des arguments ont ete releves sur une VRAIE
// transaction de pose passee, plutot que devines :
//   data = disc(8) + keyIndex u16 + claimStakeDefinitionId u16
//          + hubBuildingId u16 + Option<u64> loyer initial
//
//   node scripts/c4-place-sim.js [--body <pubkey>] [--tier N] [--rent N]

const RPC = process.env.ZINK_RPC || "https://testnet-rpc.z.ink";
const C4_SAGE = "C4SAgeKLgb3pTLWhVr6NRwWyYFuTR7ZeSXFrzoLwfMzF";
const DISC_PLACE = "a385796890e23cc7";
const DISC_CLAIM_STAKE = "c8263e33ff9d28a3";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

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
  const raw = Buffer.from(hex, "hex");
  let z = 0; for (const c of str) { if (c === "1") z++; else break; }
  const out = Buffer.concat([Buffer.alloc(z), raw]);
  return out.length >= 32 ? out.subarray(out.length - 32) : Buffer.concat([Buffer.alloc(32 - out.length), out]);
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
function compactU16(n) {
  const out = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); break; } }
  return Buffer.from(out);
}
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
// La pose depasse largement les 200 000 unites de calcul allouees par defaut :
// il FAUT prefixer la transaction d'une demande de budget, sinon elle echoue
// sur "exceeded CUs meter" alors que tout le reste est correct.
function computeBudgetIx(units) {
  const d = Buffer.alloc(5); d[0] = 0x02; d.writeUInt32LE(units, 1);
  return d;
}
function buildTx(keys, blockhash, ixAccountIdx, data, cuLimit) {
  const numSigners = keys.filter((k) => k.signer).length;
  const roSigned = keys.filter((k) => k.signer && !k.writable).length;
  const roUnsigned = keys.filter((k) => !k.signer && !k.writable).length;
  const ixs = [];
  if (cuLimit) {
    ixs.push(Buffer.concat([
      Buffer.from([keys.findIndex((k) => k.pk === COMPUTE_BUDGET)]),
      compactU16(0), compactU16(5), computeBudgetIx(cuLimit),
    ]));
  }
  ixs.push(Buffer.concat([
    Buffer.from([keys.findIndex((k) => k.pk === C4_SAGE)]),
    compactU16(ixAccountIdx.length), Buffer.from(ixAccountIdx),
    compactU16(data.length), data,
  ]));
  const msg = Buffer.concat([Buffer.from([numSigners, roSigned, roUnsigned]),
    compactU16(keys.length), Buffer.concat(keys.map((k) => b58dec(k.pk))),
    b58dec(blockhash), compactU16(ixs.length), Buffer.concat(ixs)]);
  return Buffer.concat([compactU16(numSigners), Buffer.alloc(64 * numSigners), msg]);
}

// Retrouve une transaction de pose passee pour en reprendre les comptes.
async function referencePlacement() {
  const stakes = await rpc("getProgramAccounts", [C4_SAGE, { encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(DISC_CLAIM_STAKE, "hex").toString("base64"), encoding: "base64" } }],
    dataSlice: { offset: 0, length: 0 } }]);
  for (const s of stakes.slice(0, 12)) {
    const sigs = await rpc("getSignaturesForAddress", [s.pubkey, { limit: 10 }]);
    if (!sigs || !sigs.length) continue;
    const tx = await rpc("getTransaction", [sigs[sigs.length - 1].signature,
      { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    if (!tx) continue;
    const msg = tx.transaction.message, keys = msg.accountKeys;
    for (const ix of msg.instructions) {
      if (keys[ix.programIdIndex] !== C4_SAGE) continue;
      const data = b58dec(ix.data).toString("hex");
      const hex = Buffer.from((() => { let n = 0n; for (const c of ix.data) n = n * 58n + BigInt(B58.indexOf(c));
        let h = n.toString(16); if (h.length % 2) h = "0" + h; return h; })(), "hex").toString("hex");
      if (hex.startsWith(DISC_PLACE)) return { keys: ix.accounts.map((i) => keys[i]), hex: hex };
    }
  }
  return null;
}

async function main() {
  console.log("RPC:", RPC, "\n");
  const ref = await referencePlacement();
  if (!ref) throw new Error("aucune transaction de pose retrouvee pour servir de modele");
  console.log("Modele repris d'une pose reelle :", ref.hex);

  const A = ref.keys;   // ordre officiel des 13 comptes
  const [game, signer, profile, certificate, ppProgram, faction, , system, starbasePlayer,
    refBody, character, currencyCache, sysProgram] = A;

  // ── cible : l'emplacement recommande, ou celui passe en argument ──
  const body = argv("--body", refBody);
  const tier = parseInt(argv("--tier", "1"), 10);
  const rent = BigInt(argv("--rent", "5000000000"));   // 50 ATLAS, comme la pose reelle

  // nouvelle parcelle : une adresse qui n'existe pas encore (compte a creer)
  const fresh = b58enc(require("crypto").randomBytes(32));

  console.log("\nParametres de la pose simulee :");
  console.log("   corps celeste :", body, body === refBody ? "(celui du modele)" : "(cible choisie)");
  console.log("   tier          :", tier, "-> definitionId", tier, "et hub", tier);
  console.log("   loyer initial :", Number(rent) / 1e8, "ATLAS");
  console.log("   nouvelle parcelle :", fresh);

  const data = Buffer.concat([
    Buffer.from(DISC_PLACE, "hex"),
    Buffer.from([0, 0]),                                  // keyIndex = 0
    // claimStakeDefinitionId : 1-base, et il doit correspondre au hubValue du
    // hub choisi, sinon le programme repond "hub_value_mismatch".
    Buffer.from([tier & 0xff, (tier >> 8) & 0xff]),
    Buffer.from([tier & 0xff, (tier >> 8) & 0xff]),       // hubBuildingId, meme valeur de hub
    Buffer.from([1]),                                     // Option = Some
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(rent); return b; })(),
  ]);

  const accounts = [
    { pk: game, signer: false, writable: false },
    { pk: signer, signer: true, writable: false },
    { pk: profile, signer: false, writable: true },
    { pk: certificate, signer: false, writable: false },
    { pk: ppProgram, signer: false, writable: false },
    { pk: faction, signer: false, writable: false },
    { pk: fresh, signer: true, writable: true },
    { pk: system, signer: false, writable: false },
    { pk: starbasePlayer, signer: false, writable: true },
    { pk: body, signer: false, writable: true },
    { pk: character, signer: false, writable: true },
    { pk: currencyCache, signer: false, writable: true },
    { pk: sysProgram, signer: false, writable: false },
  ];

  // le payeur de frais doit etre le premier signataire du message
  const uniq = [];
  for (const a of accounts) { const e = uniq.find((x) => x.pk === a.pk);
    if (e) { e.signer = e.signer || a.signer; e.writable = e.writable || a.writable; } else uniq.push({ ...a }); }
  uniq.find((x) => x.pk === signer).writable = true;      // il paie les frais
  uniq.sort((a, b) => (b.signer - a.signer) || (b.writable - a.writable));
  if (!uniq.find((x) => x.pk === C4_SAGE)) uniq.push({ pk: C4_SAGE, signer: false, writable: false });
  uniq.push({ pk: COMPUTE_BUDGET, signer: false, writable: false });
  const idx = accounts.map((a) => uniq.findIndex((x) => x.pk === a.pk));

  const { value: { blockhash } } = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  const CU = parseInt(argv("--cu", "600000"), 10);
  const tx = buildTx(uniq, blockhash, idx, data, CU);
  console.log("\nTransaction :", tx.length, "octets,", uniq.length, "comptes,",
    uniq.filter((k) => k.signer).length, "signataires, budget", CU, "unites");

  const sim = await rpc("simulateTransaction", [tx.toString("base64"),
    { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64", commitment: "processed" }]);
  console.log("\n--- resultat ---");
  if (sim.value.err) {
    console.log("Erreur :", JSON.stringify(sim.value.err));
    for (const l of (sim.value.logs || []).slice(0, 16)) console.log("   ", l);
  } else {
    console.log("ACCEPTEE — la pose est valide telle quelle.");
    console.log("Unites de calcul :", sim.value.unitsConsumed);
    for (const l of (sim.value.logs || []).slice(0, 10)) console.log("   ", l);
  }
  console.log("\nAucune cle n'a ete utilisee : simulation uniquement.");
}

main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });
