// The invite / join / accept / serve / negotiate flow between two parties, each with its own key folder, using
// the real CLI as child processes. No chain needed. The example buyer invites, the example supplier joins.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { check, assertEqual, finish } from "./e2e/check.js";
import { releaseDifferences } from "../cli/invite.js";

const BUYER = "examples/companies/lone-star-assembly/mandate.json";
const SUPPLIER = "examples/companies/trinity-castings/mandate.json";
const home = () => mkdtempSync(path.join(os.tmpdir(), "relnet-cli-"));
const run = (h: string, ...a: string[]) => {
  const r = spawnSync("npx", ["tsx", "src/cli/relnet.ts", ...a], { encoding: "utf8", env: { ...process.env, RELNET_HOME: h } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
};
const freePort = () => new Promise<number>((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const deal = (h: string) => { const d = path.join(h, "deals"); const f = readdirSync(d)[0]; return JSON.parse(readFileSync(path.join(d, f), "utf8")); };
/** The fingerprint a person would read aloud: printed on stderr by invite and join. */
const printedFp = (err: string) => err.split("\n").map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{4}( [A-Za-z0-9_-]{1,4}){10}/.test(l))!.replace(/ /g, "");
const flipMiddle = (code: string) => { const i = Math.floor(code.length / 2); return code.slice(0, i) + (code[i] === "A" ? "B" : "A") + code.slice(i + 1); };

async function main() {
  console.log("Invite, join and negotiate (two parties, real processes)");
  const r: boolean[] = [];
  const port = await freePort();
  const A = home(), B = home();
  const inv = run(A, "invite", "--side", "buyer", "--url", `http://127.0.0.1:${port}`);
  const code = inv.out, fpA = printedFp(inv.err);

  r.push(await check("invite prints a code and the inviter's key fingerprint, and keeps the private key in a 0600 file", async () => {
    if (!code.startsWith("relnet-invite-1.")) throw new Error(inv.err);
    const f = path.join(A, "deals", `${deal(A).dealId}.json`);
    assertEqual((await import("node:fs")).statSync(f).mode & 0o777, 0o600, "file mode");
    if (inv.out.includes("privateJwk") || inv.out.includes('"d"')) throw new Error("private key leaked into the code");
  }));

  r.push(await check("join without a fingerprint pins nothing (exit 2)", async () => {
    const j = run(B, "join", code, "--allow-release-mismatch");
    assertEqual(j.code, 2, "exit code");
    if (existsSync(path.join(B, "deals"))) throw new Error("a deal file was written before the fingerprint was confirmed");
  }));

  r.push(await check("join with the wrong fingerprint is refused", async () => {
    const j = run(B, "join", code, "--allow-release-mismatch", "--confirm-fingerprint", "A".repeat(43));
    assertEqual(j.code, 1, "exit code");
    if (!j.err.includes("does not match")) throw new Error(j.err);
  }));

  r.push(await check("a development checkout is refused unless the person accepts the release mismatch", async () => {
    const j = run(B, "join", code, "--confirm-fingerprint", fpA);
    assertEqual(j.code, 1, "exit code");
    if (!j.err.includes("not running the same release")) throw new Error(j.err);
  }));

  r.push(await check("an invite altered in transit is rejected", async () => {
    const j = run(B, "join", flipMiddle(code), "--allow-release-mismatch", "--confirm-fingerprint", fpA);
    assertEqual(j.code, 1, "exit code");
    if (!/damaged|invalid|does not match/.test(j.err)) throw new Error(j.err);
  }));

  r.push(await check("an attacker's own invite (valid signature, different key) fails the fingerprint the person heard", async () => {
    const X = home();
    const evil = run(X, "invite", "--side", "buyer", "--url", "http://127.0.0.1:1");
    const j = run(B, "join", evil.out, "--allow-release-mismatch", "--confirm-fingerprint", fpA);
    assertEqual(j.code, 1, "exit code");
    if (!j.err.includes("does not match")) throw new Error(j.err);
  }));

  r.push(await check("an expired invite is rejected", async () => {
    const e = run(home(), "invite", "--side", "buyer", "--url", "http://127.0.0.1:1", "--ttl-hours", "0.0002");
    await new Promise((res) => setTimeout(res, 1500));
    const j = run(B, "join", e.out, "--allow-release-mismatch", "--confirm-fingerprint", printedFp(e.err));
    assertEqual(j.code, 1, "exit code");
    if (!j.err.includes("expired")) throw new Error(j.err);
  }));

  const jn = run(B, "join", code, "--allow-release-mismatch", "--confirm-fingerprint", fpA);
  const reply = jn.out, fpB = printedFp(jn.err);

  r.push(await check("join with the right fingerprint pins the inviter and prints a reply code", async () => {
    assertEqual(jn.code, 0, `exit code (${jn.err})`);
    if (!reply.startsWith("relnet-reply-1.")) throw new Error(jn.err);
    assertEqual(deal(B).peer.fingerprint, fpA, "pinned the inviter's key");
    assertEqual(deal(B).side, "supplier", "joiner takes the other side");
  }));

  const dealA = deal(A).dealId;
  r.push(await check("accept refuses a reply for another deal, a wrong fingerprint, and a missing fingerprint", async () => {
    const other = run(home(), "invite", "--side", "buyer", "--url", "http://127.0.0.1:1");
    const C = home();
    const jc = run(C, "join", other.out, "--allow-release-mismatch", "--confirm-fingerprint", printedFp(other.err));
    const wrongDeal = run(A, "accept", jc.out, "--deal", dealA, "--confirm-fingerprint", printedFp(jc.err));
    assertEqual(wrongDeal.code, 1, "reply for a different deal");
    assertEqual(run(A, "accept", reply, "--deal", dealA, "--confirm-fingerprint", "B".repeat(43)).code, 1, "wrong fingerprint");
    assertEqual(run(A, "accept", reply, "--deal", dealA).code, 2, "no fingerprint");
    if (deal(A).peer) throw new Error("the counterparty was pinned without a confirmed fingerprint");
  }));

  r.push(await check("accept with the joiner's fingerprint pins the joiner", async () => {
    const a = run(A, "accept", reply, "--deal", dealA, "--confirm-fingerprint", fpB);
    assertEqual(a.code, 0, a.err + a.out);
    assertEqual(deal(A).peer.fingerprint, fpB, "pinned the joiner's key");
  }));

  r.push(await check("a mandate for the wrong side is refused", async () => {
    const s = run(A, "serve", "--deal", dealA, "--mandate", SUPPLIER);
    assertEqual(s.code, 1, "exit code");
    if (!s.err.includes("mandate file is for a supplier")) throw new Error(s.err);
  }));

  r.push(await check("serve and negotiate reach the same signed-offer agreement, and both record identical terms", async () => {
    const serve = spawn("npx", ["tsx", "src/cli/relnet.ts", "serve", "--deal", dealA, "--mandate", BUYER], { env: { ...process.env, RELNET_HOME: A } });
    let served = "";
    serve.stdout.on("data", (d) => (served += d));
    for (let i = 0; i < 60 && !served.includes("Serving deal"); i++) await new Promise((res) => setTimeout(res, 250));
    if (!served.includes("Serving deal")) throw new Error("server did not start: " + served);
    const n = run(B, "negotiate", "--deal", deal(B).dealId, "--mandate", SUPPLIER);
    assertEqual(n.code, 0, `negotiate failed:\n${n.out}\n${n.err}`);
    for (let i = 0; i < 40 && !deal(A).agreed; i++) await new Promise((res) => setTimeout(res, 250));
    serve.kill();
    if (!deal(A).agreed || !deal(B).agreed) throw new Error("no agreed terms were recorded");
    const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    assertEqual(sorted(deal(A).agreed), sorted(deal(B).agreed), "both sides recorded the same terms");
    if (!n.out.includes("Agreed terms")) throw new Error("no plain-language summary was printed");
  }));

  r.push(await check("release comparison: identical real releases match; a dev build, another commit or another class id never does", async () => {
    const rel = { version: "0.1.0", commit: "a".repeat(40), classIds: { RelnetAgreement: "0x1", RelnetEscrow: "0x2" } };
    assertEqual(releaseDifferences(rel, { ...rel }).length, 0, "identical releases");
    assertEqual(releaseDifferences({ ...rel, commit: "dev" }, { ...rel, commit: "dev" }).length > 0, true, "dev vs dev");
    assertEqual(releaseDifferences(rel, { ...rel, commit: "b".repeat(40) }).length > 0, true, "other commit");
    assertEqual(releaseDifferences(rel, { ...rel, classIds: { ...rel.classIds, RelnetEscrow: "0x3" } }).join().includes("RelnetEscrow"), true, "other class id");
  }));

  finish(r);
}
main();
