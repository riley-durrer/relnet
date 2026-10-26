import { randomBytes } from "node:crypto";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { RelnetCoinContract } from "../artifacts/RelnetCoin.js";
import { getSponsoredFeePaymentMethod } from "../utils/sponsored_fee.js";
import { SimulatedFundingProvider } from "./simulated.js";
import { createFundingServer } from "./server.js";

// Demo funding service: deploys a RelnetCoin owned by the first sandbox test account and
// mints to requesters when an admin approves. Sandbox only.
const PORT = Number(process.env.PORT ?? 8090);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? randomBytes(16).toString("hex");

const wallet = await EmbeddedWallet.create(createAztecNodeClient(process.env.NODE_URL ?? "http://localhost:8080"), {
  ephemeral: true,
});
const [d] = await getInitialTestAccountsData();
const admin = (await wallet.createSchnorrInitializerlessAccount(d.secret, d.salt, d.signingKey)).address;
const paymentMethod = await getSponsoredFeePaymentMethod(wallet as any);
const opts = { from: admin, fee: { paymentMethod } };
const { contract: token } = await RelnetCoinContract.deploy(wallet, admin).send(opts);

const provider = new SimulatedFundingProvider({
  baseUrl: `http://127.0.0.1:${PORT}`,
  maxAmountCents: 1_000_000n,
  mint: async (address, amount) => {
    if (!AztecAddress.isAddress(address)) throw new Error("not a valid Aztec address");
    await token.methods.mint_publicly(AztecAddress.fromStringUnsafe(address), amount).send(opts);
  },
});
createFundingServer(provider, ADMIN_TOKEN).listen(PORT, "127.0.0.1", () => {
  console.log(`RelnetCoin token: ${token.address.toString()}`);
  console.log(`Funding service:  http://127.0.0.1:${PORT}`);
  console.log(`Admin token:      ${ADMIN_TOKEN}`);
});
