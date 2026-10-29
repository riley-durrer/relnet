// `verify --node --agreement`: a contract deployed on the network is compared with the release's class id.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, assertEqual, finish } from "./check.js";
import { setup } from "./harness.js";
import { NODE_URL } from "../../lib/world.js";

const tsx = (...a: string[]) => spawnSync("npx", ["tsx", ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const line = (out: string, name: string) => out.split("\n").find((l) => l.includes(` ${name}:`)) ?? "";

async function main() {
  console.log("Release verify: on-chain class id");
  const w = await setup({}, false);
  const out = mkdtempSync(path.join(os.tmpdir(), "relnet-release-e2e-"));
  const pk = tsx("src/release/package.ts", "--out", out, "--allow-dirty");
  if (pk.status !== 0) throw new Error(pk.stderr);
  const tree = mkdtempSync(path.join(os.tmpdir(), "relnet-release-tree-"));
  execFileSync("tar", ["-xzf", path.join(out, "relnet-0.1.0.tgz"), "-C", tree, "--strip-components=1"]);
  const run = (addr: string) => {
    const v = tsx("src/release/verify.ts", "--dir", tree, "--node", NODE_URL, "--agreement", addr);
    return { code: v.status, text: line(v.stdout, "on-chain") };
  };
  const results: boolean[] = [];

  results.push(await check("a RelnetAgreement deployed by the test equals the release's class id", async () => {
    const v = run(w.agreement.address.toString());
    if (!v.text.startsWith("PASS")) throw new Error(v.text);
    assertEqual(v.code, 0, "every check passed, nothing skipped");
  }));

  results.push(await check("a different relnet contract at the address is rejected (escrow is not the agreement)", async () => {
    const v = run(w.escrow.address.toString());
    if (!v.text.startsWith("FAIL")) throw new Error(v.text);
    assertEqual(v.code, 1, "exit code");
  }));

  results.push(await check("an address with no contract is rejected", async () => {
    const v = run(w.outsider.toString());
    if (!v.text.startsWith("FAIL") || !v.text.includes("no contract instance")) throw new Error(v.text);
  }));

  finish(results);
}
main();
