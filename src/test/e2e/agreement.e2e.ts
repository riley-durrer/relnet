import { check, assertRejects, assertRejectsWith, assertEqual, finish } from "./check.js";
import { setup } from "./harness.js";

async function main() {
  console.log("RelnetAgreement: sign-off, bounds, amendments");
  const w = await setup({}, false); // terms are proposed but not yet approved
  const { agreement, buyer, supplier, buyerAgent, supplierAgent, outsider, o } = w;
  const results: boolean[] = [];
  const version = async () => (await agreement.methods.get_version().simulate({ from: buyer })).result as bigint;

  results.push(
    await check("no call-off is possible until both humans approve the terms", async () => {
      await assertRejectsWith(agreement.methods.place_call_off(1n, 50n, 500n).send(o(buyerAgent)), "not yet approved", "placed before approval");
      const id = await w.proposalId();
      await agreement.methods.approve_terms(id).send(o(buyer));
      assertEqual(await version(), 0n, "terms active after only the buyer approved");
      await assertRejectsWith(agreement.methods.place_call_off(1n, 50n, 500n).send(o(buyerAgent)), "not yet approved", "placed after one approval");
      await agreement.methods.approve_terms(id).send(o(supplier));
      assertEqual(await version(), 1n, "terms active after both approved");
    }),
  );

  results.push(
    await check("agents and outsiders cannot approve an open proposal", async () => {
      await agreement.methods.propose_terms(w.terms).send(o(buyerAgent)); // opens a fresh proposal
      const id = await w.proposalId();
      const why = "Only the buyer or supplier may approve";
      await assertRejectsWith(agreement.methods.approve_terms(id).send(o(buyerAgent)), why, "buyer agent approved");
      await assertRejectsWith(agreement.methods.approve_terms(id).send(o(supplierAgent)), why, "supplier agent approved");
      await assertRejectsWith(agreement.methods.approve_terms(id).send(o(outsider)), why, "outsider approved");
      assertEqual((await agreement.methods.get_buyer_approved().simulate({ from: buyer })).result, false, "buyer flag untouched");
      assertEqual((await agreement.methods.get_supplier_approved().simulate({ from: buyer })).result, false, "supplier flag untouched");
    }),
  );

  results.push(
    await check("agent can place an in-band call-off at the agreed price", async () => {
      await agreement.methods.place_call_off(1n, 50n, 500n).send(o(buyerAgent));
      await agreement.methods.place_call_off(2n, 40n, 500n).send(o(supplierAgent));
      const { result: n } = await agreement.methods.get_call_off_count().simulate({ from: buyer });
      assertEqual(n, 2n, "call_off_count");
    }),
  );

  results.push(
    await check("rejects out-of-band quantity, wrong price, outsiders and reused ids", async () => {
      await assertRejectsWith(agreement.methods.place_call_off(10n, 9999n, 500n).send(o(buyerAgent)), "outside agreed band", "out-of-band qty");
      await assertRejectsWith(agreement.methods.place_call_off(10n, 9n, 500n).send(o(buyerAgent)), "outside agreed band", "below minimum");
      await assertRejectsWith(agreement.methods.place_call_off(10n, 50n, 1n).send(o(buyerAgent)), "does not match agreement price", "wrong price");
      await assertRejectsWith(agreement.methods.place_call_off(10n, 50n, 500n).send(o(outsider)), "Only buyer or supplier", "outsider");
      await assertRejectsWith(agreement.methods.place_call_off(1n, 50n, 500n).send(o(buyerAgent)), "already used", "reused id");
    }),
  );

  results.push(
    await check("an amendment needs fresh sign-off and never rewrites call-offs in flight", async () => {
      await agreement.methods.propose_terms({ ...w.terms, price_cents: 600n }).send(o(supplierAgent));
      // Proposed but not approved: the old price still governs.
      await assertRejects(agreement.methods.place_call_off(3n, 50n, 600n).send(o(buyerAgent)), "new price before approval");
      await agreement.methods.place_call_off(3n, 50n, 500n).send(o(buyerAgent));
      await w.approveBoth();
      assertEqual(await version(), 2n, "version after amendment");
      await assertRejects(agreement.methods.place_call_off(4n, 50n, 500n).send(o(buyerAgent)), "old price after amendment");
      await agreement.methods.place_call_off(4n, 50n, 600n).send(o(buyerAgent));
      const { result: old } = await agreement.methods.get_call_off(1n).simulate({ from: buyer });
      assertEqual((old as any).price_cents, 500n, "call-off 1 keeps the price it was placed under");
    }),
  );

  results.push(
    await check("a re-proposal invalidates a human's approval of the earlier proposal", async () => {
      await agreement.methods.propose_terms({ ...w.terms, price_cents: 700n }).send(o(buyerAgent));
      const reviewed = await w.proposalId();
      await agreement.methods.propose_terms({ ...w.terms, price_cents: 1n }).send(o(buyerAgent)); // swapped under the human
      await assertRejectsWith(agreement.methods.approve_terms(reviewed).send(o(buyer)), "not the current proposal", "approved a stale proposal id");
    }),
  );

  results.push(
    await check("the contract rejects terms that break its own bounds", async () => {
      await assertRejectsWith(agreement.methods.propose_terms({ ...w.terms, ship_bps: 6000n, receive_bps: 5000n }).send(o(buyerAgent)), "exceed 100%", "shares over 100%");
      await assertRejectsWith(agreement.methods.propose_terms({ ...w.terms, volume_min: 200n }).send(o(buyerAgent)), "inverted", "inverted band");
      await assertRejectsWith(agreement.methods.propose_terms({ ...w.terms, price_cents: 0n }).send(o(buyerAgent)), "Price must be positive", "zero price");
      await assertRejectsWith(agreement.methods.propose_terms({ ...w.terms, late_cap_bps: 10001n }).send(o(buyerAgent)), "cap exceeds 100%", "cap over 100%");
      await assertRejectsWith(agreement.methods.propose_terms(w.terms).send(o(outsider)), "Only a party or its agent", "outsider proposal");
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
