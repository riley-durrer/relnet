// Check a relnet release before you run it.
//   tsx src/release/verify.ts <relnet-X.Y.Z.tgz> [--sums SHA256SUMS] [--repo owner/name] [--skip-attestation]
//                             [--node URL --agreement 0x...]
//   tsx src/release/verify.ts --dir <extracted folder>      (installed-tree checks only)
//
// Checks, in order:
//   1. hash         the tarball's SHA-256 equals its line in SHA256SUMS
//   2. attestation  `gh attestation verify` proves the tarball was built by this repo's release workflow on a
//                   GitHub-hosted runner, and the signed commit equals the commit in release.json
//   3. files        every file in the extracted tree matches release.json, and nothing extra is present
//   4. class ids    the contract class ids recomputed from the compiled artifacts equal release.json
//   5. on-chain     (optional) a deployed agreement's class id equals the release's RelnetAgreement
// Exit 0 only if every check ran and passed. A skipped check is reported as SKIPPED and exits 2.
//
// This script ships inside the tarball it checks, so a tampered tarball could ship a tampered verifier. The
// independent checks are steps 1 and 2 run with sha256sum and the gh CLI directly (see the README).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeClassIds } from "./classids.js";
import type { ReleaseManifest } from "./package.js";

type Status = "PASS" | "FAIL" | "SKIPPED";
const results: { name: string; status: Status; detail: string }[] = [];
const record = (name: string, status: Status, detail: string) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(8)} ${name}: ${detail}`);
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const tarball = argv.find((a) => a.endsWith(".tgz"));
let dir = flag("--dir");
const repo = flag("--repo") ?? "riley-durrer/relnet";
const nodeUrl = flag("--node");
const agreement = flag("--agreement");
if (!tarball && !dir) {
  console.error("Usage: verify <relnet-X.Y.Z.tgz> | --dir <folder>  [--sums F] [--repo owner/name] [--skip-attestation] [--node URL --agreement 0x...]");
  process.exit(64);
}

function walk(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel)).flatMap((n) => {
    const p = path.join(rel, n);
    return statSync(path.join(root, p)).isDirectory() ? walk(root, p) : [p.split(path.sep).join("/")];
  });
}

let commit: string | undefined;

if (tarball) {
  // 1. hash
  const sumsPath = flag("--sums") ?? path.join(path.dirname(tarball), "SHA256SUMS");
  const actual = sha256(readFileSync(tarball));
  if (!existsSync(sumsPath)) record("hash", "FAIL", `no checksum list at ${sumsPath}`);
  else {
    const line = readFileSync(sumsPath, "utf8").split("\n").find((l) => l.endsWith(`  ${path.basename(tarball)}`));
    if (!line) record("hash", "FAIL", `${path.basename(tarball)} is not listed in ${sumsPath}`);
    else if (line.split(/\s+/)[0] === actual) record("hash", "PASS", `sha256 ${actual.slice(0, 16)}... matches ${path.basename(sumsPath)}`);
    else record("hash", "FAIL", `sha256 is ${actual}, list says ${line.split(/\s+/)[0]}`);
  }

  // 2. attestation
  if (argv.includes("--skip-attestation")) record("attestation", "SKIPPED", "--skip-attestation given; nothing proves who built this file");
  else {
    const supported = spawnSync("gh", ["attestation", "verify", "--help"], { encoding: "utf8" });
    const r = supported.status === 0
      ? spawnSync(
          "gh",
          ["attestation", "verify", tarball, "--repo", repo, "--signer-workflow", `${repo}/.github/workflows/release.yml`, "--deny-self-hosted-runners", "--format", "json"],
          { encoding: "utf8" },
        )
      : undefined;
    const err = (r?.stderr ?? "").trim();
    if (supported.error) record("attestation", "FAIL", "the gh CLI is not installed. Install GitHub CLI 2.49 or newer, then run `gh auth login`.");
    else if (!r) record("attestation", "FAIL", "this gh version has no `attestation` command. Upgrade GitHub CLI to 2.49 or newer.");
    else if (/gh auth login|GH_TOKEN/.test(err)) record("attestation", "FAIL", "gh is not logged in. Run `gh auth login` (a free GitHub account is enough) or set GH_TOKEN.");
    else if (/HTTP 404/.test(err)) record("attestation", "FAIL", `no build attestation from ${repo} exists for this file's hash, so it was not built by that repo's release workflow`);
    else if (r.status !== 0) record("attestation", "FAIL", `gh attestation verify failed: ${err.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    else {
      try {
        const cert = JSON.parse(r.stdout)[0].verificationResult.signature.certificate;
        commit = cert.sourceRepositoryDigest;
        record("attestation", "PASS", `built by ${cert.buildSignerURI.replace("https://github.com/", "")} from commit ${String(commit).slice(0, 12)} on a ${cert.runnerEnvironment} runner`);
      } catch {
        record("attestation", "FAIL", "gh verified the file but its output could not be read");
      }
    }
  }

  dir = mkdtempSync(path.join(os.tmpdir(), "relnet-verify-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"]);
}

