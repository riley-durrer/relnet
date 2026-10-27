// Mandate linter: warns a person about risky limits before they approve them. It cannot judge a
// company's business; it flags ranges that are extreme, contradictory or likely a mistake.
import { Mandate } from "../agents/negotiate.js";

export interface LintFinding {
  severity: "error" | "warn";
  field: string;
  message: string;
}

const DAY = 86400n;

export function lintMandate(side: "buyer" | "supplier", m: Mandate): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (severity: "error" | "warn", field: string, message: string) => out.push({ severity, field, message });
  const r = m.ranges;

  const p = r.price_cents;
  if (p.min <= 0n) add("error", "price_cents", "Minimum price must be above zero.");
  else if (p.max > p.min * 3n) add("warn", "price_cents", `Price range is ${(Number(p.max) / Number(p.min)).toFixed(1)}x wide ($${Number(p.min) / 100} to $${Number(p.max) / 100}). A wide range lets the agent concede too far.`);

  if (r.late_cap_bps.max >= 10000n) add("error", "late_cap_bps", "Accepts a late-price cut of up to 100%: the agent could give the goods away.");
  else if (side === "supplier" && r.late_cap_bps.max > 3000n) add("warn", "late_cap_bps", `Accepts a late-price cut of up to ${Number(r.late_cap_bps.max) / 100}% of the order.`);
  if (side === "supplier" && r.late_bps_per_period.max > 1000n) add("warn", "late_bps_per_period", `Accepts a price cut of up to ${Number(r.late_bps_per_period.max) / 100}% per late period.`);
  if (r.late_bps_per_period.max > r.late_cap_bps.max && r.late_cap_bps.max > 0n) add("warn", "late_bps_per_period", "The per-period cut can exceed the cap, so the cap would always bind.");

  if (r.ship_bps.max + m.receive_bps > 10000n) add("error", "ship_bps", "Shipment share plus receipt share could exceed 100%.");
  if (side === "buyer" && r.ship_bps.max > 5000n) add("warn", "ship_bps", `Pays up to ${Number(r.ship_bps.max) / 100}% before the buyer has received anything.`);

  for (const k of ["lead_time_secs", "grace_secs", "cancel_after_secs", "deemed_acceptance_secs"] as const) {
    if (r[k].max > 90n * DAY) add("warn", k, `Accepts a ${Number(r[k].max / DAY)}-day window, longer than 90 days.`);
  }
  if (r.deemed_acceptance_secs.min < DAY) add("warn", "deemed_acceptance_secs", "Accepts a deemed-acceptance window under one day: goods could count as accepted before anyone inspects them.");

  if (m.volume.max > m.volume.min * 20n) add("warn", "volume", `Order sizes span ${m.volume.min} to ${m.volume.max} units, a very wide range.`);
  for (const [k, v] of Object.entries(r)) if (v.min > v.max) add("error", k, "Minimum exceeds maximum.");
  return out;
}
