// Release packaging and verification, offline. Builds a release from the compiled artifacts in target/ and
// checks that `verify` passes a genuine one and names the failing check for each kind of tampering.
// The attestation check needs GitHub, so these runs use --skip-attestation (exit 2 = every check that ran passed).
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { check, assertEqual, finish } from "./e2e/check.js";

const tsx = (...a: string[]) => spawnSync("npx", ["tsx", ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "relnet-release-test-"));

function build(out: string) {
  const r = tsx("src/release/package.ts", "--out", out, "--allow-dirty");
  if (r.status !== 0) throw new Error(`package failed: ${r.stderr}`);
  return path.join(out, "relnet-0.1.0.tgz");
}
function verify(tgz: string) {
  const r = tsx("src/release/verify.ts", tgz, "--skip-attestation");
  return { code: r.status, out: r.stdout };
}
/** Unpack, change something, repack deterministically, and rewrite the checksum list so the hash check passes. */
function tamper(tgz: string, edit: (root: string) => void): string {
  const x = tmp();
  execFileSync("tar", ["-xzf", tgz, "-C", x]);
  edit(path.join(x, "relnet-0.1.0"));
  const out = path.join(tmp(), "relnet-0.1.0.tgz");
  const tar = execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "-C", x, "relnet-0.1.0"], { maxBuffer: 1 << 28 });
  writeFileSync(out, execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 1 << 28 }));
  writeFileSync(path.join(path.dirname(out), "SHA256SUMS"), `${sha(out)}  relnet-0.1.0.tgz\n`);
  return out;
}
const line = (out: string, name: string) => out.split("\n").find((l) => l.includes(` ${name}:`)) ?? "";

async function main() {
  console.log("Release packaging and verify (offline)");
  const r: boolean[] = [];
  const a = tmp();
  const good = build(a);

  r.push(await check("packaging is deterministic: two builds give identical bytes", async () => {
    const good2 = build(tmp());
    assertEqual(sha(good), sha(good2), "same tarball hash");
  }));

  r.push(await check("a genuine release passes hash, files and class ids; the skipped attestation makes it incomplete (exit 2)", async () => {
    const v = verify(good);
    assertEqual(v.code, 2, "exit code");
    for (const n of ["hash", "files", "class ids"]) if (!line(v.out, n).startsWith("PASS")) throw new Error(`${n} should pass:\n${v.out}`);
    if (!line(v.out, "attestation").startsWith("SKIPPED")) throw new Error("attestation should be reported as skipped");
  }));

  r.push(await check("a tarball with an extra byte fails the hash check", async () => {
    const dir = tmp();
    const bad = path.join(dir, "relnet-0.1.0.tgz");
    writeFileSync(bad, Buffer.concat([readFileSync(good), Buffer.from("x")]));
    writeFileSync(path.join(dir, "SHA256SUMS"), readFileSync(path.join(a, "SHA256SUMS")));
    const v = verify(bad);
    assertEqual(v.code, 1, "exit code");
    if (!line(v.out, "hash").startsWith("FAIL")) throw new Error(v.out);
  }));

  r.push(await check("a modified source file fails the files check even when the checksum list is rewritten to match", async () => {
    const bad = tamper(good, (root) => writeFileSync(path.join(root, "src/lib/terms.ts"), readFileSync(path.join(root, "src/lib/terms.ts"), "utf8") + "\n// evil\n"));
    const v = verify(bad);
    assertEqual(v.code, 1, "exit code");
    if (!line(v.out, "hash").startsWith("PASS")) throw new Error("hash should pass, since the list was rewritten");
    if (!line(v.out, "files").includes("modified src/lib/terms.ts")) throw new Error(v.out);
  }));

  r.push(await check("an added file fails the files check", async () => {
    const bad = tamper(good, (root) => writeFileSync(path.join(root, "src/backdoor.ts"), "export {};\n"));
    const v = verify(bad);
    assertEqual(v.code, 1, "exit code");
    if (!line(v.out, "files").includes("extra src/backdoor.ts")) throw new Error(v.out);
  }));

  r.push(await check("changed contract bytecode changes the class id, so the class-id check fails", async () => {
    const bad = tamper(good, (root) => {
      const p = path.join(root, "target/relnet_agreement-RelnetAgreement.json");
      const art = JSON.parse(readFileSync(p, "utf8"));
      const f = art.functions.find((x: { name: string }) => x.name === "public_dispatch");
      f.bytecode = f.bytecode.slice(0, 20) + (f.bytecode[20] === "B" ? "C" : "B") + f.bytecode.slice(21);
      writeFileSync(p, JSON.stringify(art));
    });
    const v = verify(bad);
    assertEqual(v.code, 1, "exit code");
    if (!line(v.out, "class ids").includes("RelnetAgreement")) throw new Error(v.out);
  }));

  r.push(await check("a missing checksum list fails", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "relnet-0.1.0.tgz"), readFileSync(good));
    const v = verify(path.join(dir, "relnet-0.1.0.tgz"));
    assertEqual(v.code, 1, "exit code");
    if (!line(v.out, "hash").startsWith("FAIL")) throw new Error(v.out);
  }));

  finish(r);
}
main();
