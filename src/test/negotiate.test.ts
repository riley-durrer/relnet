import { check, assertEqual, finish } from "./e2e/check.js";
import { negotiate, reviewProposal, EXAMPLE_BUYER_MANDATE as B, EXAMPLE_SUPPLIER_MANDATE as S, Mandate } from "../agents/negotiate.js";
import { parseTerms, validateTerms, summarizeTerms, EXAMPLE_TERMS } from "../lib/terms.js";

async function main() {
  console.log("Terms and negotiation (no network)");
  const r: boolean[] = [];

  r.push(await check("example mandates reach a deal that satisfies both mandates and the contract's bounds", async () => {
    const res = negotiate(B, S);
    if (!res.ok) throw new Error(res.reason);
    assertEqual(validateTerms(res.terms).length, 0, "contract-valid terms");
    assertEqual(reviewProposal(B, res.terms).withinMandate, true, "inside buyer mandate");
    assertEqual(reviewProposal(S, res.terms).withinMandate, true, "inside supplier mandate");
    assertEqual(res.terms.volume_min, 20n, "band overlap min");
    assertEqual(res.terms.volume_max, 100n, "band overlap max");
  }));

  r.push(await check("negotiation is deterministic", async () => {
    const a = negotiate(B, S), b = negotiate(B, S);
    assertEqual(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)), "same inputs, same result");
  }));

  r.push(await check("walks away when ranges do not overlap, naming the field", async () => {
    const stingy: Mandate = { ...B, ranges: { ...B.ranges, price_cents: { min: 100n, max: 300n } } };
    const res = negotiate(stingy, S);
    assertEqual(res.ok, false, "no deal");
    if (res.ok || !res.reason.includes("price_cents")) throw new Error("reason should name price_cents");
  }));

  r.push(await check("walks away when order-size ranges do not overlap", async () => {
    const res = negotiate({ ...B, volume: { min: 500n, max: 900n } }, S);
    assertEqual(res.ok, false, "no deal");
  }));

  r.push(await check("review flags every field outside a mandate", async () => {
    const res = negotiate(B, S);
    if (!res.ok) throw new Error(res.reason);
    const greedy = { ...res.terms, price_cents: 9999n, late_cap_bps: 0n };
    const review = reviewProposal(B, greedy);
    assertEqual(review.withinMandate, false, "rejected");
    assertEqual(review.violations.length, 2, "two violations");
  }));

  r.push(await check("parseTerms accepts strings and numbers, rejects junk and unknown keys", async () => {
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(EXAMPLE_TERMS)) raw[k] = v.toString();
    assertEqual(parseTerms(raw).price_cents, 500n, "parsed");
    const bad = (x: unknown) => { try { parseTerms(x); return false; } catch { return true; } };
    assertEqual(bad({ ...raw, price_cents: "5.5" }), true, "decimal");
    assertEqual(bad({ ...raw, price_cents: "-1" }), true, "negative");
    assertEqual(bad({ ...raw, hack: "1" }), true, "unknown key");
    assertEqual(bad({ ...raw, price_cents: undefined }), true, "missing");
    assertEqual(bad("not an object"), true, "non-object");
  }));

  r.push(await check("validateTerms mirrors the contract bounds and summary mentions the late rule", async () => {
    assertEqual(validateTerms({ ...EXAMPLE_TERMS, ship_bps: 6000n, receive_bps: 5000n }).length > 0, true, "shares over 100%");
    assertEqual(validateTerms({ ...EXAMPLE_TERMS, volume_min: 200n }).length > 0, true, "inverted band");
    assertEqual(validateTerms(EXAMPLE_TERMS).length, 0, "example is valid");
    const text = summarizeTerms(EXAMPLE_TERMS).join(" ");
    assertEqual(text.includes("$5.00 per unit"), true, "price in summary");
    assertEqual(text.includes("refunded to the buyer automatically"), true, "late rule in summary");
  }));

  finish(r);
}
main().catch((e) => { console.error(e); process.exit(1); });
