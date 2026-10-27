// Reference agents. They are rule-based and free to run; any of them could be replaced by an
// LLM-driven agent, because the contracts (not the agent) decide what is accepted.
import { Terms } from "../lib/terms.js";
import type { World } from "../lib/world.js";

export interface Decision {
  agent: string;
  action: string;
  why: string;
  result: "accepted" | "rejected" | "info";
  detail?: string;
}

export class DecisionLog {
  entries: Decision[] = [];
  onAdd?: (d: Decision) => void;
  add(d: Decision) {
    this.entries.push(d);
    this.onAdd?.(d);
  }
}

/** The contract's assertion message, without the surrounding stack trace. */
export function revertReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const hit = m.match(/Assertion failed: ([^'\n]+)/);
  return (hit ? hit[1] : m.split("\n")[0]).slice(0, 200).trim();
}

/** Compress calendar durations for a live demo: one "day" lasts `daySecs` real seconds. */
export function scaleTime(t: Terms, daySecs: bigint): Terms {
  const s = (x: bigint) => (x * daySecs) / 86400n;
  const nz = (x: bigint) => (x === 0n ? 0n : s(x) === 0n ? 1n : s(x));
  return {
    ...t,
    lead_time_secs: nz(t.lead_time_secs),
    grace_secs: nz(t.grace_secs),
    late_period_secs: s(t.late_period_secs) || 1n,
    cancel_after_secs: nz(t.cancel_after_secs) || 1n,
    deemed_acceptance_secs: nz(t.deemed_acceptance_secs) || 1n,
  };
}

/**
 * Buyer agent: orders a quantity. If the contract rejects it, the agent reads the signed terms,
 * corrects its own mistake (a typo'd quantity or a stale price) and retries once.
 */
export async function buyerPlacesOrder(
  w: World,
  log: DecisionLog,
  id: bigint,
  qty: bigint,
  price: bigint,
  why: string,
  plannedQty: bigint = qty,
) {
  const agent = "buyer agent";
  try {
    await w.agreement.methods.place_call_off(id, qty, price).send(w.o(w.buyerAgent));
    log.add({ agent, action: `order #${id}: ${qty} units at ${price} cents`, why, result: "accepted" });
    return { qty, price };
  } catch (e) {
    const reason = revertReason(e);
    log.add({ agent, action: `order #${id}: ${qty} units at ${price} cents`, why, result: "rejected", detail: reason });
    const { result } = await w.agreement.methods.get_terms().simulate({ from: w.buyerAgent });
    const t = result as Terms;
    // Re-derive the quantity from the agent's own demand plan, then keep it inside the signed band.
    const fixedQty = plannedQty < t.volume_min ? t.volume_min : plannedQty > t.volume_max ? t.volume_max : plannedQty;
    log.add({
      agent,
      action: `re-read signed terms, retry with ${fixedQty} units at ${t.price_cents} cents`,
      why: `the contract is the source of truth; my demand plan says ${plannedQty} units, so ${qty} was my mistake`,
      result: "info",
    });
    await w.agreement.methods.place_call_off(id, fixedQty, t.price_cents).send(w.o(w.buyerAgent));
    log.add({ agent, action: `order #${id}: ${fixedQty} units at ${t.price_cents} cents`, why: "corrected order", result: "accepted" });
    return { qty: fixedQty, price: t.price_cents };
  }
}