// 3. files
const root = path.resolve(dir!);
const manifestPath = path.join(root, "release.json");
if (!existsSync(manifestPath)) {
  record("files", "FAIL", "no release.json in the tree");
  finish();
}
const manifest: ReleaseManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (commit && commit !== manifest.commit) record("commit", "FAIL", `attestation signed commit ${commit}, release.json says ${manifest.commit}`);
else if (commit) record("commit", "PASS", "release.json names the attested commit");

const present = walk(root).filter((f) => f !== "release.json" && !f.startsWith("node_modules/"));
const bad: string[] = [];
for (const [f, h] of Object.entries(manifest.files)) {
  const p = path.join(root, f);
  if (!existsSync(p)) bad.push(`missing ${f}`);
  else if (sha256(readFileSync(p)) !== h) bad.push(`modified ${f}`);
}
for (const f of present) if (!(f in manifest.files)) bad.push(`extra ${f}`);
if (bad.length) record("files", "FAIL", `${bad.length} problem(s): ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? "; ..." : ""}`);
else record("files", "PASS", `${Object.keys(manifest.files).length} files match release.json`);

// 4. class ids
try {
  const ids = await computeClassIds(path.join(root, "target"));
  const wrong = Object.keys({ ...ids, ...manifest.classIds }).filter((k) => ids[k] !== manifest.classIds[k]);
  if (wrong.length) record("class ids", "FAIL", `differ from release.json: ${wrong.join(", ")}`);
  else record("class ids", "PASS", `${Object.keys(ids).length} contracts recomputed from the artifacts match release.json`);
} catch (e) {
  record("class ids", "FAIL", `could not compute class ids from target/: ${(e as Error).message.slice(0, 100)}`);
}

// 5. on-chain
if (nodeUrl && agreement) {
  try {
    const inst = await createAztecNodeClient(nodeUrl).getContract(AztecAddress.fromStringUnsafe(agreement));
    if (!inst) record("on-chain", "FAIL", `no contract instance at ${agreement} on ${nodeUrl}`);
    else if (inst.currentContractClassId.toString() === manifest.classIds.RelnetAgreement) record("on-chain", "PASS", `the contract at ${agreement.slice(0, 12)}... is this release's RelnetAgreement`);
    else record("on-chain", "FAIL", `the contract at ${agreement.slice(0, 12)}... has class id ${inst.currentContractClassId}, this release's RelnetAgreement is ${manifest.classIds.RelnetAgreement}`);
  } catch (e) {
    record("on-chain", "FAIL", `could not query ${nodeUrl}: ${(e as Error).message}`);
  }
} else record("on-chain", "SKIPPED", "pass --node and --agreement to compare a deployed contract with this release");

finish();

function finish(): never {
  const failed = results.some((r) => r.status === "FAIL");
  const skipped = results.some((r) => r.status === "SKIPPED");
  console.log(failed ? "\nNOT VERIFIED: do not run this release." : skipped ? "\nINCOMPLETE: every check that ran passed, but some were skipped." : "\nVERIFIED: every check passed.");
  process.exit(failed ? 1 : skipped ? 2 : 0);
}
