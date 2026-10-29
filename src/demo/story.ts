// npm run story: the whole relationship between two companies, start to finish, as one real run.
//
//   Lone Star Assembly (buyer) downloads the published release, checks it, and invites Trinity Castings (supplier).
//   Trinity downloads and checks the same release, joins, and each side pins the other's agent key.
//   The two agents negotiate over A2A. The agreed contract is deployed and Trinity verifies it before anyone signs.
//   Both people sign. The buyer's agent asks for funds (simulated on-ramp), places an order, and the escrow pays the
//   supplier in milestones.
//
// What is real: the download from GitHub, the checksum and build-attestation checks, every relnet command (run from the
// unpacked v0.1.0 release in each company's own folder, with its own keys), the A2A negotiation, and every on-chain
// call on the local network. What is simulated: the funding service (no bank), the two companies sharing one computer
// and one local network, the agents' public URL (127.0.0.1), and the people (their approvals are scripted calls).
//
// Output carries "@@" marker lines for the video renderer. Needs: the local network running (npm run sandbox), the
// GitHub CLI 2.49+ logged in, curl, tar. Set STORY_DIR to reuse a working folder.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup } from "../lib/world.js";
import { RelnetAgreementContract } from "../artifacts/RelnetAgreement.js";
import { readAgreement } from "../lib/chain-read.js";
import { summarizeTerms, Terms, TERM_FIELDS } from "../lib/terms.js";
import { summarizeMandate } from "../examples/prompt.js";
import { loadCompany } from "../examples/companies.js";
import { SimulatedFundingProvider } from "../funding/simulated.js";

const REPO = "riley-durrer/relnet";
const VERSION = process.env.RELNET_VERSION ?? "0.1.0";
const BASE = `https://github.com/${REPO}/releases/download/v${VERSION}`;
const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const WORK = process.env.STORY_DIR ?? mkdtempSync(path.join(os.homedir(), ".cache", "relnet-story-"));
const PORT = 4871;
const money = (c: bigint) => `$${(Number(c) / 100).toFixed(2)}`;

type Who = "buyer" | "supplier";
const machine = {
  buyer: { dir: path.join(WORK, "buyer"), home: path.join(WORK, "buyer", "home"), name: "Lone Star Assembly", prompt: "lonestar$" },
  supplier: { dir: path.join(WORK, "supplier"), home: path.join(WORK, "supplier", "home"), name: "Trinity Castings", prompt: "trinity$" },
} as const;
const tree = (w: Who) => path.join(machine[w].dir, `relnet-${VERSION}`);

// ---- output --------------------------------------------------------------------------------------------------

const out = (s = "") => console.log(s);
const scene = (key: string, actor: string, caption: string) => out(`\n@@scene ${key} | ${actor} | ${caption}`);
const note = (s: string) => out(`· ${s}`);
const pause = () => out("@@pause");
/** Long tokens (codes, keys) are shortened for the screen; the real value is still used. */
const shorten = (s: string) => s.replace(/[A-Za-z0-9_.\-+/=]{70,}/g, (t) => `${t.slice(0, 26)}…(${t.length} chars)`);
const NOISE = /^(npm warn|npm notice|\s*$)/;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a real command in a company's folder as that company, printing it and its output. */
function sh(who: Who, shown: string, real = shown, o: { tail?: number; keepStdout?: boolean; cwd?: string } = {}): Ran {
  const m = machine[who];
  out(`${m.prompt} ${shorten(shown)}`);
  const r = spawnSync("bash", ["-c", real], {
    cwd: o.cwd ?? m.dir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, RELNET_HOME: m.home, PATH: `${path.dirname(ghPath())}:${process.env.PATH}`, LOG_LEVEL: "silent" },
  });
  const lines = (o.keepStdout ? r.stderr : r.stdout + r.stderr).split("\n").filter((l) => !NOISE.test(l));
  const shownLines = o.tail ? lines.slice(-o.tail) : lines;
  for (const l of shownLines) out(`  ${shorten(l)}`);
  if (o.keepStdout) out(`  ${shorten(r.stdout.trim())}`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}
