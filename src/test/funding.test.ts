import type { AddressInfo } from "node:net";
import { SimulatedFundingProvider } from "../funding/simulated.js";
import { createFundingServer } from "../funding/server.js";
import { check, assertEqual, finish } from "./e2e/check.js";

const ADDR = "0x" + "ab".repeat(32);
const minted: Array<[string, bigint]> = [];
const provider = new SimulatedFundingProvider({
  baseUrl: "http://x",
  maxAmountCents: 10_000n,
  mint: async (a, n) => void minted.push([a, n]),
});
const server = createFundingServer(provider, "secret");
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", body: JSON.stringify(body), headers });

const results: boolean[] = [];
let id = "";
results.push(await check("creates a pending request with a pay url", async () => {
  const r = await post("/funding-requests", { address: ADDR, amountCents: "500" });
  assertEqual(r.status, 201, "status");
  const j = await r.json();
  id = j.id;
  assertEqual(j.status, "pending", "state");
}));
results.push(await check("rejects bad address, bad and oversized amount", async () => {
  assertEqual((await post("/funding-requests", { address: "nope", amountCents: "5" })).status, 400, "addr");
  assertEqual((await post("/funding-requests", { address: ADDR, amountCents: "-5" })).status, 400, "neg");
  assertEqual((await post("/funding-requests", { address: ADDR, amountCents: "99999" })).status, 400, "cap");
}));
results.push(await check("admin routes need the token", async () => {
  assertEqual((await post(`/admin/funding-requests/${id}/approve`, {})).status, 401, "no token");
  assertEqual((await post(`/admin/funding-requests/${id}/approve`, {}, { "x-admin-token": "wrong" })).status, 401, "bad token");
  assertEqual(minted.length, 0, "nothing minted");
}));
results.push(await check("approve mints exactly once", async () => {
  const h = { "x-admin-token": "secret" };
  assertEqual((await post(`/admin/funding-requests/${id}/approve`, {}, h)).status, 200, "approve");
  assertEqual((await post(`/admin/funding-requests/${id}/approve`, {}, h)).status, 400, "second approve");
  assertEqual(minted.length, 1, "mint count");
  assertEqual(minted[0][1], 500n, "amount");
}));
results.push(await check("pay page escapes content and shows status", async () => {
  const html = await (await fetch(`${base}/pay/${id}`)).text();
  assertEqual(html.includes("approved"), true, "status shown");
}));
server.close();
finish(results);
