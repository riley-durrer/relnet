import { check, assertRejects, assertEqual, finish } from "./check.js";
import { setup } from "./harness.js";

async function main() {
  console.log("RelnetPerformanceProof");
  const w = await setup(); // on-time terms
  const { pp, supplier, supplierAgent, buyer, outsider, o } = w;
  const results: boolean[] = [];

  // The supplier's own account holds the private tally, so the supplier account (not its agent) absorbs and proves.
  async function shipAndSettle(id: bigint, qty: bigint) {
    await w.placeAndFund(id, qty);
    await w.ship(id);
    await w.tick();
    await w.tick();
  }

  results.push(
    await check("absorbing an on-time outcome and proving a met threshold both succeed", async () => {
      await shipAndSettle(1n, 20n);
      await pp.methods.absorb_outcome(1n, true).send(o(supplier));
      await pp.methods.prove_on_time_rate(100n).send(o(supplier)); // 1/1 on time
      const { result: proven } = await pp.methods.get_proven_threshold(supplier).simulate({ from: buyer });
      assertEqual(proven, 100n, "proven threshold recorded publicly");
    }),
  );

  results.push(
    await check("a late delivery (after an agreed amendment) lowers the provable rate", async () => {
      await w.amend({ lead_time_secs: 0n }); // humans sign off on a tighter deadline
      await shipAndSettle(2n, 20n); // ships after its deadline
      await assertRejects(
        pp.methods.absorb_outcome(2n, true).send(o(supplier)),
        "claiming a late delivery was on time",
      );
      await pp.methods.absorb_outcome(2n, false).send(o(supplier));
      await assertRejects(pp.methods.prove_on_time_rate(100n).send(o(supplier)), "proved 100% at 1/2 on time");
      await pp.methods.prove_on_time_rate(50n).send(o(supplier));
    }),
  );

  results.push(
    await check("an outcome can be absorbed only once", () =>
      assertRejects(pp.methods.absorb_outcome(1n, true).send(o(supplier)), "re-absorption"),
    ),
  );

  results.push(
    await check("an account with no history, and an agent without the supplier's notes, cannot prove", async () => {
      await assertRejects(pp.methods.prove_on_time_rate(0n).send(o(outsider)), "outsider proved");
      await assertRejects(pp.methods.prove_on_time_rate(0n).send(o(supplierAgent)), "agent proved from the supplier's notes");
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
