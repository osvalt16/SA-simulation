// scripts/fetch-rentals.js
// Lit les contrats de location de flottes SRSLY (Star Atlas Fleet Rentals) ON-CHAIN
// et ecrit rentals_data.json a la racine du depot (lu par index.html, meme origine).
//
// Aucune dependance npm : decodage manuel des comptes Anchor via JSON-RPC.
// Layout ContractState (228 octets, verifie on-chain le 2026-07-10) :
//   8  discriminator sha256("account:ContractState")[0..8]
//   1  version u8
//   1  to_close bool
//   8  rate u64            <- ATLAS par jour (entier, pas de decimales)
//   8  duration_min u64    <- jours
//   8  duration_max u64    <- jours
//   1  payments_feq u8
//   32 fleet, 32 game_id, 32 current_rental_state, 32 owner,
//   32 owner_token_account, 32 owner_profile, 1 bump
// current_rental_state = SystemProgram (que des zeros) quand la flotte est libre.
// Le nom de flotte (fleet_label, 32 octets zero-padded) est a l'offset 170 du
// compte Fleet du programme SAGE.
//
// Lance par .github/workflows/update-rentals.yml. SOLANA_RPC optionnel :
// le RPC public accepte getProgramAccounts sur ce petit programme.

const fs = require("fs");
const crypto = require("crypto");

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SRSLY = "SRSLY1fq9TJqCk1gNSE7VZL2bztvTn9wm4VR8u8jMKT";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

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

function discriminator(name) {
  return crypto.createHash("sha256").update("account:" + name).digest().slice(0, 8);
}

async function main() {
  console.log("RPC:", RPC.replace(/(api-key=)[^&]+/i, "$1***"));

  const disc = discriminator("ContractState").toString("base64");
  const accounts = await rpc("getProgramAccounts", [SRSLY, {
    encoding: "base64",
    filters: [
      { memcmp: { offset: 0, bytes: disc, encoding: "base64" } },
      { dataSize: 228 },
    ],
  }]);
  console.log("Contrats bruts:", accounts.length);

  const rentals = [];
  for (const a of accounts) {
    const d = Buffer.from(a.account.data[0], "base64");
    if (d[9]) continue; // to_close : contrat en cours de fermeture, on ignore
    const rate = Number(d.readBigUInt64LE(10));
    const min = Number(d.readBigUInt64LE(18));
    const max = Number(d.readBigUInt64LE(26));
    if (rate <= 0) continue;
    rentals.push({
      contract: a.pubkey,
      fleet: b58(d.subarray(35, 67)),
      rate: rate,                                  // ATLAS / jour
      min: min, max: max,                          // jours
      free: b58(d.subarray(99, 131)) === SYSTEM_PROGRAM,
      owner: b58(d.subarray(131, 163)),
    });
  }
  console.log("Contrats actifs:", rentals.length);

  // Nom de flotte : fleet_label a l'offset 170 des comptes Fleet (SAGE), par lots de 100
  const fleetKeys = [...new Set(rentals.map((r) => r.fleet))];
  const labels = {};
  for (let i = 0; i < fleetKeys.length; i += 100) {
    const batch = fleetKeys.slice(i, i + 100);
    try {
      const res = await rpc("getMultipleAccounts", [batch, { encoding: "base64" }]);
      res.value.forEach((acc, k) => {
        if (!acc || !acc.data) return;
        const d = Buffer.from(acc.data[0], "base64");
        if (d.length < 202) return;
        const label = d.subarray(170, 202).toString("utf8").replace(/\0+$/, "").trim();
        if (label && /^[\x20-\x7e]+$/.test(label)) labels[batch[k]] = label;
      });
    } catch (e) {
      console.warn("getMultipleAccounts lot", i, ":", e.message);
    }
    await new Promise((r) => setTimeout(r, 250)); // menage le rate-limit du RPC public
  }
  for (const r of rentals) r.label = labels[r.fleet] || null;
  console.log("Labels resolus:", Object.keys(labels).length, "/", fleetKeys.length);

  rentals.sort((x, y) => x.rate - y.rate);
  const out = {
    updated: new Date().toISOString(),
    count: rentals.length,
    freeCount: rentals.filter((r) => r.free).length,
    rentals: rentals,
  };
  fs.writeFileSync("rentals_data.json", JSON.stringify(out));
  console.log("Ecrit rentals_data.json :", out.count, "contrats dont", out.freeCount, "libres.");
}

main().catch((e) => { console.error("ERREUR:", e); process.exit(1); });
