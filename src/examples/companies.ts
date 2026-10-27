import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mandate, NegotiatedKey, Range } from "../agents/negotiate.js";
import { summarizeMandate } from "./prompt.js";

export interface Company {
  id: string;
  name: string;
  side: "buyer" | "supplier";
  policy: string;
  mandate: Mandate;
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "companies");
const rng = (r: any): Range => ({ min: BigInt(r.min), max: BigInt(r.max) });

export function loadCompany(id: string): Company {
  const dir = path.join(root, id);
  const policy = readFileSync(path.join(dir, "policy.md"), "utf8");
  const j = JSON.parse(readFileSync(path.join(dir, "mandate.json"), "utf8"));
  const ranges = {} as Record<NegotiatedKey, Range>;
  for (const [k, v] of Object.entries(j.ranges)) ranges[k as NegotiatedKey] = rng(v);
  const mandate: Mandate = {
    company: j.company,
    volume: rng(j.volume),
    receive_bps: BigInt(j.receive_bps),
    late_period_secs: BigInt(j.late_period_secs),
    ranges,
  };
  return { id, name: j.company, side: j.side, policy, mandate };
}

export function listCompanies(): string[] {
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}
export { summarizeMandate };