function ghPath(): string {
  return process.env.GH_BIN ?? path.join(os.homedir(), ".cache/relnet-tools/gh_2.103.3_linux_amd64/bin/gh");
}
function must(r: Ran, what: string): Ran {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}):\n${r.stdout}\n${r.stderr}`);
  return r;
}

const dealFile = (w: Who) => {
  const d = path.join(machine[w].home, "deals");
  return JSON.parse(readFileSync(path.join(d, readdirSync(d)[0]), "utf8"));
};
/** The fingerprint a person reads aloud, as printed by invite and join: groups of four characters on one line. */
const fingerprintIn = (stderr: string) =>
  stderr.split("\n").map((l) => l.trim()).find((l) => /^\S{4}( \S{1,4}){10}$/.test(l) && !l.includes(":"))!.replace(/ /g, "");

// ---- scenes --------------------------------------------------------------------------------------------------

async function download(who: Who) {
  const m = machine[who];
  mkdirSync(m.dir, { recursive: true });
  must(sh(who, `curl -sLO github.com/${REPO}/releases/download/v${VERSION}/{relnet-${VERSION}.tgz,SHA256SUMS}`, `curl -sfLO ${BASE}/relnet-${VERSION}.tgz -O ${BASE}/relnet-${VERSION}.release.json -O ${BASE}/SHA256SUMS`), "download");
  must(sh(who, "sha256sum -c SHA256SUMS"), "checksums");
  must(sh(who, `gh attestation verify relnet-${VERSION}.tgz --repo ${REPO} && echo "attestation OK: built by ${REPO}'s release workflow"`), "attestation");
  must(sh(who, `tar -xzf relnet-${VERSION}.tgz && cd relnet-${VERSION} && npm ci --ignore-scripts`, undefined, { tail: 1 }), "install");
  must(sh(who, `npm run verify -- ../relnet-${VERSION}.tgz`, `cd relnet-${VERSION} && npm run -s verify -- ../relnet-${VERSION}.tgz || true`), "verify");
  note("The on-chain check is skipped for now because no contract exists yet. It runs again before anyone signs.");
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  out(`@@title relnet | A buyer and a supplier, start to finish | Local test network. Test tokens. Fictional companies. No real money.`);

  // 1. The buyer downloads and checks the release, then invites the supplier.
  scene("buyer-download", "LONE STAR ASSEMBLY · buyer", "Lone Star wants to buy castings from Trinity with AI agents and no bank. It downloads relnet and checks it before running anything.");
  await download("buyer");
  mkdirSync(machine.buyer.home, { recursive: true });
  cpSync(path.join(process.cwd(), "examples/companies/lone-star-assembly/mandate.json"), path.join(machine.buyer.dir, "mandate.json"));

  scene("buyer-invite", "LONE STAR ASSEMBLY · buyer", "Lone Star invites Trinity. The invite holds the agent's address, its public key and the exact release it runs.");
  const inv = sh("buyer", `cd relnet-${VERSION} && npm run relnet -- invite --side buyer --url http://127.0.0.1:${PORT} --node ${NODE_URL}`, `cd relnet-${VERSION} && npm run -s relnet -- invite --side buyer --url http://127.0.0.1:${PORT} --node ${NODE_URL}`, { keepStdout: true });
  must(inv, "invite");
  const inviteCode = inv.stdout.trim();
  const fpBuyer = fingerprintIn(inv.stderr);
  pause();
  note("Lone Star emails the invite code to Trinity. The code is signed, but anyone could have forged one.");
  note("So Dana at Lone Star reads Marcus at Trinity the key fingerprint over the phone. Nothing is pinned until he types it back.");

  // 2. The supplier downloads the same release, checks it, and joins.
  scene("supplier-setup", "TRINITY CASTINGS · supplier", "Trinity does not trust Lone Star's copy. It downloads the release from GitHub itself and runs the same checks.");
  await download("supplier");
  mkdirSync(machine.supplier.home, { recursive: true });
  cpSync(path.join(process.cwd(), "examples/companies/trinity-castings/mandate.json"), path.join(machine.supplier.dir, "mandate.json"));

  scene("supplier-join", "TRINITY CASTINGS · supplier", "Trinity reads the invite. It refuses to pin anyone until Marcus types the fingerprint he heard on the phone.");
  const writeCode = (name: string, v: string) => writeFileSync(path.join(machine.supplier.dir, name), v);
  writeCode("invite.txt", inviteCode);
  const j1 = sh("supplier", `cd relnet-${VERSION} && npm run relnet -- join <invite code>`, `cd relnet-${VERSION} && npm run -s relnet -- join "$(cat ../invite.txt)"`);
  if (j1.code !== 2) throw new Error("join without a fingerprint should stop with exit 2");
  pause();
  const j2 = sh("supplier", `cd relnet-${VERSION} && npm run relnet -- join <invite code> --confirm-fingerprint ${fpBuyer}`, `cd relnet-${VERSION} && npm run -s relnet -- join "$(cat ../invite.txt)" --confirm-fingerprint ${fpBuyer}`, { keepStdout: true });
  must(j2, "join");
  const replyCode = j2.stdout.trim();
  const fpSupplier = fingerprintIn(j2.stderr);
  note("Join also compared the release: same version, same commit, same contract fingerprints. A different build would have been refused.");

  scene("buyer-accept", "LONE STAR ASSEMBLY · buyer", "Trinity sends back a reply code. Lone Star pins Trinity's agent key the same way.");
  writeFileSync(path.join(machine.buyer.dir, "reply.txt"), replyCode);
  const dealId = dealFile("buyer").dealId;
  must(sh("buyer", `cd relnet-${VERSION} && npm run relnet -- accept <reply code> --deal ${dealId} --confirm-fingerprint ${fpSupplier}`, `cd relnet-${VERSION} && npm run -s relnet -- accept "$(cat ../reply.txt)" --deal ${dealId} --confirm-fingerprint ${fpSupplier}`), "accept");

  // 3. The agents negotiate.
  scene("limits", "THE TWO PEOPLE", "Each person has already told their own agent what it may accept. Neither agent sees the other's limits.");
  for (const id of ["lone-star-assembly", "trinity-castings"]) {
    const c = loadCompany(id);
    out(`  ${c.name} (${c.side}) limits:`);
    for (const l of summarizeMandate(c.mandate).slice(0, 5)) out(`    ${l}`);
  }
  scene("negotiate", "THE TWO AGENTS · over A2A", "The agents talk over the open A2A protocol. Every offer is signed and bound to this deal. No model picks a number; a rule-based negotiator does.");
  const serve = spawn("bash", ["-c", `cd relnet-${VERSION} && npm run -s relnet -- serve --deal ${dealId} --mandate ../mandate.json`], {
    cwd: machine.buyer.dir, env: { ...process.env, RELNET_HOME: machine.buyer.home },
  });
  let serveLog = "";
  serve.stdout.on("data", (d) => (serveLog += d));
  serve.stderr.on("data", (d) => (serveLog += d));
  for (let i = 0; i < 80 && !serveLog.includes("Serving deal"); i++) await new Promise((r) => setTimeout(r, 250));
  out(`${machine.buyer.prompt} npm run relnet -- serve --deal ${dealId} --mandate mandate.json`);
  out(`  ${serveLog.split("\n").find((l) => l.includes("Serving deal"))}`);
  const neg = sh("supplier", `cd relnet-${VERSION} && npm run relnet -- negotiate --deal ${dealId} --mandate mandate.json`, `cd relnet-${VERSION} && npm run -s relnet -- negotiate --deal ${dealId} --mandate ../mandate.json`);
  must(neg, "negotiate");
  for (let i = 0; i < 40 && !dealFile("buyer").agreed; i++) await new Promise((r) => setTimeout(r, 250));
  serve.kill();
  const agreed = dealFile("supplier").agreed as Record<string, string>;
  if (JSON.stringify(Object.entries(agreed).sort()) !== JSON.stringify(Object.entries(dealFile("buyer").agreed).sort())) throw new Error("the two sides recorded different terms");
  note("Both agents recorded the same terms. Nothing is binding yet: the agents cannot sign for their companies.");
  const terms = Object.fromEntries(TERM_FIELDS.map((f) => [f.key, BigInt(agreed[f.key])])) as unknown as Terms;

  // 4. The contract goes on-chain and the supplier verifies it before signing.
  scene("deploy", "THE LOCAL AZTEC NETWORK", "The agreed terms go on-chain as a proposal. Lone Star deploys the agreement, the escrow and the token, and sends Trinity the contract address.");
  note("Deploying the contracts (about 30 seconds)…");
  const w = await setup(terms, false, { mintToBuyerAgent: 0n });
  const agreement = w.agreement.address.toString();
  out(`chain> RelnetAgreement deployed at ${agreement.slice(0, 22)}…`);
  out(`chain> proposed terms are not binding until both people sign`);

  scene("verify-contract", "TRINITY CASTINGS · supplier", "Before signing, Trinity checks two things itself: that the contract is the exact code from the release, and that the terms on-chain are what the agents agreed.");
  writeFileSync(path.join(machine.supplier.dir, "agreement.txt"), agreement);
  const v = sh("supplier", `cd relnet-${VERSION} && npm run verify -- ../relnet-${VERSION}.tgz --node ${NODE_URL} --agreement ${agreement.slice(0, 14)}…`, `cd relnet-${VERSION} && npm run -s verify -- ../relnet-${VERSION}.tgz --node ${NODE_URL} --agreement ${agreement}`);
  must(v, "verify with the on-chain check");
  const chain = await readAgreement(NODE_URL, agreement);
  const diffs = TERM_FIELDS.filter((f) => chain.pending[f.key] !== terms[f.key]);
  out(`chain> Trinity reads the proposal from the chain with its own wallet and compares it to what its agent agreed:`);
  out(`chain> ${TERM_FIELDS.length - diffs.length} of ${TERM_FIELDS.length} terms match${diffs.length ? `; DIFFERENT: ${diffs.map((d) => d.key).join(", ")}` : ""}`);
  out(`chain> the supplier account in the contract is ${chain.supplier === w.supplier.toString() ? "Trinity's own account" : "NOT Trinity's account"}`);
  if (diffs.length || chain.supplier !== w.supplier.toString()) throw new Error("the contract on-chain does not match the agreed deal");

  note("What if the buyer had deployed the genuine code but with a different price? The code check alone would not notice.");
  const cheat = { ...terms, price_cents: terms.price_cents - 70n };
  const { contract: bad } = await RelnetAgreementContract.deploy(w.wallet, w.buyer, w.supplier, w.buyerAgent, w.supplierAgent, cheat).send(w.o(w.buyer));
  const badAddr = bad.address.toString();
  const vb = sh("supplier", `npm run verify -- ../relnet-${VERSION}.tgz --node ${NODE_URL} --agreement ${badAddr.slice(0, 14)}…`, `cd relnet-${VERSION} && npm run -s verify -- ../relnet-${VERSION}.tgz --node ${NODE_URL} --agreement ${badAddr} | grep -E "on-chain|VERIFIED"`);
  note("The code check passes, because it is the genuine contract. It says nothing about the terms. That is why Trinity also reads them.");
  const cb = await readAgreement(NODE_URL, badAddr);
  const wrong = TERM_FIELDS.filter((f) => cb.pending[f.key] !== terms[f.key]);
  out(`chain> Trinity compares the terms: ${TERM_FIELDS.length - wrong.length} of ${TERM_FIELDS.length} match. DIFFERENT: ${wrong.map((f) => `${f.key} (agreed ${terms[f.key]}, on-chain ${cb.pending[f.key]})`).join(", ")}`);
  out(`chain> Trinity does not sign. The code was genuine, but the terms were not the ones its agent agreed.`);
  if (vb.code !== 0 || wrong.length !== 1) throw new Error("the altered-terms check did not behave as expected");

  scene("sign", "THE TWO PEOPLE", "A person at each company reads the terms in plain language, which code generated from the exact values. Only their signatures make the deal binding.");
  for (const l of summarizeTerms(terms)) out(`  ${l}`);
  const id = await w.proposalId();
  await w.agreement.methods.approve_terms(id).send(w.o(w.buyer));
  out(`chain> Dana (Lone Star) signs proposal ${id}`);
  await w.agreement.methods.approve_terms(id).send(w.o(w.supplier));
  out(`chain> Marcus (Trinity) signs proposal ${id}`);
  out(`chain> the agreement is active (version ${(await w.agreement.methods.get_version().simulate({ from: w.buyer })).result})`);

  // 5. Money moves.
  scene("funding", "LONE STAR ASSEMBLY · buyer", "The buyer's agent needs settlement tokens. It asks its person through the funding service. This is a simulation: no bank is linked and no real money moves.");
  const provider = new SimulatedFundingProvider({
    baseUrl: "http://127.0.0.1:8090", maxAmountCents: 1_000_000n,
    mint: async (a, c) => { await w.token.methods.mint_publicly(w.buyerAgent, c).send(w.o(w.buyer)); void a; },
  });
  const req = await provider.requestFunding(w.buyerAgent.toString(), 100_000n);
  out(`agent> funding request ${req.id.slice(0, 8)}… for ${money(req.amountCents)}  →  ${req.url.slice(0, 40)}…  (${req.status})`);
  await provider.approve(req.id);
  out(`agent> Dana approves it. ${money(100_000n)} of test tokens are minted to the buyer's agent.`);
  const show = async (label: string) => out(`chain> ${label.padEnd(13)} buyer agent ${money(await w.bal(w.buyerAgent)).padStart(8)}  escrow ${money(await w.bal(w.escrow.address)).padStart(8)}  Trinity ${money(await w.bal(w.supplier)).padStart(8)}`);
  await show("funded");

  scene("order", "LONE STAR ASSEMBLY · buyer agent", "The buyer's agent orders 40 units at the signed price. The contract fixes the amount: quantity times the signed price, nothing the agent can change.");
  const qty = 40n;
  const total = await w.placeAndFund(1n, qty, terms.price_cents);
  out(`chain> order 1: ${qty} units × ${money(terms.price_cents)} = ${money(total)} moved into escrow`);
  await show("order placed");

  scene("pay", "THE ESCROW", "Trinity ships and the carrier confirms. The escrow pays in milestones set by the signed terms. Nobody can pay more or less.");
  const pct = (b: bigint) => `${Number(b) / 100}%`;
  await w.ship(1n);
  out(`chain> shipment confirmed by the supplier's agent and the carrier: ${pct(terms.ship_bps)} released (on time, so no price cut)`);
  await show("shipped");
  await w.receive(1n);
  out(`chain> receipt confirmed by the buyer's agent and the carrier: ${pct(terms.receive_bps)} released`);
  await show("received");
  await w.escrow.methods.attest_inspected(1n).send(w.o(w.buyerAgent));
  out(`chain> the buyer accepts the goods: the remaining ${pct(10000n - terms.ship_bps - terms.receive_bps)} is released and the order closes`);
  await show("inspected");
  const paid = await w.bal(w.supplier);
  if (paid !== total) throw new Error(`supplier received ${paid}, expected ${total}`);

  scene("end", "RELNET", `Trinity received exactly ${money(total)} = 40 × ${money(terms.price_cents)}, in three milestone payments, with no bank. If shipment had been late, the signed rule would have cut the price automatically (see npm run demo).`);
  note("Limits: local test network, test tokens, a simulated funding service, two companies on one computer. No fee saving is measured: fees are sponsored on this network.");
  out("@@end");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nSTORY FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
