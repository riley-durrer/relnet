import { loadCompany, listCompanies, Company } from "./companies.js";
import { SCENARIOS } from "./scenarios.js";
import { checkAction } from "./guard.js";
import { scripted } from "./fixtures.js";
import { lintMandate } from "../lib/lint.js";
import type { Verdict } from "./types.js";

export interface Row {
  company: string;
  scenario: string;
  title: string;
  action: string;
  verdict: Verdict;
}

export function runScripted(): { rows: Row[]; companies: Company[] } {
  const companies = listCompanies().map(loadCompany);
  const rows: Row[] = [];
  for (const c of companies) {
    for (const s of SCENARIOS.filter((x) => x.sides.includes(c.side))) {
      const raw = scripted(c, s.id);
      if (!raw) continue;
      rows.push({ company: c.id, scenario: s.id, title: s.title, action: JSON.parse(raw).action, verdict: checkAction(c, s, raw) });
    }
  }
  return { rows, companies };
}

export function describe(v: Verdict, riskyMandate = false): string {
  if (v.caught.length) return `BLOCKED by ${v.caught.map((c) => c.layer).join("+")}`;
  if (v.policyOnlyRisk) return "NOT BLOCKED: only the company's policy can stop this";
  return riskyMandate ? "allowed, but only because the approved limits are unsafe (see lint)" : "allowed";
}

export function printReport() {
  const { rows, companies } = runScripted();
  console.log("Example agents: scripted outputs checked against every layer of the system");
  console.log("(Outputs are hand-written examples, not observed model behavior.)\n");
  for (const c of companies) {
    console.log(`${c.name} (${c.side}, policy: ${c.id}/policy.md)`);
    const lint = lintMandate(c.side, c.mandate);
    console.log(`  mandate lint: ${lint.length === 0 ? "no findings" : lint.length + " finding(s)"}`);
    for (const f of lint) console.log(`    [${f.severity}] ${f.field}: ${f.message}`);
    const risky = lint.some((f) => f.severity === "error");
    for (const r of rows.filter((x) => x.company === c.id)) {
      console.log(`  ${r.scenario.padEnd(18)} ${r.action.padEnd(15)} ${describe(r.verdict, risky)}`);
      for (const k of r.verdict.caught) console.log(`  ${"".padEnd(18)} -> ${k.layer}: ${k.reason}`);
    }
    console.log("");
  }
  const blocked = rows.filter((r) => r.verdict.caught.length).length;
  const risk = rows.filter((r) => r.verdict.policyOnlyRisk).length;
  console.log(`${rows.length} scripted actions: ${rows.filter((r) => r.verdict.allowed && !r.verdict.policyOnlyRisk).length} allowed, ${blocked} blocked by the system, ${risk} that only the company's own policy could stop.`);
  console.log("The system protects only as well as the limits a person approves: lint them before approving.");
}
