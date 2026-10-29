// Contract class ids for the compiled artifacts in target/. The class id commits to the artifact hash,
// the private-function verification keys and the public bytecode, so two parties who compute the same
// id are looking at the same contract code. A deployed instance reports the id it was created from.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadContractArtifact } from "@aztec/aztec.js/abi";
import { getContractClassFromArtifact } from "@aztec/aztec.js/contracts";

export interface ClassIds {
  [contract: string]: string;
}

export async function computeClassIds(targetDir: string): Promise<ClassIds> {
  const out: ClassIds = {};
  const files = readdirSync(targetDir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const artifact = loadContractArtifact(JSON.parse(readFileSync(path.join(targetDir, f), "utf8")));
    const cls = await getContractClassFromArtifact(artifact);
    out[artifact.name] = cls.id.toString();
  }
  return out;
}
