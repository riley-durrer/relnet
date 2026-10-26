import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetCoinContract } from "../../artifacts/RelnetCoin.js";
import { RelnetEscrowContract } from "../../artifacts/RelnetEscrow.js";
import { RelnetPerformanceProofContract } from "../../artifacts/RelnetPerformanceProof.js";
import { check, assertRejects, assertEqual, finish } from "./check.js";
import { getSponsoredFeePaymentMethod } from "../../utils/sponsored_fee.js";

const FUTURE = 4102444800n;

async function main() {
  console.log("Hostile-agent cases");
  const wallet = await EmbeddedWallet.create(createAztecNodeClient(process.env.NODE_URL ?? "http://localhost:8080"), { ephemeral: true });
  const acct = async (d: any): Promise<AztecAddress> =>
    (await wallet.createSchnorrInitializerlessAccount(d.secret, d.salt, d.signingKey)).address;
  const paymentMethod = await getSponsoredFeePaymentMethod(wallet as any);
  const o = (from: AztecAddress) => ({ from, fee: { paymentMethod } });

  const t = await getInitialTestAccountsData();
  const [buyer, supplier, carrier] = [await acct(t[0]), await acct(t[1]), await acct(t[2])];
  const [ad, od] = await generateSchnorrAccounts(2);
  const [arbiter, outsider] = [await acct(ad), await acct(od)];

  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(o(buyer));
  await token.methods.mint_publicly(buyer, 100_000n).send(o(buyer));
  const { contract: pp } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(o(buyer));
  const { contract: escrow } = await RelnetEscrowContract.deploy(wallet, token.address, arbiter, pp.address).send(o(buyer));
  await pp.methods.set_escrow(escrow.address).send(o(buyer));

  const bal = async (a: AztecAddress) => (await token.methods.balance_of(a).simulate({ from: buyer })).result as bigint;
  const fund = async (id: bigint, amount: bigint, shipBy = FUTURE) => {
    await token.methods.transfer_public(escrow.address, amount).send(o(buyer));
    await escrow.methods.fund_call_off(id, supplier, carrier, amount, shipBy).send(o(buyer));
  };
  const rej = (p: Promise<unknown>, m: string) => assertRejects(p, m);
  const r: boolean[] = [];

  r.push(await check("token: non-admin cannot mint", () => rej(token.methods.mint_publicly(outsider, 1n).send(o(outsider)), "minted")));
  r.push(await check("token: cannot transfer more than balance", () => rej(token.methods.transfer_public(buyer, 10n).send(o(outsider)), "overdraw")));
  r.push(await check("pp: set_escrow is admin-only and one-time", async () => {
    await rej(pp.methods.set_escrow(outsider).send(o(outsider)), "non-admin set");
    await rej(pp.methods.set_escrow(outsider).send(o(buyer)), "set twice");
  }));
  r.push(await check("pp: outsider cannot forge an outcome record", () => rej(pp.methods.record_outcome(999n, true).send(o(outsider)), "forged")));

  r.push(await check("escrow: cannot fund without first transferring tokens", () =>
    rej(escrow.methods.fund_call_off(50n, supplier, carrier, 500n, FUTURE).send(o(buyer)), "unfunded")));
  r.push(await check("escrow: same call-off id cannot be funded twice", async () => {
    await fund(1n, 100n);
    await token.methods.transfer_public(escrow.address, 100n).send(o(buyer));
    await rej(escrow.methods.fund_call_off(1n, supplier, carrier, 100n, FUTURE).send(o(buyer)), "refunded id");
  }));
  r.push(await check("escrow: repeated attestation does not pay twice", async () => {
    const before = await bal(supplier);
    await escrow.methods.attest_shipped(1n).send(o(supplier));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(supplier));
    assertEqual((await bal(supplier)) - before, 30n, "30% paid exactly once");
  }));
  r.push(await check("escrow: cannot inspect before receipt; only buyer may inspect", async () => {
    await rej(escrow.methods.attest_inspected(1n).send(o(buyer)), "inspect early");
    await escrow.methods.attest_received(1n).send(o(buyer));
    await escrow.methods.attest_received(1n).send(o(carrier));
    await rej(escrow.methods.attest_inspected(1n).send(o(supplier)), "supplier inspects own goods");
    await rej(escrow.methods.attest_inspected(1n).send(o(outsider)), "outsider inspects");
  }));
  r.push(await check("escrow: refund blocked once shipped; nothing moves after close", async () => {
    await rej(escrow.methods.missed_ship_date_refund(1n).send(o(outsider)), "refund after ship");
    await escrow.methods.attest_inspected(1n).send(o(buyer));
    await rej(escrow.methods.attest_inspected(1n).send(o(buyer)), "double inspect");
    await rej(escrow.methods.arbiter_resolve(1n, outsider, 1n).send(o(arbiter)), "arbiter on closed");
    assertEqual(await bal(supplier), 100n, "supplier total");
  }));
  r.push(await check("escrow: arbiter-only, and cannot exceed remaining escrow", async () => {
    await fund(2n, 200n);
    await rej(escrow.methods.arbiter_resolve(2n, outsider, 1n).send(o(outsider)), "non-arbiter");
    await rej(escrow.methods.arbiter_resolve(2n, outsider, 201n).send(o(arbiter)), "overdraw");
    await escrow.methods.arbiter_resolve(2n, supplier, 50n).send(o(arbiter));
    // 150 remaining for call-off 2 + 100 stray tokens sent earlier but never committed
    assertEqual(await bal(escrow.address), 250n, "escrow keeps rest");
  }));
  r.push(await check("escrow: cannot fund a call-off on someone else's behalf funds", async () => {
    // outsider has no tokens to back a commitment: escrow balance must cover total_committed
    await rej(escrow.methods.fund_call_off(60n, supplier, carrier, 1_000_000n, FUTURE).send(o(outsider)), "over-commit");
  }));

  r.push(await check("pp: cannot absorb before an outcome exists", () => rej(pp.methods.absorb_outcome(77n, true).send(o(supplier)), "absorbed nothing")));
  r.push(await check("pp: false on_time claim is rejected, honest claim works, and it cannot be absorbed twice", async () => {
    await fund(3n, 100n, 1000n); // already-late deadline => recorded late
    await escrow.methods.attest_shipped(3n).send(o(supplier));
    await escrow.methods.attest_shipped(3n).send(o(carrier));
    await rej(pp.methods.absorb_outcome(3n, true).send(o(supplier)), "lied about lateness");
    await pp.methods.absorb_outcome(3n, false).send(o(supplier));
    await rej(pp.methods.absorb_outcome(3n, false).send(o(supplier)), "double absorb");
  }));
  r.push(await check("pp: one party cannot prove using another's history", async () => {
    await rej(pp.methods.prove_on_time_rate(0n).send(o(outsider)), "outsider proves");
    await rej(pp.methods.prove_on_time_rate(100n).send(o(supplier)), "0/1 on time claimed 100%");
    await pp.methods.prove_on_time_rate(0n).send(o(supplier));
  }));
  finish(r);
}
main().catch((e) => { console.error(e); process.exit(1); });
