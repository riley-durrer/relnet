// Shared deployment for the e2e suites, the demo and the operator UI: deploys the full stack with separate human
// accounts (who sign off on terms) and agent accounts (who do the day-to-day work).
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetAgreementContract } from "../artifacts/RelnetAgreement.js";
import { RelnetCoinContract } from "../artifacts/RelnetCoin.js";
import { RelnetEscrowContract } from "../artifacts/RelnetEscrow.js";
import { RelnetPerformanceProofContract } from "../artifacts/RelnetPerformanceProof.js";
import { getSponsoredFeePaymentMethod } from "../utils/sponsored_fee.js";
import { Terms } from "./terms.js";

export const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const ZERO = AztecAddress.ZERO;

/** On-time by default: the ship-by deadline is ~126 years out. Windows are long. */
export const TEST_TERMS: Terms = {
  price_cents: 500n,
  volume_min: 10n,
  volume_max: 100n,
  ship_bps: 3000n,
  receive_bps: 5000n,
  lead_time_secs: 4_000_000_000n,
  grace_secs: 0n,
  late_period_secs: 1n,
  late_bps_per_period: 1000n,
  late_cap_bps: 1000n,
  cancel_after_secs: 1_000_000_000n,
  deemed_acceptance_secs: 604_800n,
};

/** Everything is already late and every window is one second, so time-based paths are testable. */
export const LATE_TERMS: Terms = {
  ...TEST_TERMS,
  lead_time_secs: 0n,
  cancel_after_secs: 1n,
  deemed_acceptance_secs: 1n,
};

export async function setup(termsOverride: Partial<Terms> = {}, approve = true) {
  const node = createAztecNodeClient(NODE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const acct = async (d: any): Promise<AztecAddress> =>
    (await wallet.createSchnorrInitializerlessAccount(d.secret, d.salt, d.signingKey)).address;
  const pm = await getSponsoredFeePaymentMethod(wallet as any);
  const o = (from: AztecAddress) => ({ from, fee: { paymentMethod: pm } });

  const base = await getInitialTestAccountsData();
  const extra = await generateSchnorrAccounts(5);
  const buyer = await acct(base[0]); // human at the buying company
  const supplier = await acct(base[1]); // human at the supplying company
  const carrier = await acct(base[2]);
  const buyerAgent = await acct(extra[0]);
  const supplierAgent = await acct(extra[1]);
  const arbiter = await acct(extra[2]);
  const outsider = await acct(extra[3]);

  const terms: Terms = { ...TEST_TERMS, ...termsOverride };

  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(o(buyer));
  const { contract: pp } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(o(buyer));
  const { contract: agreement } = await RelnetAgreementContract.deploy(
    wallet, buyer, supplier, buyerAgent, supplierAgent, terms,
  ).send(o(buyer));
  const { contract: escrow } = await RelnetEscrowContract.deploy(
    wallet, token.address, arbiter, pp.address, agreement.address,
  ).send(o(buyer));
  await pp.methods.set_escrow(escrow.address).send(o(buyer));
  await token.methods.mint_publicly(buyerAgent, 10_000_000n).send(o(buyer));

  const bal = async (a: AztecAddress) => (await token.methods.balance_of(a).simulate({ from: buyer })).result as bigint;

  async function proposalId(): Promise<bigint> {
    return (await agreement.methods.get_proposal_id().simulate({ from: buyer })).result as bigint;
  }
  /** The two humans sign off on the open proposal. */
  async function approveBoth() {
    const id = await proposalId();
    await agreement.methods.approve_terms(id).send(o(buyer));
    await agreement.methods.approve_terms(id).send(o(supplier));
  }
  /** An agent proposes new terms and the two humans approve them. */
  async function amend(over: Partial<Terms>) {
    const current = (await agreement.methods.get_terms().simulate({ from: buyer })).result as Terms;
    await agreement.methods.propose_terms({ ...current, ...over }).send(o(buyerAgent));
    await approveBoth();
  }
  /** Place a call-off as the buyer's agent and fund its escrow. Returns the escrowed amount. */
  async function placeAndFund(id: bigint, qty: bigint, price = terms.price_cents): Promise<bigint> {
    await agreement.methods.place_call_off(id, qty, price).send(o(buyerAgent));
    const amount = qty * price;
    await token.methods.transfer_public(escrow.address, amount).send(o(buyerAgent));
    await escrow.methods.fund_call_off(id, carrier).send(o(buyerAgent));
    return amount;
  }
  /** Burn a block so time-based windows can elapse. */
  async function tick() {
    await token.methods.transfer_public(buyerAgent, 0n).send(o(buyerAgent));
  }
  async function ship(id: bigint) {
    await escrow.methods.attest_shipped(id).send(o(supplierAgent));
    await escrow.methods.attest_shipped(id).send(o(carrier));
  }
  async function receive(id: bigint) {
    await escrow.methods.attest_received(id).send(o(buyerAgent));
    await escrow.methods.attest_received(id).send(o(carrier));
  }

  /** Current chain time in seconds. Chain time can differ from the wall clock. */
  async function chainNow(): Promise<bigint> {
    const b: any = await (node as any).getBlock(await node.getBlockNumber());
    return BigInt(b.header.globalVariables.timestamp.toString());
  }

  if (approve) await approveBoth();

  return {
    wallet, node, o, terms, zero: ZERO,
    buyer, supplier, carrier, buyerAgent, supplierAgent, arbiter, outsider,
    token, pp, agreement, escrow,
    bal, proposalId, approveBoth, amend, placeAndFund, tick, ship, receive, chainNow,
  };
}
export type World = Awaited<ReturnType<typeof setup>>;
