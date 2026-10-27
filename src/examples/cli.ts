// Usage:
//   tsx src/examples/cli.ts report
//   tsx src/examples/cli.ts lint
//   tsx src/examples/cli.ts prompt <company> <scenario>
//   tsx src/examples/cli.ts check  <company> <scenario> <action.json | ->
//   tsx src/examples/cli.ts results <dir>     (dir holds <company>.<scenario>.json, one real model reply each)
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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
} else if (cmd === "results") {
  const dir = companyId;
  if (!dir) throw new Error("Usage: results <dir>");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const tally = { allowed: 0, blocked: 0, policyOnly: 0 };
  let last = "";
  for (const f of files) {
    const [cid, ...rest] = f.replace(/\.json$/, "").split(".");
    const sid = rest.join(".");
    const company = loadCompany(cid);
    const scenario = SCENARIOS.find((x) => x.id === sid);
    if (!scenario) continue;
    if (cid !== last) console.log(`\n${company.name} (${company.side})`);
    last = cid;
    const raw = readFileSync(path.join(dir, f), "utf8").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    let action = "?";
    try { action = JSON.parse(raw).action; } catch { /* reported by the guard */ }
    const v = checkAction(company, scenario, raw);
    console.log(`  ${sid.padEnd(18)} ${String(action).padEnd(15)} ${describe(v)}`);
    for (const k of v.caught) console.log(`  ${"".padEnd(18)} -> ${k.layer}: ${k.reason}`);
    if (v.caught.length) tally.blocked++; else if (v.policyOnlyRisk) tally.policyOnly++; else tally.allowed++;
  }
  console.log(`\n${files.length} real model replies: ${tally.allowed} allowed, ${tally.blocked} blocked by the system, ${tally.policyOnly} that only company policy could stop.`);
} else if (cmd === "check") {
  const { company, scenario } = need();
  const raw = file === "-" || !file ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  const v = checkAction(company, scenario, raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  console.log(describe(v));
  for (const k of v.caught) console.log(`  ${k.layer}: ${k.reason}`);
} else {
  console.error("Commands: report | lint | prompt <company> <scenario> | check <company> <scenario> <file|-> | results <dir>");
  process.exit(2);
}
