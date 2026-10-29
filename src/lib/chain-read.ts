// Read an agreement from the chain with a wallet of your own, the way the other company would.
// Nothing here trusts the party that deployed the contract: it asks the node for the contract instance and
// reads the public state.
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { generateSchnorrAccounts } from "@aztec/accounts/testing";
import { RelnetAgreementContract, RelnetAgreementContractArtifact } from "../artifacts/RelnetAgreement.js";
import { Terms, TERM_FIELDS } from "./terms.js";

export interface OnChainAgreement {
  /** The terms currently proposed or in force, whichever the contract holds in `pending`. */
  pending: Terms;
  version: bigint;
  buyer: string;
  supplier: string;
}

export async function readAgreement(nodeUrl: string, address: string): Promise<OnChainAgreement> {
  const node = createAztecNodeClient(nodeUrl);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const [a] = await generateSchnorrAccounts(1);
  const from = (await wallet.createSchnorrInitializerlessAccount(a.secret, a.salt, a.signingKey)).address;
  const at = AztecAddress.fromStringUnsafe(address);
  const instance = await node.getContract(at);
  if (!instance) throw new Error(`no contract at ${address}`);
  await wallet.registerContract(instance, RelnetAgreementContractArtifact);
  const c = RelnetAgreementContract.at(at, wallet);
  const read = async (m: any) => (await m.simulate({ from })).result;
  const raw = await read(c.methods.get_pending());
  const pending = Object.fromEntries(TERM_FIELDS.map((f) => [f.key, BigInt(raw[f.key])])) as unknown as Terms;
  return {
    pending,
    version: BigInt(await read(c.methods.get_version())),
    buyer: (await read(c.methods.get_buyer())).toString(),
    supplier: (await read(c.methods.get_supplier())).toString(),
  };
}
