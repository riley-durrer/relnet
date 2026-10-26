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
const FAR_FUTURE_SHIP_BY = 4102444800n; // year 2100 — ships "on time"
const FAR_PAST_SHIP_BY = 1000n; // already passed — ships "late"

async function main() {
  console.log("RelnetPerformanceProof");

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
  const [otherSupplierData] = await generateSchnorrAccounts(1);
  const otherSupplier = await newAccount(
    otherSupplierData.secret,
    otherSupplierData.salt,
    otherSupplierData.signingKey,
  );

  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(sendOpts(buyer));
  await token.methods.mint_publicly(buyer, 100_000n).send(sendOpts(buyer));

  const { contract: performanceProof } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(
    sendOpts(buyer),
  );
  const { contract: escrow } = await RelnetEscrowContract.deploy(
    wallet,
    token.address,
    buyer, // arbiter (unused here)
    performanceProof.address,
  ).send(sendOpts(buyer));
  await performanceProof.methods.set_escrow(escrow.address).send(sendOpts(buyer));

  async function runCallOffToShipped(callOffId: bigint, shipBy: bigint) {
    const amount = 100n;
    await token.methods.transfer_public(escrow.address, amount).send(sendOpts(buyer));
    await escrow.methods.fund_call_off(callOffId, supplier, carrier, amount, shipBy).send(sendOpts(buyer));
    await escrow.methods.attest_shipped(callOffId).send(sendOpts(supplier));
    await escrow.methods.attest_shipped(callOffId).send(sendOpts(carrier));
    // Extra blocks so the escrow's recorded outcome is settled before absorbing.
    await token.methods.transfer_public(buyer, 0n).send(sendOpts(buyer));
    await token.methods.transfer_public(buyer, 0n).send(sendOpts(buyer));
  }

  const results: boolean[] = [];

  results.push(
    await check("absorbing an on-time outcome and proving a met threshold both succeed", async () => {
      await runCallOffToShipped(1n, FAR_FUTURE_SHIP_BY);
      await performanceProof.methods.absorb_outcome(1n, true).send(sendOpts(supplier));
      // 1/1 on-time so far — proving >= 100% must succeed.
      await performanceProof.methods.prove_on_time_rate(100n).send(sendOpts(supplier));

      const { result: proven } = await performanceProof.methods
        .get_proven_threshold(supplier)
        .simulate({ from: buyer });
      assertEqual(proven, 100n, "proven threshold recorded publicly");
    }),
  );

  results.push(
    await check("absorbing a late outcome then failing to prove 100% on-time", async () => {
      await runCallOffToShipped(2n, FAR_PAST_SHIP_BY);
      await performanceProof.methods.absorb_outcome(2n, false).send(sendOpts(supplier));
      // Now 1 on-time / 2 total = 50%. Proving >= 100% must fail.
      await assertRejects(
        performanceProof.methods.prove_on_time_rate(100n).send(sendOpts(supplier)),
        "expected proof of 100% on-time rate to fail after a late delivery",
      );
      // But proving >= 50% must still succeed.
      await performanceProof.methods.prove_on_time_rate(50n).send(sendOpts(supplier));
    }),
  );

  results.push(
    await check("rejects absorbing the same outcome twice", async () => {
      await assertRejects(
        performanceProof.methods.absorb_outcome(1n, true).send(sendOpts(supplier)),
        "expected re-absorption of an already-absorbed outcome to be rejected",
      );
    }),
  );

  results.push(
    await check("a supplier with no history cannot prove anything", async () => {
      await assertRejects(
        performanceProof.methods.prove_on_time_rate(0n).send(sendOpts(otherSupplier)),
        "expected a supplier with zero recorded call-offs to be rejected",
      );
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
