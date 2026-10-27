import { check, assertRejects, assertEqual, finish } from "./check.js";
import { setup, LATE_TERMS } from "./harness.js";

async function main() {
  console.log("RelnetEscrow: milestones, late-price rule, time windows");
  const results: boolean[] = [];

  // World A: on-time terms with long windows.
  const a = await setup();
  results.push(
    await check("on-time call-off pays 30/50/20 and the amount comes from the agreement", async () => {
      const amount = await a.placeAndFund(1n, 40n); // 40 x 500
      assertEqual(amount, 20_000n, "escrowed amount");
      await a.escrow.methods.attest_shipped(1n).send(a.o(a.supplierAgent));
      assertEqual(await a.bal(a.supplier), 0n, "no release after one shipped attestation");
      await a.escrow.methods.attest_shipped(1n).send(a.o(a.carrier));
      assertEqual(await a.bal(a.supplier), 6_000n, "30% on shipment");
      await a.receive(1n);
      assertEqual(await a.bal(a.supplier), 16_000n, "80% on receipt");
      await a.escrow.methods.attest_inspected(1n).send(a.o(a.buyerAgent));
      assertEqual(await a.bal(a.supplier), 20_000n, "100% on inspection");
      const { result: closed } = await a.escrow.methods.is_closed(1n).simulate({ from: a.buyer });
      assertEqual(closed, true, "closed");
    }),
  );

  results.push(
    await check("funding needs the call-off to exist, and the full value to be sent first", async () => {
      await assertRejects(a.escrow.methods.fund_call_off(77n, a.carrier).send(a.o(a.buyerAgent)), "unknown call-off");
      await a.agreement.methods.place_call_off(2n, 20n, 500n).send(a.o(a.buyerAgent));
      await a.token.methods.transfer_public(a.escrow.address, 9_999n).send(a.o(a.buyerAgent)); // one cent short
      await assertRejects(a.escrow.methods.fund_call_off(2n, a.carrier).send(a.o(a.buyerAgent)), "underpaid funding");
      await a.token.methods.transfer_public(a.escrow.address, 1n).send(a.o(a.buyerAgent));
      await a.escrow.methods.fund_call_off(2n, a.carrier).send(a.o(a.buyerAgent));
    }),
  );

  results.push(
    await check("cancel and deemed-acceptance windows are not open early", async () => {
      await a.ship(2n);
      await assertRejects(a.escrow.methods.finalize_deemed_acceptance(2n).send(a.o(a.outsider)), "finalize before receipt");
      await a.receive(2n);
      await assertRejects(a.escrow.methods.finalize_deemed_acceptance(2n).send(a.o(a.outsider)), "finalize inside the window");
      await a.placeAndFund(3n, 10n);
      await assertRejects(a.escrow.methods.missed_ship_date_refund(3n).send(a.o(a.outsider)), "refund before the window");
    }),
  );

  // World B: everything is already late, windows are one second.
  const b = await setup(LATE_TERMS);
  results.push(
    await check("late shipment cuts the price by the signed rule and refunds the buyer", async () => {
      const companyBefore = await b.bal(b.buyer);
      await b.placeAndFund(1n, 40n); // 20,000 escrowed
      await b.ship(1n);
      // late_bps_per_period=1000, cap=1000: any full late period is a 10% cut = 2,000.
      const { result: total } = await b.escrow.methods.get_total(1n).simulate({ from: b.buyer });
      assertEqual(total, 18_000n, "adjusted total");
      assertEqual(await b.bal(b.supplier), 5_400n, "30% of the adjusted total");
      // Refunds go to the agreement's buyer account (the company), not the agent that paid.
      assertEqual(await b.bal(b.buyer), companyBefore + 2_000n, "buyer company is refunded the 2,000 cut");
      await b.receive(1n);
      await b.escrow.methods.attest_inspected(1n).send(b.o(b.buyerAgent));
      assertEqual(await b.bal(b.supplier), 18_000n, "supplier receives the adjusted total in full");
      const { result: left } = await b.escrow.methods.get_remaining(1n).simulate({ from: b.buyer });
      assertEqual(left, 0n, "nothing stranded in escrow");
    }),
  );

  results.push(
    await check("buyer can cancel an unshipped call-off after the window, permissionlessly", async () => {
      const before = await b.bal(b.buyer);
      await b.placeAndFund(2n, 10n); // 5,000
      await b.tick();
      await b.tick();
      await b.escrow.methods.missed_ship_date_refund(2n).send(b.o(b.outsider));
      assertEqual(await b.bal(b.buyer), before + 5_000n, "full refund to the buyer company");
      const { result: closed } = await b.escrow.methods.is_closed(2n).simulate({ from: b.buyer });
      assertEqual(closed, true, "closed");
    }),
  );

  results.push(
    await check("silence after receipt counts as acceptance once the window passes", async () => {
      await b.placeAndFund(3n, 20n); // 10,000, ships late: 10% cut
      await b.ship(3n);
      await b.receive(3n);
      await b.tick();
      await b.tick();
      const before = await b.bal(b.supplier);
      await b.escrow.methods.finalize_deemed_acceptance(3n).send(b.o(b.outsider));
      assertEqual(await b.bal(b.supplier), before + 9_000n - 2_700n - 4_500n, "remainder of the adjusted 9,000 is released");
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
