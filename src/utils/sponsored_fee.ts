import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";

async function getSponsoredFPCInstance() {
  return await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
}

/** Registers the sandbox's pre-deployed SponsoredFPC with `wallet` and returns a fee payment method for it. */
export async function getSponsoredFeePaymentMethod(wallet: {
  registerContract: (instance: unknown, artifact: unknown) => Promise<void>;
}): Promise<SponsoredFeePaymentMethod> {
  const fpc = await getSponsoredFPCInstance();
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  return new SponsoredFeePaymentMethod(fpc.address);
}
