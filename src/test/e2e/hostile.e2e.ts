import { check, assertRejects, assertEqual, finish } from "./check.js";
import { setup, LATE_TERMS } from "./harness.js";

async function main() {
  console.log("Hostile and mistaken agents");
  const w = await setup();
  const { token, pp, escrow, agreement, buyer, supplier, carrier, buyerAgent, supplierAgent, arbiter, outsider, o } = w;
  const rej = (p: Promise<unknown>, m: string) => assertRejects(p, m);
  const r: boolean[] = [];

  r.push(await check("token: non-admin cannot mint; cannot transfer more than balance", async () => {
    await rej(token.methods.mint_publicly(outsider, 1n).send(o(outsider)), "minted");
    await rej(token.methods.transfer_public(buyer, 10n).send(o(outsider)), "overdraw");
  }));
  r.push(await check("pp: set_escrow is admin-only and one-time", async () => {
    await rej(pp.methods.set_escrow(outsider).send(o(outsider)), "non-admin set");
    await rej(pp.methods.set_escrow(outsider).send(o(buyer)), "set twice");
  }));
  r.push(await check("pp: outsiders and agents cannot forge an outcome record", async () => {
    await rej(pp.methods.record_outcome(999n, true).send(o(outsider)), "forged by outsider");
    await rej(pp.methods.record_outcome(999n, true).send(o(supplierAgent)), "forged by supplier agent");
  }));

  r.push(await check("agreement: a supplier agent cannot approve terms or place orders at its own price", async () => {
    await rej(agreement.methods.approve_terms(1n).send(o(supplierAgent)), "agent approval");
    await rej(agreement.methods.place_call_off(90n, 50n, 1n).send(o(supplierAgent)), "off-price order");
  }));
  r.push(await check("agreement: terms swapped after a human reviewed them cannot be approved", async () => {
    await agreement.methods.propose_terms({ ...w.terms, price_cents: 800n }).send(o(buyerAgent));
    const reviewed = await w.proposalId();
    await agreement.methods.propose_terms({ ...w.terms, price_cents: 1n }).send(o(supplierAgent));
    await rej(agreement.methods.approve_terms(reviewed).send(o(buyer)), "stale approval");
    await rej(agreement.methods.approve_terms(reviewed).send(o(supplier)), "stale approval by supplier");
    // Put the original terms back with fresh sign-off so later cases run under them.
    await agreement.methods.propose_terms(w.terms).send(o(buyerAgent));
    await w.approveBoth();
  }));

  r.push(await check("escrow: only the buyer side can fund; underpayment and double funding fail", async () => {
    await agreement.methods.place_call_off(1n, 20n, 500n).send(o(buyerAgent));
    await rej(escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent)), "funded with nothing sent");
    await token.methods.transfer_public(escrow.address, 10_000n).send(o(buyerAgent));
    await rej(escrow.methods.fund_call_off(1n, carrier).send(o(outsider)), "outsider funded");
    await rej(escrow.methods.fund_call_off(1n, carrier).send(o(supplierAgent)), "supplier side funded");
    await escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent));
    await rej(escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent)), "funded twice");
  }));
  r.push(await check("escrow: receipt before shipment, and early or wrong-party inspection, are rejected", async () => {
    await rej(escrow.methods.attest_received(1n).send(o(buyerAgent)).then(() => escrow.methods.attest_received(1n).send(o(carrier))), "received before shipped");
    await rej(escrow.methods.attest_inspected(1n).send(o(buyerAgent)), "inspected before receipt");
    await rej(escrow.methods.attest_shipped(1n).send(o(outsider)), "outsider attested shipment");
    await rej(escrow.methods.attest_shipped(1n).send(o(buyerAgent)), "buyer attested shipment");
  }));
  r.push(await check("escrow: repeated attestations pay once; inspection is buyer-side only", async () => {
    const before = await w.bal(supplier);
    await escrow.methods.attest_shipped(1n).send(o(supplierAgent));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(supplierAgent));
    assertEqual(await w.bal(supplier), before + 3_000n, "30% paid exactly once");
    await w.receive(1n);
    await rej(escrow.methods.attest_inspected(1n).send(o(supplierAgent)), "supplier inspected");
    await rej(escrow.methods.attest_inspected(1n).send(o(carrier)), "carrier inspected");
    await rej(escrow.methods.attest_inspected(1n).send(o(outsider)), "outsider inspected");
    await escrow.methods.attest_inspected(1n).send(o(buyerAgent));
    await rej(escrow.methods.attest_inspected(1n).send(o(buyerAgent)), "inspected twice");
    await rej(escrow.methods.attest_shipped(1n).send(o(carrier)), "reuse of a closed call-off");
  }));
  r.push(await check("escrow: the arbiter is bounded to funds still in escrow", async () => {
    await w.placeAndFund(2n, 10n); // 5,000
    await rej(escrow.methods.arbiter_resolve(2n, outsider, 1n).send(o(outsider)), "non-arbiter");
    await rej(escrow.methods.arbiter_resolve(2n, outsider, 5_001n).send(o(arbiter)), "overdraw");
    await escrow.methods.arbiter_resolve(2n, supplier, 5_000n).send(o(arbiter));
    await rej(escrow.methods.arbiter_resolve(2n, outsider, 1n).send(o(arbiter)), "after close");
  }));
  r.push(await check("escrow: cannot commit more than the escrow holds", async () => {
    await agreement.methods.place_call_off(3n, 10n, 500n).send(o(buyerAgent));
    await agreement.methods.place_call_off(4n, 10n, 500n).send(o(buyerAgent));
    await token.methods.transfer_public(escrow.address, 5_000n).send(o(buyerAgent));
    await escrow.methods.fund_call_off(3n, carrier).send(o(buyerAgent));
    await rej(escrow.methods.fund_call_off(4n, carrier).send(o(buyerAgent)), "over-commit");
  }));

  r.push(await check("pp: cannot absorb before an outcome exists, a false claim, or a repeat", async () => {
    await rej(pp.methods.absorb_outcome(3n, true).send(o(supplier)), "absorb with no outcome");
    await escrow.methods.attest_shipped(3n).send(o(supplierAgent));
    await escrow.methods.attest_shipped(3n).send(o(carrier));
    await w.tick();
    await w.tick();
    await rej(pp.methods.absorb_outcome(3n, false).send(o(supplier)), "false claim");
    await pp.methods.absorb_outcome(3n, true).send(o(supplier));
    await rej(pp.methods.absorb_outcome(3n, true).send(o(supplier)), "double absorb");
  }));
  r.push(await check("pp: cannot prove using someone else's history", async () => {
    await rej(pp.methods.prove_on_time_rate(0n).send(o(outsider)), "outsider");
    await rej(pp.methods.prove_on_time_rate(0n).send(o(supplierAgent)), "supplier agent");
  }));

  // World B: short windows, to attack the time-based paths.
  const b = await setup(LATE_TERMS);
  r.push(await check("escrow: cancel-for-refund is blocked once the goods have shipped", async () => {
    await b.placeAndFund(1n, 10n);
    await b.ship(1n);
    await b.tick();
    await b.tick();
    await rej(b.escrow.methods.missed_ship_date_refund(1n).send(b.o(b.outsider)), "refund after shipment");
  }));

  finish(r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
