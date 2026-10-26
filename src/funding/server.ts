import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { FundingProvider, FundingRequest } from "./provider.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (r: FundingRequest) => ({ ...r, amountCents: r.amountCents.toString() });

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 10_000) throw new Error("body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Local funding-request service. Agents POST a request and hand the returned `url` to a
 * human; an admin approves via the admin endpoints. SIMULATED: no bank, no real funds.
 * Binds to 127.0.0.1 only; admin routes need the `x-admin-token` header.
 */
export function createFundingServer(provider: FundingProvider, adminToken: string): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const isAdmin = tokenOk(req.headers["x-admin-token"] as string | undefined, adminToken);

      if (req.method === "POST" && url.pathname === "/funding-requests") {
        const body = await readJson(req);
        if (typeof body.address !== "string" || !/^\d+$/.test(String(body.amountCents))) {
          return send(res, 400, { error: "need address (string) and amountCents (integer)" });
        }
        const r = await provider.requestFunding(body.address, BigInt(body.amountCents));
        return send(res, 201, json(r));
      }
      if (req.method === "GET" && parts[0] === "funding-requests" && parts.length === 2) {
        const r = await provider.getRequest(parts[1]);
        return r ? send(res, 200, json(r)) : send(res, 404, { error: "not found" });
      }
      if (req.method === "GET" && parts[0] === "pay" && parts.length === 2) {
        const r = await provider.getRequest(parts[1]);
        if (!r) return send(res, 404, "Not found", "text/plain");
        return send(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>Funding request</title>
<h1>Funding request (simulated)</h1>
<p>Address: <code>${esc(r.address)}</code></p>
<p>Amount: ${esc(r.amountCents.toString())} cents</p>
<p>Status: <b>${esc(r.status)}</b></p>
<p>This is a demo. No bank is linked and no real money moves. A production deployment
would hand off here to a licensed on-ramp (KYC, bank link, fiat to stablecoin).</p>`,
          "text/html",
        );
      }
      if (parts[0] === "admin") {
        if (!isAdmin) return send(res, 401, { error: "admin token required" });
        if (req.method === "GET" && parts[1] === "funding-requests") {
          return send(res, 200, (await provider.listRequests()).map(json));
        }
        if (req.method === "POST" && parts[1] === "funding-requests" && parts.length === 4) {
          if (parts[3] === "approve") return send(res, 200, json(await provider.approve(parts[2])));
          if (parts[3] === "reject") {
            const body = await readJson(req);
            return send(res, 200, json(await provider.reject(parts[2], body.note)));
          }
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
}
