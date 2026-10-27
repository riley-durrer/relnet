// Rule-based negotiation inside human-set mandates. No model output sets any value:
// each agent only ever proposes numbers inside the range its own human approved, and
// the result is still just a proposal until both humans sign it on-chain.
import { Terms, validateTerms } from "../lib/terms.js";

export interface Range {
  min: bigint;
  max: bigint;
}

/** Which fields are negotiated, and which direction each side prefers. */
export type NegotiatedKey =
  | "price_cents"
  | "ship_bps"
  | "lead_time_secs"
  | "grace_secs"
  | "late_bps_per_period"
  | "late_cap_bps"
  | "cancel_after_secs"
  | "deemed_acceptance_secs";

export const NEGOTIATED: { key: NegotiatedKey; buyerPrefers: "low" | "high" }[] = [
  { key: "price_cents", buyerPrefers: "low" },
  { key: "ship_bps", buyerPrefers: "low" }, // buyers pay less up front
  { key: "lead_time_secs", buyerPrefers: "low" }, // buyers want it sooner
  { key: "grace_secs", buyerPrefers: "low" },
  { key: "late_bps_per_period", buyerPrefers: "high" }, // buyers want a stiffer late penalty
  { key: "late_cap_bps", buyerPrefers: "high" },
  { key: "cancel_after_secs", buyerPrefers: "low" },
  { key: "deemed_acceptance_secs", buyerPrefers: "high" }, // buyers want longer to inspect
];

/**
 * What one company's human approves their agent to accept. Every negotiated field has
 * an acceptable range; the agent opens at its best end and concedes toward its worst.
 */
export interface Mandate {
  company: string;
  ranges: Record<NegotiatedKey, Range>;
  /** Order sizes this company can use or supply. The deal band is the overlap. */
  volume: Range;
  /** Fixed by the human, not negotiated. */
  receive_bps: bigint;
  late_period_secs: bigint;
}

export interface OfferLine {
  round: number;
  from: string;
  offer: Partial<Record<keyof Terms, bigint>>;
}

export type NegotiationResult =
  | { ok: true; terms: Terms; rounds: number; transcript: OfferLine[] }
  | { ok: false; reason: string; transcript: OfferLine[] };

export const ROUNDS = 8n;

function lerp(best: bigint, worst: bigint, k: bigint): bigint {
  return best + ((worst - best) * k) / ROUNDS;
}

/** The value an agent offers on a field at round k: best end of its range, conceding toward its limit. */
export function offerFor(range: Range, prefersLow: boolean, k: bigint): bigint {
  return prefersLow ? lerp(range.min, range.max, k) : lerp(range.max, range.min, k);
}

