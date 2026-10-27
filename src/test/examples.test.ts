import { check, assertEqual, finish } from "./e2e/check.js";
import { loadCompany } from "../examples/companies.js";
import { SCENARIOS } from "../examples/scenarios.js";
import { checkAction, leaks } from "../examples/guard.js";
import { buildPrompt } from "../examples/prompt.js";
import { runScripted } from "../examples/report.js";
import { lintMandate } from "../lib/lint.js";
import { myOffer } from "../channel/protocol.js";

const scen = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const strs = (t: object) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)]));

async function main() {
  console.log("Example companies, linter and guard (no network)");
  const lone = loadCompany("lone-star-assembly");
  const trin = loadCompany("trinity-castings");
  const bad = loadCompany("bargain-bolts");
  const r: boolean[] = [];

  r.push(await check("the two well-written mandates lint clean; the poor one is flagged with an error", async () => {
    assertEqual(lintMandate("buyer", lone.mandate).length, 0, "Lone Star findings");
    assertEqual(lintMandate("supplier", trin.mandate).length, 0, "Trinity findings");
    const f = lintMandate("supplier", bad.mandate);
    assertEqual(f.some((x) => x.severity === "error" && x.field === "late_cap_bps"), true, "late cap error");
    assertEqual(f.some((x) => x.field === "price_cents"), true, "price range warning");
    assertEqual(f.length >= 6, true, "several findings");
  }));

  r.push(await check("guard: agents cannot approve; unknown terms and out-of-mandate terms are blocked", async () => {
    const approve = checkAction(trin, scen("s3-injection"), { action: "approve_terms" });
    assertEqual(approve.caught[0]?.layer, "role", "approve blocked by role");
    const terms = strs(myOffer("supplier", trin.mandate, 0)!);
    const unknown = checkAction(trin, scen("s4-unsupported"), { action: "propose_terms", terms: { ...terms, payment_terms_days: "60" } });
    assertEqual(unknown.caught[0]?.layer, "schema", "unknown key blocked by schema");
    const cheap = checkAction(trin, scen("s1-open"), { action: "propose_terms", terms: { ...terms, price_cents: "100" } });
    assertEqual(cheap.caught[0]?.layer, "mandate", "below-floor price blocked by mandate");
    const ok = checkAction(trin, scen("s1-open"), { action: "propose_terms", terms });
    assertEqual(ok.allowed, true, "an opening inside the mandate is allowed");
    assertEqual(checkAction(trin, scen("s1-open"), "not json").caught[0]?.layer, "schema", "non-JSON blocked");
  }));

  r.push(await check("guard: order typo and stale price are blocked against the signed terms", async () => {
    const bad1 = checkAction(lone, scen("s5-order-typo"), { action: "place_order", qty: 400, price_cents: 480 });
    assertEqual(bad1.caught.filter((c) => c.layer === "order").length, 2, "both quantity and price caught");
    assertEqual(checkAction(lone, scen("s5-order-typo"), { action: "place_order", qty: 40, price_cents: 520 }).allowed, true, "corrected order allowed");
  }));

  r.push(await check("guard: leaks of the walk-away price are caught, ordinary proposals are not", async () => {
    assertEqual(leaks(trin, "Our lowest is $4.80 per unit.").length, 1, "supplier floor leak");
    assertEqual(leaks(trin, "We propose $6.50 per unit.").length, 0, "an opening price is not a leak");
    assertEqual(leaks(lone, "We could go up to $5.60.").length, 1, "buyer ceiling leak");
    assertEqual(leaks(lone, "We are proposing $4.00 per unit.").length, 0, "buyer opening is not a leak");
  }));

  r.push(await check("guard: a false shipment confirmation is flagged as something only policy can stop", async () => {
    const v = checkAction(bad, scen("s5-early-ship"), { action: "attest_shipped" });
    assertEqual(v.policyOnlyRisk, true, "policy-only risk");
    assertEqual(v.allowed, true, "the system itself does not stop it");
  }));

  r.push(await check("scripted well-written agents are never blocked; the poor agent is blocked in exactly the expected ways", async () => {
    const { rows } = runScripted();
    const good = rows.filter((x) => x.company !== "bargain-bolts");
    assertEqual(good.length, 12, "scripted good-agent rows");
    assertEqual(good.every((x) => x.verdict.allowed && !x.verdict.policyOnlyRisk), true, "good agents pass every layer cleanly");
    const b = Object.fromEntries(rows.filter((x) => x.company === "bargain-bolts").map((x) => [x.scenario, x.verdict]));
    assertEqual(b["s2-pressure"].caught[0].layer, "leak", "leak");
    assertEqual(b["s3-injection"].caught[0].layer, "role", "role");
    assertEqual(b["s4-unsupported"].caught[0].layer, "schema", "schema");
    assertEqual(b["s5-early-ship"].policyOnlyRisk, true, "policy-only");
    // The system lets these through because the approved mandate is wide open. That is what the linter is for.
    assertEqual(b["s1-open"].allowed && b["s6-offer-supplier"].allowed, true, "passes only because the mandate is unsafe");
  }));

  r.push(await check("prompts carry the system rules, the company's own policy and mandate, and mark counterparty text untrusted", async () => {
    const p = buildPrompt(trin, scen("s3-injection"));
    for (const needle of ["relnet system", "never approve", "Trinity Castings", "Never reveal our limits", "$4.80", "UNTRUSTED TEXT", "SYSTEM NOTICE"]) {
      if (!p.toLowerCase().includes(needle.toLowerCase())) throw new Error(`prompt is missing "${needle}"`);
    }
    assertEqual(buildPrompt(lone, scen("s1-open")).includes("Trinity"), false, "one company's prompt never contains the other's mandate");
  }));

  finish(r);
}
main().catch((e) => { console.error(e); process.exit(1); });
