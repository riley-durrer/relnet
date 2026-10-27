import { check, assertRejects, assertRejectsWith, assertEqual, finish } from "./check.js";
import { setup, LATE_TERMS } from "./harness.js";

async function main() {
  console.log("Hostile and mistaken agents");
  const w = await setup();
  const { token, pp, escrow, agreement, buyer, supplier, carrier, buyerAgent, supplierAgent, arbiter, outsider, o } = w;
  const rej = (p: Promise<unknown>, m: string) => assertRejects(p, m);
  const why = (p: Promise<unknown>, substring: string, m: string) => assertRejectsWith(p, substring, m);
  const r: boolean[] = [];

  r.push(await check("token: non-admin cannot mint; cannot transfer more than balance", async () => {
    await why(token.methods.mint_publicly(outsider, 1n).send(o(outsider)), "Only admin can mint", "minted");
    await rej(token.methods.transfer_public(buyer, 10n).send(o(outsider)), "overdraw");
  }));
  r.push(await check("pp: set_escrow is admin-only and one-time", async () => {
    await why(pp.methods.set_escrow(outsider).send(o(outsider)), "Only admin", "non-admin set");
    await why(pp.methods.set_escrow(outsider).send(o(buyer)), "already set", "set twice");
  }));
  r.push(await check("pp: outsiders and agents cannot forge an outcome record", async () => {
    await why(pp.methods.record_outcome(999n, true).send(o(outsider)), "Only the registered escrow", "forged by outsider");
    await why(pp.methods.record_outcome(999n, true).send(o(supplierAgent)), "Only the registered escrow", "forged by supplier agent");
  }));

  r.push(await check("agreement: a supplier agent cannot approve terms or place orders at its own price", async () => {
    await agreement.methods.propose_terms(w.terms).send(o(buyerAgent)); // an open proposal exists to attack
    const open = await w.proposalId();
    await why(agreement.methods.approve_terms(open).send(o(supplierAgent)), "Only the buyer or supplier may approve", "agent approval");
    await why(agreement.methods.place_call_off(90n, 50n, 1n).send(o(supplierAgent)), "does not match agreement price", "off-price order");
    await w.approveBoth(); // restore a clean, active state
  }));
  r.push(await check("agreement: terms swapped after a human reviewed them cannot be approved", async () => {
    await agreement.methods.propose_terms({ ...w.terms, price_cents: 800n }).send(o(buyerAgent));
    const reviewed = await w.proposalId();
    await agreement.methods.propose_terms({ ...w.terms, price_cents: 1n }).send(o(supplierAgent));
    await why(agreement.methods.approve_terms(reviewed).send(o(buyer)), "not the current proposal", "stale approval");
    await why(agreement.methods.approve_terms(reviewed).send(o(supplier)), "not the current proposal", "stale approval by supplier");
    // Put the original terms back with fresh sign-off so later cases run under them.
    await agreement.methods.propose_terms(w.terms).send(o(buyerAgent));
    await w.approveBoth();
  }));

  r.push(await check("escrow: only the buyer side can fund; underpayment and double funding fail", async () => {
    await agreement.methods.place_call_off(1n, 20n, 500n).send(o(buyerAgent));
    await why(escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent)), "under-funded", "funded with nothing sent");
    await token.methods.transfer_public(escrow.address, 10_000n).send(o(buyerAgent));
    await why(escrow.methods.fund_call_off(1n, carrier).send(o(outsider)), "Only the buyer side may fund", "outsider funded");
    await why(escrow.methods.fund_call_off(1n, carrier).send(o(supplierAgent)), "Only the buyer side may fund", "supplier side funded");
    await escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent));
    await why(escrow.methods.fund_call_off(1n, carrier).send(o(buyerAgent)), "already funded", "funded twice");
  }));
  r.push(await check("escrow: receipt before shipment, and early or wrong-party inspection, are rejected", async () => {
    await rej(escrow.methods.attest_received(1n).send(o(buyerAgent)).then(() => escrow.methods.attest_received(1n).send(o(carrier))), "received before shipped");
    await why(escrow.methods.attest_inspected(1n).send(o(buyerAgent)), "before receipt", "inspected before receipt");
    await why(escrow.methods.attest_shipped(1n).send(o(outsider)), "Only the supplier side or carrier", "outsider attested shipment");
    await why(escrow.methods.attest_shipped(1n).send(o(buyerAgent)), "Only the supplier side or carrier", "buyer attested shipment");
  }));
  r.push(await check("escrow: repeated attestations pay once; inspection is buyer-side only", async () => {
    const before = await w.bal(supplier);
    await escrow.methods.attest_shipped(1n).send(o(supplierAgent));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(carrier));
    await escrow.methods.attest_shipped(1n).send(o(supplierAgent));
    assertEqual(await w.bal(supplier), before + 3_000n, "30% paid exactly once");
    await w.receive(1n);
    await why(escrow.methods.attest_inspected(1n).send(o(supplierAgent)), "Only the buyer side may attest inspection", "supplier inspected");
    await why(escrow.methods.attest_inspected(1n).send(o(carrier)), "Only the buyer side may attest inspection", "carrier inspected");
    await why(escrow.methods.attest_inspected(1n).send(o(outsider)), "Only the buyer side may attest inspection", "outsider inspected");
    await escrow.methods.attest_inspected(1n).send(o(buyerAgent));
    await why(escrow.methods.attest_inspected(1n).send(o(buyerAgent)), "already closed", "inspected twice");
    await why(escrow.methods.attest_shipped(1n).send(o(carrier)), "already closed", "reuse of a closed call-off");
  }));
  r.push(await check("escrow: the arbiter is bounded to funds still in escrow", async () => {
    await w.placeAndFund(2n, 10n); // 5,000
    await why(escrow.methods.arbiter_resolve(2n, outsider, 1n).send(o(outsider)), "Only the arbiter", "non-arbiter");
    await why(escrow.methods.arbiter_resolve(2n, outsider, 5_001n).send(o(arbiter)), "exceeds remaining escrow", "overdraw");
    await escrow.methods.arbiter_resolve(2n, supplier, 5_000n).send(o(arbiter));
    await why(escrow.methods.arbiter_resolve(2n, outsider, 1n).send(o(arbiter)), "already closed", "after close");
  }));
  r.push(await check("escrow: cannot commit more than the escrow holds", async () => {
    await agreement.methods.place_call_off(3n, 10n, 500n).send(o(buyerAgent));
    await agreement.methods.place_call_off(4n, 10n, 500n).send(o(buyerAgent));
    await token.methods.transfer_public(escrow.address, 5_000n).send(o(buyerAgent));
    await escrow.methods.fund_call_off(3n, carrier).send(o(buyerAgent));
    await why(escrow.methods.fund_call_off(4n, carrier).send(o(buyerAgent)), "under-funded", "over-commit");
  }));

  r.push(await check("pp: cannot absorb before an outcome exists, a false claim, or a repeat", async () => {
    await why(pp.methods.absorb_outcome(3n, true).send(o(supplier)), "No outcome recorded", "absorb with no outcome");
    await escrow.methods.attest_shipped(3n).send(o(supplierAgent));
    await escrow.methods.attest_shipped(3n).send(o(carrier));
    await w.tick();
    await w.tick();
    await why(pp.methods.absorb_outcome(3n, false).send(o(supplier)), "does not match escrow record", "false claim");
    await pp.methods.absorb_outcome(3n, true).send(o(supplier));
    await why(pp.methods.absorb_outcome(3n, true).send(o(supplier)), "already absorbed", "double absorb");
  }));
  r.push(await check("pp: cannot prove using someone else's history", async () => {
    await why(pp.methods.prove_on_time_rate(0n).send(o(outsider)), "No delivery history", "outsider");
    await why(pp.methods.prove_on_time_rate(0n).send(o(supplierAgent)), "No delivery history", "supplier agent");
  }));

  // World B: short windows, to attack the time-based paths.
  const b = await setup(LATE_TERMS);
  r.push(await check("escrow: cancel-for-refund is blocked once the goods have shipped", async () => {
    await b.placeAndFund(1n, 10n);
    await b.ship(1n);
    await b.tick();
    await b.tick();
    await why(b.escrow.methods.missed_ship_date_refund(1n).send(b.o(b.outsider)), "already attested", "refund after shipment");
  }));

  finish(r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
