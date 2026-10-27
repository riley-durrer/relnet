// Local operator UI server: `npm run ui`, then open http://127.0.0.1:8100.
// Runs on the user's own machine against their own local network. Nothing is hosted.
// Flow: agents negotiate inside human-set mandates -> proposal on-chain -> both people sign ->
// agents operate the deal. All state is in memory; every start is a fresh deployment.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terms, summarizeTerms } from "../lib/terms.js";
import { setup, World } from "../lib/world.js";
import { Mandate, EXAMPLE_BUYER_MANDATE, EXAMPLE_SUPPLIER_MANDATE } from "../agents/negotiate.js";
import { createIdentity, pinPeer } from "../channel/identity.js";
import { startResponder, negotiateOverA2A } from "../channel/a2a.js";
import { withinLimits } from "../channel/protocol.js";
import { randomUUID } from "node:crypto";
import { DecisionLog, revertReason, scaleTime } from "../agents/runtime.js";

const PORT = Number(process.env.PORT ?? 8100);
// The local network advances ~72 chain seconds per block; one demo "day" is one block.
const DAY_SECS = 72n;
const DAY = 86400n;

type Stage = "funded" | "shipped" | "received" | "closed";
interface CallOff {
  id: number;
  qty: number;
  valueCents: number;
  totalCents: number;
  stage: Stage;
  paidCents: number;
  late: boolean;
  absorbed: boolean;
}
type Phase = "setup" | "negotiated" | "proposed" | "active";

const dir = path.dirname(fileURLToPath(import.meta.url));
const log = new DecisionLog();
const activity: { t: string; text: string }[] = [];
const say = (text: string) => {
  activity.unshift({ t: new Date().toLocaleTimeString(), text });
  activity.length = Math.min(activity.length, 60);
};
log.onAdd = (d) => say(`[${d.agent}] ${d.action}${d.detail ? ` (${d.result}: ${d.detail})` : ""}`);

let phase: Phase = "setup";
let busy: string | null = null;
let world: World | null = null;
let negotiated: { terms: Terms; lines: string[]; rounds: number } | null = null;
let negotiationNote = "";
let signed = { buyer: false, supplier: false };
const callOffs: CallOff[] = [];
let nextId = 1;
let provenThreshold = 0;
let attackSeq = 1000;
let clockStart = 0;

const mandates: { buyer: Mandate; supplier: Mandate } = {
  buyer: structuredClone(EXAMPLE_BUYER_MANDATE),
  supplier: structuredClone(EXAMPLE_SUPPLIER_MANDATE),
};

const cents = (c: number | bigint) => `$${(Number(c) / 100).toFixed(2)}`;

