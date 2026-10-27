// Local operator UI server: `npm run ui`, then open http://127.0.0.1:8100.
// Runs on the user's own machine against their own sandbox. Nothing is hosted.
// Deploys a fresh demo deployment at boot and exposes a small JSON API for the page.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { RelnetAgreementContract } from "../artifacts/RelnetAgreement.js";
import { RelnetCoinContract } from "../artifacts/RelnetCoin.js";
import { RelnetEscrowContract } from "../artifacts/RelnetEscrow.js";
import { RelnetPerformanceProofContract } from "../artifacts/RelnetPerformanceProof.js";
import { getSponsoredFeePaymentMethod } from "../utils/sponsored_fee.js";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const PORT = Number(process.env.PORT ?? 8100);
const SHIP_BY = 4102444800n;
const PRICE = 500n;
const VOL_MIN = 10n;
const VOL_MAX = 100n;

type Stage = "funded" | "shipped" | "received" | "closed";
interface CallOff {
  id: number;
  qty: number;
  amountCents: number;
  stage: Stage;
  paidCents: number;
  absorbed: boolean;
}
interface LogEntry {
  t: string;
  text: string;
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const callOffs: CallOff[] = [];
const log: LogEntry[] = [];
let busy: string | null = null;
let nextId = 1;
let provenThreshold = 0;

const say = (text: string) => {
  log.unshift({ t: new Date().toLocaleTimeString(), text });
  log.length = Math.min(log.length, 50);
};

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const hit = m.match(/Assertion failed: ([^'\n]+)/);
  return (hit ? hit[1] : m.split("\n")[0]).slice(0, 200).trim();
}

async function boot() {
  const wallet = await EmbeddedWallet.create(createAztecNodeClient(NODE_URL), { ephemeral: true });
  const pm = await getSponsoredFeePaymentMethod(wallet as any);
  const opts = (from: AztecAddress) => ({ from, fee: { paymentMethod: pm } });
  const acct = async (d: any) => (await wallet.createSchnorrInitializerlessAccount(d.secret, d.salt, d.signingKey)).address;

  const base = await getInitialTestAccountsData();
  const buyer = await acct(base[0]);
  const supplier = await acct(base[1]);
  const carrier = await acct(base[2]);
  const [mData, aData] = await generateSchnorrAccounts(2);
  const mallory = await acct(mData);
  const arbiter = await acct(aData);

  const { contract: token } = await RelnetCoinContract.deploy(wallet, buyer).send(opts(buyer));
  const { contract: pp } = await RelnetPerformanceProofContract.deploy(wallet, buyer).send(opts(buyer));
  const { contract: escrow } = await RelnetEscrowContract.deploy(wallet, token.address, arbiter, pp.address).send(opts(buyer));
  await pp.methods.set_escrow(escrow.address).send(opts(buyer));
  const { contract: agreement } = await RelnetAgreementContract.deploy(wallet, buyer, supplier, PRICE, VOL_MIN, VOL_MAX).send(opts(buyer));
  await token.methods.mint_publicly(buyer, 10_000_000n).send(opts(buyer));

  const bal = async (a: AztecAddress) => Number((await token.methods.balance_of(a).simulate({ from: buyer })).result);
  const find = (id: number) => callOffs.find((c) => c.id === id);

  async function placeCallOff(qty: number) {
    const id = nextId++;
    const amount = BigInt(qty) * PRICE;
    await agreement.methods.place_call_off(BigInt(qty), PRICE).send(opts(buyer));
    await token.methods.transfer_public(escrow.address, amount).send(opts(buyer));
    await escrow.methods.fund_call_off(BigInt(id), supplier, carrier, amount, SHIP_BY).send(opts(buyer));
    callOffs.push({ id, qty, amountCents: Number(amount), stage: "funded", paidCents: 0, absorbed: false });
    say(`Call-off #${id} accepted: ${qty} units at ${PRICE} cents, ${amount} cents escrowed.`);
  }

  async function advance(id: number) {
    const c = find(id);
    if (!c) throw new Error("No such call-off");
    const n = BigInt(id);
    if (c.stage === "funded") {
      await escrow.methods.attest_shipped(n).send(opts(supplier));
      await escrow.methods.attest_shipped(n).send(opts(carrier));
      c.stage = "shipped";
      say(`#${id} shipped (supplier and carrier both attested). 30% released.`);
    } else if (c.stage === "shipped") {
      await escrow.methods.attest_received(n).send(opts(buyer));
      await escrow.methods.attest_received(n).send(opts(carrier));
      c.stage = "received";
      say(`#${id} received (buyer and carrier both attested). 50% released.`);
    } else if (c.stage === "received") {
      await escrow.methods.attest_inspected(n).send(opts(buyer));
      c.stage = "closed";
      say(`#${id} inspected by buyer. Remaining 20% released; call-off closed.`);
    } else {
      throw new Error("Call-off is closed");
    }
    const remaining = Number((await escrow.methods.get_remaining(n).simulate({ from: buyer })).result);
    c.paidCents = c.amountCents - remaining;
  }

  async function prove(threshold: number) {
    await token.methods.transfer_public(buyer, 0n).send(opts(buyer)); // let recorded outcomes settle
    for (const c of callOffs) {
      if (c.stage !== "funded" && !c.absorbed) {
        await pp.methods.absorb_outcome(BigInt(c.id), true).send(opts(supplier));
        c.absorbed = true;
      }
    }
    try {
      await pp.methods.prove_on_time_rate(BigInt(threshold)).send(opts(supplier));
    } catch (e) {
      say(`Proof of >= ${threshold}% on time FAILED: ${reason(e)}`);
      return { ok: false, reason: reason(e) };
    }
    provenThreshold = Number((await pp.methods.get_proven_threshold(supplier).simulate({ from: buyer })).result);
    say(`Supplier proved >= ${provenThreshold}% on time. Counts and dates stay private.`);
    return { ok: true };
  }

  const attacks: Record<string, { label: string; run: () => Promise<unknown> }> = {
    qty: { label: "Order 9999 units (outside the 10-100 band)", run: () => agreement.methods.place_call_off(9999n, PRICE).send(opts(supplier)) },
    price: { label: "Order at 1 cent (not the agreed 500)", run: () => agreement.methods.place_call_off(50n, 1n).send(opts(supplier)) },
    stranger: { label: "A stranger places an order", run: () => agreement.methods.place_call_off(50n, PRICE).send(opts(mallory)) },
    mint: { label: "A stranger mints tokens", run: () => token.methods.mint_publicly(mallory, 1_000_000n).send(opts(mallory)) },
    forge: { label: "Forge an on-time delivery record", run: () => pp.methods.record_outcome(999n, true).send(opts(mallory)) },
    unfunded: { label: "Open a call-off with no money sent", run: () => escrow.methods.fund_call_off(9000n, supplier, carrier, 5000n, SHIP_BY).send(opts(buyer)) },
    arbiter: { label: "A stranger acts as arbiter", run: () => escrow.methods.arbiter_resolve(9001n, mallory, 100n).send(opts(mallory)) },
    reuse: {
      label: "Re-use a closed call-off",
      run: async () => {
        const closed = callOffs.find((c) => c.stage === "closed");
        if (!closed) throw new Error("Finish a call-off first, then try this attack");
        return escrow.methods.attest_shipped(BigInt(closed.id)).send(opts(mallory));
      },
    },
  };

  async function state() {
    return {
      terms: { priceCents: Number(PRICE), volumeMin: Number(VOL_MIN), volumeMax: Number(VOL_MAX) },
      callOffs,
      balances: { buyer: await bal(buyer), supplier: await bal(supplier), escrow: await bal(escrow.address) },
      provenThreshold,
      attacks: Object.entries(attacks).map(([key, a]) => ({ key, label: a.label })),
      busy,
      log,
    };
  }

  say("Deployment ready. All entities are fictional; this is a local test network.");

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

      if (req.url === "/api/call-off") {
        const qty = Number(body.qty);
        if (!Number.isInteger(qty) || qty <= 0) return json(res, 400, { error: "qty must be a positive integer" });
        // Out-of-band quantities are sent on purpose: the contract, not this server, rejects them.
        try {
          await exclusive("Placing call-off on-chain", () => placeCallOff(qty));
          return json(res, 200, { ok: true });
        } catch (e: any) {
          if (e.status === 409) throw e;
          say(`Call-off of ${qty} units REJECTED by the contract: ${reason(e)}`);
          return json(res, 200, { ok: false, reason: reason(e) });
        }
      }
      if (req.url === "/api/advance") {
        const id = Number(body.id);
        await exclusive("Settling milestone on-chain", () => advance(id));
        return json(res, 200, { ok: true });
      }
      if (req.url === "/api/prove") {
        const t = Number(body.threshold);
        if (!Number.isInteger(t) || t < 0 || t > 100) return json(res, 400, { error: "threshold must be 0-100" });
        return json(res, 200, await exclusive("Generating zero-knowledge proof", () => prove(t)));
      }
      if (req.url === "/api/attack") {
        const a = attacks[String(body.key)];
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
              say(`Attack blocked: ${a.label}. Reason: ${reason(e)}`);
              return { blocked: true, reason: reason(e) };
            }
          }),
        );
      }
      return json(res, 404, { error: "Not found" });
    } catch (e: any) {
      json(res, e.status ?? 500, { error: reason(e) });
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`relnet operator UI: http://127.0.0.1:${PORT}`));
}

console.log("Deploying contracts to the local network (about 30 seconds)...");
boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
