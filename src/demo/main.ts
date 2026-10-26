// One-command demo: `npm run demo` (needs a running sandbox, see README).
// Plays one standing agreement end to end, then runs hostile agents against it.
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetAgreementContract } from "../artifacts/RelnetAgreement.js";
import { RelnetCoinContract } from "../artifacts/RelnetCoin.js";
import { RelnetEscrowContract } from "../artifacts/RelnetEscrow.js";
import { RelnetPerformanceProofContract } from "../artifacts/RelnetPerformanceProof.js";
import { getSponsoredFeePaymentMethod } from "../utils/sponsored_fee.js";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const SHIP_BY = 4102444800n; // year 2100: shipments count as on time
const PRICE = 500n;
const VOL_MIN = 10n;
const VOL_MAX = 100n;

const fmt = (n: bigint) => `${n} cents ($${(Number(n) / 100).toFixed(2)})`;
const step = (s: string) => console.log(`\n▶ ${s}`);
const note = (s: string) => console.log(`    ${s}`);

async function timed<T>(label: string, fn: () => Promise<T>, lat: number[]): Promise<T> {
  const t = Date.now();
  const r = await fn();
  const ms = Date.now() - t;
  lat.push(ms);
  note(`${label}  [${(ms / 1000).toFixed(1)}s]`);
  return r;
}

interface Attack {
  name: string;
  baseline: string; // what a trust-the-agent ledger does
  run: () => Promise<unknown>;
}