export function negotiate(buyer: Mandate, supplier: Mandate): NegotiationResult {
  const transcript: OfferLine[] = [];

  const vmin = buyer.volume.min > supplier.volume.min ? buyer.volume.min : supplier.volume.min;
  const vmax = buyer.volume.max < supplier.volume.max ? buyer.volume.max : supplier.volume.max;
  if (vmin > vmax) return { ok: false, reason: "No overlapping order-size range.", transcript };

  for (const f of NEGOTIATED) {
    const b = buyer.ranges[f.key];
    const s = supplier.ranges[f.key];
    const buyerLow = f.buyerPrefers === "low";
    // Buyer wants low (accepts up to b.max), supplier wants high (accepts down to s.min): overlap needs b.max >= s.min.
    const overlap = buyerLow ? b.max >= s.min : s.max >= b.min;
    if (!overlap) {
      return { ok: false, reason: `No overlap on ${f.key}: buyer range ${b.min}-${b.max}, supplier range ${s.min}-${s.max}.`, transcript };
    }
  }

  for (let k = 0n; k <= ROUNDS; k++) {
    const buyerOffer: Partial<Record<keyof Terms, bigint>> = {};
    const supplierOffer: Partial<Record<keyof Terms, bigint>> = {};
    let crossed = true;
    const agreed: Partial<Record<keyof Terms, bigint>> = {};
    for (const f of NEGOTIATED) {
      const buyerLow = f.buyerPrefers === "low";
      const bo = offerFor(buyer.ranges[f.key], buyerLow, k);
      const so = offerFor(supplier.ranges[f.key], !buyerLow, k);
      buyerOffer[f.key] = bo;
      supplierOffer[f.key] = so;
      // Offers cross when the buyer's is at least as generous to the supplier as the supplier's ask.
      const cross = buyerLow ? bo >= so : so >= bo;
      if (!cross) crossed = false;
      // Midpoint, clamped into the overlap of both ranges so neither mandate is ever exceeded.
      const lo = buyer.ranges[f.key].min > supplier.ranges[f.key].min ? buyer.ranges[f.key].min : supplier.ranges[f.key].min;
      const hi = buyer.ranges[f.key].max < supplier.ranges[f.key].max ? buyer.ranges[f.key].max : supplier.ranges[f.key].max;
      const mid = (bo + so) / 2n;
      agreed[f.key] = mid < lo ? lo : mid > hi ? hi : mid;
    }
    transcript.push({ round: Number(k), from: buyer.company, offer: buyerOffer });
    transcript.push({ round: Number(k), from: supplier.company, offer: supplierOffer });
    if (crossed) {
      const terms: Terms = {
        price_cents: agreed.price_cents!,
        volume_min: vmin,
        volume_max: vmax,
        ship_bps: agreed.ship_bps!,
        receive_bps: buyer.receive_bps,
        lead_time_secs: agreed.lead_time_secs!,
        grace_secs: agreed.grace_secs!,
        late_period_secs: buyer.late_period_secs,
        late_bps_per_period: agreed.late_bps_per_period!,
        late_cap_bps: agreed.late_cap_bps!,
        cancel_after_secs: agreed.cancel_after_secs!,
        deemed_acceptance_secs: agreed.deemed_acceptance_secs!,
      };
      const problems = validateTerms(terms);
      if (problems.length) return { ok: false, reason: `Agreed terms are invalid: ${problems.join("; ")}`, transcript };
      return { ok: true, terms, rounds: Number(k), transcript };
    }
  }
  return { ok: false, reason: "Offers did not cross within the round limit.", transcript };
}

/**
 * An agent's recommendation on someone else's proposal (a first draft or an amendment).
 * Lists every field outside this company's mandate. The human still signs.
 */
export function reviewProposal(mandate: Mandate, proposed: Terms): { withinMandate: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const f of NEGOTIATED) {
    const v = proposed[f.key];
    const r = mandate.ranges[f.key];
    if (v < r.min || v > r.max) violations.push(`${f.key} = ${v} is outside ${r.min}-${r.max}`);
  }
  if (proposed.volume_min < mandate.volume.min || proposed.volume_max > mandate.volume.max) {
    violations.push(`order band ${proposed.volume_min}-${proposed.volume_max} is outside ${mandate.volume.min}-${mandate.volume.max}`);
  }
  if (proposed.receive_bps !== mandate.receive_bps) violations.push(`receive_bps = ${proposed.receive_bps}, mandate is ${mandate.receive_bps}`);
  return { withinMandate: violations.length === 0, violations };
}

const DAY = 86400n;
const r = (min: bigint, max: bigint): Range => ({ min, max });

/** Fictional example mandates used by the demo and the UI. */
export const EXAMPLE_BUYER_MANDATE: Mandate = {
  company: "Lone Star Assembly",
  volume: r(10n, 200n),
  receive_bps: 5000n,
  late_period_secs: DAY,
  ranges: {
    price_cents: r(400n, 560n),
    ship_bps: r(1000n, 3000n),
    lead_time_secs: r(7n * DAY, 21n * DAY),
    grace_secs: r(0n, 2n * DAY),
    late_bps_per_period: r(200n, 500n),
    late_cap_bps: r(1000n, 2000n),
    cancel_after_secs: r(7n * DAY, 21n * DAY),
    deemed_acceptance_secs: r(5n * DAY, 14n * DAY),
  },
};

export const EXAMPLE_SUPPLIER_MANDATE: Mandate = {
  company: "Trinity Castings",
  volume: r(20n, 100n),
  receive_bps: 5000n,
  late_period_secs: DAY,
  ranges: {
    price_cents: r(480n, 650n),
    ship_bps: r(2000n, 4000n),
    lead_time_secs: r(10n * DAY, 28n * DAY),
    grace_secs: r(1n * DAY, 4n * DAY),
    late_bps_per_period: r(0n, 300n),
    late_cap_bps: r(0n, 1000n),
    cancel_after_secs: r(10n * DAY, 30n * DAY),
    deemed_acceptance_secs: r(3n * DAY, 10n * DAY),
  },
};