/** The three fields a person edits in the UI; everything else keeps the example mandate's values. */
function applyMandateInput(side: "buyer" | "supplier", input: any) {
  const m = mandates[side];
  const int = (v: unknown, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  const priceMin = BigInt(Math.round(int(input.priceMin, "price min") * 100));
  const priceMax = BigInt(Math.round(int(input.priceMax, "price max") * 100));
  const shipMin = BigInt(Math.round(int(input.shipDaysMin, "ship-by min") * 86400));
  const shipMax = BigInt(Math.round(int(input.shipDaysMax, "ship-by max") * 86400));
  const capMin = BigInt(Math.round(int(input.lateCapMin, "late cap min") * 100));
  const capMax = BigInt(Math.round(int(input.lateCapMax, "late cap max") * 100));
  if (priceMin > priceMax || shipMin > shipMax || capMin > capMax) throw new Error("Each minimum must not exceed its maximum");
  if (priceMin === 0n) throw new Error("Price must be above zero");
  if (capMax > 10000n) throw new Error("Late cap cannot exceed 100%");
  m.ranges.price_cents = { min: priceMin, max: priceMax };
  m.ranges.lead_time_secs = { min: shipMin, max: shipMax };
  m.ranges.late_cap_bps = { min: capMin, max: capMax };
}

function mandateView(m: Mandate) {
  return {
    company: m.company,
    priceMin: Number(m.ranges.price_cents.min) / 100,
    priceMax: Number(m.ranges.price_cents.max) / 100,
    shipDaysMin: Number(m.ranges.lead_time_secs.min / DAY),
    shipDaysMax: Number(m.ranges.lead_time_secs.max / DAY),
    lateCapMin: Number(m.ranges.late_cap_bps.min) / 100,
    lateCapMax: Number(m.ranges.late_cap_bps.max) / 100,
  };
}

async function state() {
  const w = world;
  let version = 0;
  let chainTime = 0;
  let balances = { buyer: 0, supplier: 0, escrow: 0 };
  if (w) {
    version = Number((await w.agreement.methods.get_version().simulate({ from: w.buyer })).result);
    chainTime = Number(await w.chainNow());
    balances = {
      buyer: Number(await w.bal(w.buyer)) + Number(await w.bal(w.buyerAgent)),
      supplier: Number(await w.bal(w.supplier)),
      escrow: Number(await w.bal(w.escrow.address)),
    };
  }
  return {
    phase,
    busy,
    mandates: { buyer: mandateView(mandates.buyer), supplier: mandateView(mandates.supplier) },
    negotiation: negotiated ? { lines: negotiated.lines, rounds: negotiated.rounds } : null,
    negotiationNote,
    signed,
    agreementVersion: version,
    chainTime,
    clockStart,
    dayLength: Number(DAY_SECS),
    callOffs,
    balances,
    provenThreshold,
    attacks: attackDefs().map((a) => ({ key: a.key, label: a.label })),
    log: activity,
  };
}

async function refreshCallOff(c: CallOff) {
  const w = world!;
  const id = BigInt(c.id);
  const remaining = Number((await w.escrow.methods.get_remaining(id).simulate({ from: w.buyer })).result);
  c.totalCents = Number((await w.escrow.methods.get_total(id).simulate({ from: w.buyer })).result);
  c.paidCents = c.totalCents - remaining;
  c.late = c.totalCents < c.valueCents;
}

async function negotiateNow() {
  // Two agents, each holding only its own mandate, negotiate over real A2A with signed offers.
  const buyerKey = await createIdentity();
  const supplierKey = await createIdentity();
  const dealId = randomUUID();
  const onEvent = (e: { who: string; text: string }) => say(`[${e.who}] ${e.text}`);
  const buyerPin = await pinPeer({ fingerprint: buyerKey.fingerprint, publicJwk: buyerKey.publicJwk, url: "" });
  const supplierAgent = await startResponder({ side: "supplier", mandate: mandates.supplier, identity: supplierKey, peer: buyerPin, dealId, name: "supplier agent", onEvent });
  const supplierPin = await pinPeer({ fingerprint: supplierKey.fingerprint, publicJwk: supplierKey.publicJwk, url: supplierAgent.url });
  let outcome;
  try {
    outcome = await negotiateOverA2A({ side: "buyer", mandate: mandates.buyer, identity: buyerKey, peer: supplierPin, dealId, name: "buyer agent", onEvent });
  } finally {
    await supplierAgent.close();
  }
  if (!outcome.ok) {
    negotiated = null;
    negotiationNote = `No deal: ${outcome.reason}`;
    say(negotiationNote);
    phase = "setup";
    return;
  }
  if (!withinLimits("buyer", mandates.buyer, outcome.terms) || !withinLimits("supplier", mandates.supplier, outcome.terms)) {
    throw new Error("Internal error: negotiated terms fall outside a mandate");
  }
  negotiated = { terms: outcome.terms, lines: summarizeTerms(outcome.terms), rounds: outcome.rounds };
  negotiationNote = `Agents agreed at round ${outcome.rounds} over A2A with signed offers. Each saw only its own limits. Agent keys: buyer ${buyerKey.fingerprint.slice(0, 10)}…, supplier ${supplierKey.fingerprint.slice(0, 10)}….`;
  say(negotiationNote);
  phase = "negotiated";
}

async function proposeOnChain() {
  if (!negotiated) throw new Error("Negotiate first");
  const onChain = scaleTime(negotiated.terms, DAY_SECS);
  world = await setup(onChain, false);
  clockStart = Number(await world.chainNow());
  callOffs.length = 0;
  nextId = 1;
  provenThreshold = 0;
  signed = { buyer: false, supplier: false };
  phase = "proposed";
  say("Terms are on-chain as a proposal. Nothing is binding until both people sign.");
}

async function sign(who: "buyer" | "supplier") {
  const w = world!;
  const id = await w.proposalId();
  await w.agreement.methods.approve_terms(id).send(w.o(who === "buyer" ? w.buyer : w.supplier));
  signed[who] = true;
  const v = Number((await w.agreement.methods.get_version().simulate({ from: w.buyer })).result);
  say(`${who === "buyer" ? mandates.buyer.company : mandates.supplier.company}'s person signed.`);
  if (v > 0) {
    phase = "active";
    say("Both people signed. The agreement is active and agents may place orders.");
  }
}

async function placeCallOff(qty: number) {
  const w = world!;
  const price = w.terms.price_cents;
  const id = nextId;
  try {
    await w.agreement.methods.place_call_off(BigInt(id), BigInt(qty), price).send(w.o(w.buyerAgent));
  } catch (e) {
    say(`Order of ${qty} units REJECTED by the contract: ${revertReason(e)}`);
    return { ok: false, reason: revertReason(e) };
  }
  nextId++;
  const value = BigInt(qty) * price;
  await w.token.methods.transfer_public(w.escrow.address, value).send(w.o(w.buyerAgent));
  await w.escrow.methods.fund_call_off(BigInt(id), w.carrier).send(w.o(w.buyerAgent));
  callOffs.push({ id, qty, valueCents: Number(value), totalCents: Number(value), stage: "funded", paidCents: 0, late: false, absorbed: false });
  say(`Order #${id} accepted: ${qty} units, ${cents(value)} escrowed.`);
  return { ok: true };
}

async function advance(id: number) {
  const w = world!;
  const c = callOffs.find((x) => x.id === id);
  if (!c) throw new Error("No such order");
  const n = BigInt(id);
  if (c.stage === "funded") {
    await w.ship(n);
    c.stage = "shipped";
    await refreshCallOff(c);
    say(c.late ? `#${id} shipped LATE. The signed rule cut the price by ${cents(c.valueCents - c.totalCents)}; the buyer was refunded.` : `#${id} shipped on time.`);
  } else if (c.stage === "shipped") {
    await w.receive(n);
    c.stage = "received";
    await refreshCallOff(c);
    say(`#${id} received.`);
  } else if (c.stage === "received") {
    await w.escrow.methods.attest_inspected(n).send(w.o(w.buyerAgent));
    c.stage = "closed";
    await refreshCallOff(c);
    say(`#${id} inspected. Supplier paid ${cents(c.paidCents)} in total.`);
  } else {
    throw new Error("Order is closed");
  }
}

async function prove(threshold: number) {
  const w = world!;
  await w.tick();
  for (const c of callOffs) {
    if (c.stage !== "funded" && !c.absorbed) {
      await w.pp.methods.absorb_outcome(BigInt(c.id), !c.late).send(w.o(w.supplier));
      c.absorbed = true;
    }
  }
  try {
    await w.pp.methods.prove_on_time_rate(BigInt(threshold)).send(w.o(w.supplier));
  } catch (e) {
    say(`Proof of at least ${threshold}% on time FAILED: ${revertReason(e)}`);
    return { ok: false, reason: revertReason(e) };
  }
  provenThreshold = Number((await w.pp.methods.get_proven_threshold(w.supplier).simulate({ from: w.buyer })).result);
  say(`Supplier proved at least ${provenThreshold}% on time. Counts and dates stay private.`);
  return { ok: true };
}

function attackDefs(): { key: string; label: string; run: () => Promise<unknown> }[] {
  const w = world;
  const fail = async () => {
    throw new Error("Sign the agreement first");
  };
  if (!w || phase !== "active") {
    return ["qty", "price", "stranger", "approve", "mint", "forge", "stale"].map((key) => ({ key, label: attackLabels[key], run: fail }));
  }
  const price = w.terms.price_cents;
  const id = () => BigInt(++attackSeq);
  return [
    { key: "qty", label: attackLabels.qty, run: () => w.agreement.methods.place_call_off(id(), 9999n, price).send(w.o(w.supplierAgent)) },
    { key: "price", label: attackLabels.price, run: () => w.agreement.methods.place_call_off(id(), 50n, 1n).send(w.o(w.supplierAgent)) },
    { key: "stranger", label: attackLabels.stranger, run: () => w.agreement.methods.place_call_off(id(), 50n, price).send(w.o(w.outsider)) },
    {
      key: "approve",
      label: attackLabels.approve,
      run: async () => {
        // Open a proposal so the only thing standing in the way is the rule that agents cannot approve.
        const t = (await w.agreement.methods.get_terms().simulate({ from: w.buyer })).result as Terms;
        await w.agreement.methods.propose_terms(t).send(w.o(w.buyerAgent));
        await w.agreement.methods.approve_terms(await w.proposalId()).send(w.o(w.buyerAgent));
      },
    },
    { key: "mint", label: attackLabels.mint, run: () => w.token.methods.mint_publicly(w.outsider, 1_000_000n).send(w.o(w.outsider)) },
    { key: "forge", label: attackLabels.forge, run: () => w.pp.methods.record_outcome(999n, true).send(w.o(w.supplierAgent)) },
    {
      key: "stale",
      label: attackLabels.stale,
      run: async () => {
        // An agent reviewed proposal N, then someone swaps the terms under the person.
        const t = (await w.agreement.methods.get_terms().simulate({ from: w.buyer })).result as Terms;
        await w.agreement.methods.propose_terms({ ...t, price_cents: 700n }).send(w.o(w.buyerAgent));
        const reviewed = await w.proposalId();
        await w.agreement.methods.propose_terms({ ...t, price_cents: 1n }).send(w.o(w.supplierAgent));
        try {
          await w.agreement.methods.approve_terms(reviewed).send(w.o(w.buyer));
        } finally {
          // Restore the signed terms as an open proposal; the active terms were never touched.
          await w.agreement.methods.propose_terms(t).send(w.o(w.buyerAgent));
        }
      },
    },
  ];
}
const attackLabels: Record<string, string> = {
  qty: "Order 9999 units (outside the signed band)",
  price: "Order at 1 cent (not the signed price)",
  stranger: "A stranger places an order",
  approve: "An agent tries to approve terms by itself",
  mint: "A stranger mints tokens",
  forge: "Forge an on-time delivery record",
  stale: "Swap the terms after a person reviewed them",
};

async function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (busy) throw Object.assign(new Error(`Busy: ${busy}`), { status: 409 });
  busy = label;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > 10_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
const need = (p: Phase[]) => {
  if (!p.includes(phase)) throw Object.assign(new Error(`Not available during "${phase}"`), { status: 409 });
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(path.join(dir, "public", "index.html")));
      return;
    }
    if (req.method === "GET" && req.url === "/api/state") return json(res, 200, await state());
    if (req.method !== "POST") return json(res, 404, { error: "Not found" });
    const body = await readBody(req);

    if (req.url === "/api/negotiate") {
      need(["setup", "negotiated"]);
      applyMandateInput("buyer", body.buyer ?? {});
      applyMandateInput("supplier", body.supplier ?? {});
      await exclusive("Agents negotiating", negotiateNow);
      return json(res, 200, { ok: negotiated !== null, note: negotiationNote });
    }
    if (req.url === "/api/propose") {
      need(["negotiated"]);
      await exclusive("Putting the proposal on-chain", proposeOnChain);
      return json(res, 200, { ok: true });
    }
    if (req.url === "/api/sign") {
      need(["proposed"]);
      if (body.who !== "buyer" && body.who !== "supplier") return json(res, 400, { error: "who must be buyer or supplier" });
      await exclusive("Recording signature on-chain", () => sign(body.who));
      return json(res, 200, { ok: true });
    }
    if (req.url === "/api/call-off") {
      need(["active"]);
      const qty = Number(body.qty);
      if (!Number.isInteger(qty) || qty <= 0) return json(res, 400, { error: "qty must be a positive integer" });
      return json(res, 200, await exclusive("Placing order on-chain", () => placeCallOff(qty)));
    }
    if (req.url === "/api/advance") {
      need(["active"]);
      await exclusive("Settling on-chain", () => advance(Number(body.id)));
      return json(res, 200, { ok: true });
    }
    if (req.url === "/api/days") {
      need(["active"]);
      const n = Number(body.days);
      if (!Number.isInteger(n) || n < 1 || n > 30) return json(res, 400, { error: "days must be 1 to 30" });
      await exclusive("Advancing the demo clock", async () => {
        for (let i = 0; i < n; i++) await world!.tick();
        say(`Demo clock advanced ${n} day${n === 1 ? "" : "s"}.`);
      });
      return json(res, 200, { ok: true });
    }
    if (req.url === "/api/prove") {
      need(["active"]);
      const t = Number(body.threshold);
      if (!Number.isInteger(t) || t < 0 || t > 100) return json(res, 400, { error: "threshold must be 0-100" });
      return json(res, 200, await exclusive("Generating zero-knowledge proof", () => prove(t)));
    }
    if (req.url === "/api/attack") {
      need(["proposed", "active"]);
      const a = attackDefs().find((x) => x.key === body.key);
      if (!a) return json(res, 400, { error: "Unknown attack" });
      return json(
        res,
        200,
        await exclusive("Running attack", async () => {
          try {
            await a.run();
            say(`ATTACK SUCCEEDED (unexpected): ${a.label}`);
            return { blocked: false, reason: "" };
          } catch (e) {
            say(`Attack blocked: ${a.label}. Reason: ${revertReason(e)}`);
            return { blocked: true, reason: revertReason(e) };
          }
        }),
      );
    }
    return json(res, 404, { error: "Not found" });
  } catch (e: any) {
    json(res, e.status ?? 500, { error: revertReason(e) });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`relnet operator UI: http://127.0.0.1:${PORT}`));
say("Ready. Set each company's mandate, then let the agents negotiate. Fictional entities, local test network.");