async function main() {
  console.log("relnet demo: governed settlement for a long-term supplier-buyer relationship");
  console.log("Testnet only. Fictional entities. No real funds.\n");

  const wallet = await EmbeddedWallet.create(createAztecNodeClient(NODE_URL), { ephemeral: true });
  const pm = await getSponsoredFeePaymentMethod(wallet as any);
  const opts = (from: AztecAddress) => ({ from, fee: { paymentMethod: pm } });
  const acct = async (d: any) => (await wallet.createSchnorrInitializerlessAccount(d.secret, d.salt, d.signingKey)).address;

  const base = await getInitialTestAccountsData();
  const buyer = await acct(base[0]); // Lone Star Assembly (fictional)
  const supplier = await acct(base[1]); // Trinity Castings (fictional)
  const carrier = await acct(base[2]); // Panhandle Freight (fictional)
  const [mallData, arbData] = await generateSchnorrAccounts(2);
  const mallory = await acct(mallData); // hostile agent
  const arbiter = await acct(arbData);
  const lat: number[] = [];

  step("1. Deploy contracts (token, performance proof, escrow, framework agreement)");
  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(opts(buyer));
  const { contract: pp } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(opts(buyer));
  const { contract: escrow } = await RelnetEscrowContract.deploy(wallet, token.address, arbiter, pp.address).send(opts(buyer));
  await pp.methods.set_escrow(escrow.address).send(opts(buyer));
  const { contract: agreement } = await RelnetAgreementContract.deploy(wallet, buyer, supplier, PRICE, VOL_MIN, VOL_MAX).send(opts(buyer));
  await token.methods.mint_publicly(buyer, 1_000_000n).send(opts(buyer));
  note(`Agreement: ${fmt(PRICE)} per unit, volume band ${VOL_MIN}-${VOL_MAX}. Enforced by the contract, not by any agent.`);

  const bal = async (a: AztecAddress) => (await token.methods.balance_of(a).simulate({ from: buyer })).result as bigint;

  step("2. Standing agreement: three call-offs in band, each escrowed and settled 30/50/20");
  for (let i = 1n; i <= 3n; i++) {
    const qty = 20n * i;
    const amount = qty * PRICE;
    note(`Call-off ${i}: ${qty} units = ${fmt(amount)}`);
    await timed("place_call_off (checked on-chain)", () => agreement.methods.place_call_off(qty, PRICE).send(opts(buyer)), lat);
    await token.methods.transfer_public(escrow.address, amount).send(opts(buyer));
    await escrow.methods.fund_call_off(i, supplier, carrier, amount, SHIP_BY).send(opts(buyer));
    await escrow.methods.attest_shipped(i).send(opts(supplier));
    await timed("shipped (supplier + carrier)", () => escrow.methods.attest_shipped(i).send(opts(carrier)), lat);
    note(`  supplier balance: ${fmt(await bal(supplier))} (30% released)`);
    await escrow.methods.attest_received(i).send(opts(buyer));
    await escrow.methods.attest_received(i).send(opts(carrier));
    note(`  supplier balance: ${fmt(await bal(supplier))} (50% more released)`);
    await escrow.methods.attest_inspected(i).send(opts(buyer));
    note(`  supplier balance: ${fmt(await bal(supplier))} (remaining 20% released, call-off closed)`);
  }
  const expected = 20n * PRICE * (1n + 2n + 3n);
  note(`Total paid to supplier: ${fmt(await bal(supplier))}; expected ${fmt(expected)}: ${(await bal(supplier)) === expected ? "match" : "MISMATCH"}`);

  step("3. Zero-knowledge proof: supplier proves on-time rate without revealing deliveries");
  await token.methods.transfer_public(buyer, 0n).send(opts(buyer)); // let outcomes settle
  for (let i = 1n; i <= 3n; i++) await pp.methods.absorb_outcome(i, true).send(opts(supplier));
  note("Supplier folded 3 verified outcomes into one private note (counts stay off-chain).");
  await timed("prove_on_time_rate(95)", () => pp.methods.prove_on_time_rate(95n).send(opts(supplier)), lat);
  const proven = (await pp.methods.get_proven_threshold(supplier).simulate({ from: buyer })).result;
  note(`Public record: supplier proved >= ${proven}% on time. Counts, dates, quantities: not revealed.`);

  step("4. Hostile agents attack the same deployment");
  const attacks: Attack[] = [
    { name: "Out-of-band quantity (9999 units)", baseline: "accepted", run: () => agreement.methods.place_call_off(9999n, PRICE).send(opts(supplier)) },
    { name: "Off-contract price (1 cent)", baseline: "accepted", run: () => agreement.methods.place_call_off(50n, 1n).send(opts(supplier)) },
    { name: "Third party places a call-off", baseline: "accepted", run: () => agreement.methods.place_call_off(50n, PRICE).send(opts(mallory)) },
    { name: "Non-admin mints tokens", baseline: "accepted", run: () => token.methods.mint_publicly(mallory, 1_000_000n).send(opts(mallory)) },
    { name: "Forged on-time outcome", baseline: "accepted", run: () => pp.methods.record_outcome(99n, true).send(opts(mallory)) },
    { name: "Fund a call-off with no tokens sent", baseline: "accepted", run: () => escrow.methods.fund_call_off(50n, supplier, carrier, 5000n, SHIP_BY).send(opts(buyer)) },
    { name: "Release escrow before inspection by non-buyer", baseline: "accepted", run: () => escrow.methods.attest_inspected(1n).send(opts(mallory)) },
    { name: "Re-use a closed call-off", baseline: "accepted", run: () => escrow.methods.attest_shipped(1n).send(opts(mallory)) },
    { name: "Arbiter ruling by non-arbiter", baseline: "accepted", run: () => escrow.methods.arbiter_resolve(2n, mallory, 100n).send(opts(mallory)) },
    { name: "Absorb the same outcome twice", baseline: "accepted", run: () => pp.methods.absorb_outcome(1n, true).send(opts(supplier)) },
    { name: "Absorb an outcome the escrow never recorded", baseline: "accepted", run: () => pp.methods.absorb_outcome(77n, true).send(opts(supplier)) },
  ];
  let blocked = 0;
  console.log("\n    attack                                              baseline ledger   relnet");
  for (const a of attacks) {
    let result = "BLOCKED";
    try {
      await a.run();
      result = "ACCEPTED";
    } catch {
      blocked++;
    }
    console.log(`    ${a.name.padEnd(52)}${a.baseline.padEnd(18)}${result}`);
  }
  note(`\nrelnet blocked ${blocked}/${attacks.length}. The baseline is a trust-the-agent ledger with no on-chain rules, which accepts all ${attacks.length} (modeled, not run).`);

  const sorted = [...lat].sort((a, b) => a - b);
  step("5. Measured on this machine (local sandbox; proving mode not verified, so treat as execution latency)");
  note(`${lat.length} timed transactions: median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s, max ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`);
  note("Numbers are from one run on one laptop; they are not a benchmark.");

  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
