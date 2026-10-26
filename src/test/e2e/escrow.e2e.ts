import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetCoinContract } from "../../artifacts/RelnetCoin.js";
import { RelnetEscrowContract } from "../../artifacts/RelnetEscrow.js";
import { RelnetPerformanceProofContract } from "../../artifacts/RelnetPerformanceProof.js";
import { check, assertRejects, assertEqual, finish } from "./check.js";
import { getSponsoredFeePaymentMethod } from "../../utils/sponsored_fee.js";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const FAR_FUTURE_SHIP_BY = 4102444800n; // year 2100, guaranteed not-yet-missed
const FAR_PAST_SHIP_BY = 1000n; // guaranteed already-missed

async function main() {
  console.log("RelnetEscrow");

  const node = createAztecNodeClient(NODE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

  async function newAccount(secret: any, salt: any, signingKey: any): Promise<AztecAddress> {
    const account = await wallet.createSchnorrInitializerlessAccount(secret, salt, signingKey);
    return account.address;
  }

  const paymentMethod = await getSponsoredFeePaymentMethod(wallet as any);
  function sendOpts(from: AztecAddress) {
    return { from, fee: { paymentMethod } };
  }

  const accountsData = await getInitialTestAccountsData();
  const buyer = await newAccount(accountsData[0].secret, accountsData[0].salt, accountsData[0].signingKey);
  const supplier = await newAccount(accountsData[1].secret, accountsData[1].salt, accountsData[1].signingKey);
  const carrier = await newAccount(accountsData[2].secret, accountsData[2].salt, accountsData[2].signingKey);

  const [arbiterData, outsiderData] = await generateSchnorrAccounts(2);
  const arbiter = await newAccount(arbiterData.secret, arbiterData.salt, arbiterData.signingKey);
  const outsider = await newAccount(outsiderData.secret, outsiderData.salt, outsiderData.signingKey);

  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(sendOpts(buyer));
  await token.methods.mint_publicly(buyer, 100_000n).send(sendOpts(buyer));

  const { contract: performanceProof } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(
    sendOpts(buyer),
  );
  const { contract: escrow } = await RelnetEscrowContract.deploy(
    wallet,
    token.address,
    arbiter,
    performanceProof.address,
  ).send(sendOpts(buyer));
  await performanceProof.methods.set_escrow(escrow.address).send(sendOpts(buyer));

  async function balanceOf(owner: AztecAddress): Promise<bigint> {
    const { result } = await token.methods.balance_of(owner).simulate({ from: buyer });
    return result;
  }

  const results: boolean[] = [];

  results.push(
    await check("runs the full milestone lifecycle with correct 30/50/20 splits", async () => {
      const callOffId = 1n;
      const amount = 1_000n;

      await token.methods.transfer_public(escrow.address, amount).send(sendOpts(buyer));
      await escrow.methods
        .fund_call_off(callOffId, supplier, carrier, amount, FAR_FUTURE_SHIP_BY)
        .send(sendOpts(buyer));

      // SHIPPED needs both supplier and carrier.
      await escrow.methods.attest_shipped(callOffId).send(sendOpts(supplier));
      assertEqual(await balanceOf(supplier), 0n, "no release after only one SHIPPED attestation");

      await escrow.methods.attest_shipped(callOffId).send(sendOpts(carrier));
      assertEqual(await balanceOf(supplier), 300n, "30% released after both SHIPPED attestations");

      // RECEIVED needs both buyer and carrier.
      await escrow.methods.attest_received(callOffId).send(sendOpts(buyer));
      await escrow.methods.attest_received(callOffId).send(sendOpts(carrier));
      assertEqual(await balanceOf(supplier), 800n, "300 + 50% released after both RECEIVED attestations");

      // INSPECTED: buyer only, releases whatever remains.
      await escrow.methods.attest_inspected(callOffId).send(sendOpts(buyer));
      assertEqual(await balanceOf(supplier), 1000n, "full amount released after INSPECTED");

      const { result: closed } = await escrow.methods.is_closed(callOffId).simulate({ from: buyer });
      assertEqual(closed, true, "call-off closed after INSPECTED");
    }),
  );

  results.push(
    await check("rejects attestation from someone who is neither party to the call-off", async () => {
      const callOffId = 2n;
      const amount = 500n;

      await token.methods.transfer_public(escrow.address, amount).send(sendOpts(buyer));
      await escrow.methods
        .fund_call_off(callOffId, supplier, carrier, amount, FAR_FUTURE_SHIP_BY)
        .send(sendOpts(buyer));

      await assertRejects(
        escrow.methods.attest_shipped(callOffId).send(sendOpts(outsider)),
        "expected outsider attestation to be rejected",
      );
    }),
  );

  results.push(
    await check("rejects deemed acceptance before the 7-day window has elapsed", async () => {
      const callOffId = 3n;
      const amount = 500n;

      await token.methods.transfer_public(escrow.address, amount).send(sendOpts(buyer));
      await escrow.methods
        .fund_call_off(callOffId, supplier, carrier, amount, FAR_FUTURE_SHIP_BY)
        .send(sendOpts(buyer));
      await escrow.methods.attest_received(callOffId).send(sendOpts(buyer));
      await escrow.methods.attest_received(callOffId).send(sendOpts(carrier));

      await assertRejects(
        escrow.methods.finalize_deemed_acceptance(callOffId).send(sendOpts(outsider)),
        "expected early deemed-acceptance call to be rejected",
      );
    }),
  );

  results.push(
    await check("refunds the buyer in full when the ship-by date has already passed", async () => {
      const callOffId = 4n;
      const amount = 500n;

      await token.methods.transfer_public(escrow.address, amount).send(sendOpts(buyer));
      await escrow.methods
        .fund_call_off(callOffId, supplier, carrier, amount, FAR_PAST_SHIP_BY)
        .send(sendOpts(buyer));

      const before = await balanceOf(buyer);
      await escrow.methods.missed_ship_date_refund(callOffId).send(sendOpts(outsider));
      const after = await balanceOf(buyer);
      assertEqual(after - before, amount, "buyer refunded the full escrowed amount");

      const { result: closed } = await escrow.methods.is_closed(callOffId).simulate({ from: buyer });
      assertEqual(closed, true, "call-off closed after refund");
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
