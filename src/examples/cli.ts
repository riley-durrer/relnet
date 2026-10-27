// Usage:
//   tsx src/examples/cli.ts report
//   tsx src/examples/cli.ts lint
//   tsx src/examples/cli.ts prompt <company> <scenario>
//   tsx src/examples/cli.ts check  <company> <scenario> <action.json | ->
import { readFileSync } from "node:fs";
import { loadCompany, listCompanies } from "./companies.js";
import { SCENARIOS } from "./scenarios.js";
import { buildPrompt } from "./prompt.js";
import { checkAction } from "./guard.js";
import { describe, printReport } from "./report.js";
import { lintMandate } from "../lib/lint.js";

const [cmd, companyId, scenarioId, file] = process.argv.slice(2);

function need() {
  if (!companyId || !scenarioId) {
    console.error(`Usage: ${cmd} <company> <scenario>\nCompanies: ${listCompanies().join(", ")}\nScenarios: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  const company = loadCompany(companyId);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario "${scenarioId}"`);
  if (!scenario.sides.includes(company.side)) throw new Error(`Scenario ${scenarioId} does not apply to a ${company.side}`);
  return { company, scenario };
}

if (cmd === "report") printReport();
else if (cmd === "lint") {
  for (const id of listCompanies()) {
    const c = loadCompany(id);
    const f = lintMandate(c.side, c.mandate);
    console.log(`${c.name}: ${f.length ? f.length + " finding(s)" : "no findings"}`);
    for (const x of f) console.log(`  [${x.severity}] ${x.field}: ${x.message}`);
  }
} else if (cmd === "prompt") {
  const { company, scenario } = need();
  console.log(buildPrompt(company, scenario));
} else if (cmd === "check") {
  const { company, scenario } = need();
  const raw = file === "-" || !file ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  const v = checkAction(company, scenario, raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  console.log(describe(v));
  for (const k of v.caught) console.log(`  ${k.layer}: ${k.reason}`);
} else {
  console.error("Commands: report | lint | prompt <company> <scenario> | check <company> <scenario> <file|->");
  process.exit(2);
}
