import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetAgreementContract } from "../../artifacts/RelnetAgreement.js";
import { check, assertRejects, assertEqual, finish } from "./check.js";
import { getSponsoredFeePaymentMethod } from "../../utils/sponsored_fee.js";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";

async function main() {
  console.log("RelnetAgreement");

  const node = createAztecNodeClient(NODE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const paymentMethod = await getSponsoredFeePaymentMethod(wallet as any);
  function sendOpts(from: AztecAddress) {
    return { from, fee: { paymentMethod } };
  }

  const [buyerData, supplierData, outsiderData] = await getInitialTestAccountsData();
  const buyerAccount = await wallet.createSchnorrInitializerlessAccount(
    buyerData.secret,
    buyerData.salt,
    buyerData.signingKey,
  );
  const supplierAccount = await wallet.createSchnorrInitializerlessAccount(
    supplierData.secret,
    supplierData.salt,
    supplierData.signingKey,
  );
  const outsiderAccount = await wallet.createSchnorrInitializerlessAccount(
    outsiderData.secret,
    outsiderData.salt,
    outsiderData.signingKey,
  );
  const buyer: AztecAddress = buyerAccount.address;
  const supplier: AztecAddress = supplierAccount.address;
  const outsider: AztecAddress = outsiderAccount.address;

  const { contract } = await RelnetAgreementContract.deploy(
    wallet,
    buyer,
    supplier,
    500n, // price_cents
    10n, // volume_min
    100n, // volume_max
  ).send(sendOpts(buyer));

  const results: boolean[] = [];

  results.push(
    await check("accepts a call-off within the agreed band", async () => {
      await contract.methods.place_call_off(50n, 500n).send(sendOpts(supplier));
      const { result: count } = await contract.methods.get_call_off_count().simulate({ from: buyer });
      assertEqual(count, 1n, "call_off_count");
    }),
  );

  results.push(
    await check("rejects a call-off with an out-of-band quantity", async () => {
      await assertRejects(
        contract.methods.place_call_off(9999n, 500n).send(sendOpts(supplier)),
        "expected out-of-band quantity to be rejected",
      );
    }),
  );

  results.push(
    await check("rejects a call-off at the wrong price", async () => {
      await assertRejects(
        contract.methods.place_call_off(50n, 1n).send(sendOpts(supplier)),
        "expected wrong-price call-off to be rejected",
      );
    }),
  );

  results.push(
    await check("rejects a call-off from a third party who is neither buyer nor supplier", async () => {
      await assertRejects(
        contract.methods.place_call_off(50n, 500n).send(sendOpts(outsider)),
        "expected outsider call-off to be rejected",
      );
    }),
  );

  finish(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
