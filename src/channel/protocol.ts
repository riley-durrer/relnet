// Two-party negotiation where each agent sees only its own mandate. Each round the initiator
// offers its position for that round; the responder either accepts that offer exactly or counters
// with its own position. An agent accepts only if the other side's offer is at least as good for it
// as the offer it would have made this round, so an accepted offer is always inside its own limits.
// Pure functions: no I/O, no model output.
import { Terms, validateTerms } from "../lib/terms.js";
import { Mandate, NEGOTIATED, ROUNDS, offerFor, Range } from "../agents/negotiate.js";

export type Side = "buyer" | "supplier";
export const MAX_ROUND = Number(ROUNDS);

function prefersLow(side: Side, buyerPrefers: "low" | "high"): boolean {
  return side === "buyer" ? buyerPrefers === "low" : buyerPrefers === "high";
}

function intersect(a: Range, b: Range): Range | null {
  const min = a.min > b.min ? a.min : b.min;
  const max = a.max < b.max ? a.max : b.max;
  return min > max ? null : { min, max };
}

/** My position at round k. The order band is my own range, narrowed to the peer's band if I know it. */
export function myOffer(side: Side, m: Mandate, k: number, peerBand?: Range): Terms | null {
  const band = peerBand ? intersect(m.volume, peerBand) : m.volume;
  if (!band) return null;
  const t: Partial<Terms> = {
    volume_min: band.min,
    volume_max: band.max,
    receive_bps: m.receive_bps,
    late_period_secs: m.late_period_secs,
  };
  for (const f of NEGOTIATED) t[f.key] = offerFor(m.ranges[f.key], prefersLow(side, f.buyerPrefers), BigInt(k));
  return t as Terms;
}

export type Response = { kind: "offer"; terms: Terms } | { kind: "walk"; reason: string };

/**
 * Do the two positions cross? True when, on every negotiated field, the peer's offer is at least as
 * good for me as mine, the peer's order band fits inside my range, and the fixed fields agree.
 */
export function crossed(side: Side, m: Mandate, mine: Terms, peer: Terms): boolean {
  if (validateTerms(peer).length > 0) return false;
  if (peer.volume_min < m.volume.min || peer.volume_max > m.volume.max) return false;
  if (peer.receive_bps !== m.receive_bps || peer.late_period_secs !== m.late_period_secs) return false;
  for (const f of NEGOTIATED) {
    const low = prefersLow(side, f.buyerPrefers);
    if (low ? peer[f.key] > mine[f.key] : peer[f.key] < mine[f.key]) return false;
  }
  return true;
}

/**
 * The agreed terms when two crossing offers meet: the midpoint of each negotiated field, the overlap
 * of the order bands, and the (equal) fixed fields. Symmetric, so both sides compute the same result
 * and each can verify it without trusting the other.
 */
export function meet(a: Terms, b: Terms): Terms {
  const t: Terms = { ...a };
  for (const f of NEGOTIATED) t[f.key] = (a[f.key] + b[f.key]) / 2n;
  t.volume_min = a.volume_min > b.volume_min ? a.volume_min : b.volume_min;
  t.volume_max = a.volume_max < b.volume_max ? a.volume_max : b.volume_max;
  return t;
}

/** What the responder says to the initiator's offer at round k: always its own position for that round. */
export function respond(side: Side, m: Mandate, k: number, peer: Terms): Response {
  if (k < 0 || k > MAX_ROUND) return { kind: "walk", reason: "round out of range" };
  const mine = myOffer(side, m, k, { min: peer.volume_min, max: peer.volume_max });
  if (!mine) return { kind: "walk", reason: "no overlapping order size" };
  return { kind: "offer", terms: mine };
}

/** One-sided check: is this deal no worse than my worst acceptable limit on every field? */
export function withinLimits(side: Side, m: Mandate, t: Terms): boolean {
  for (const f of NEGOTIATED) {
    const low = prefersLow(side, f.buyerPrefers);
    const r = m.ranges[f.key];
    if (low ? t[f.key] > r.max : t[f.key] < r.min) return false;
  }
  return t.volume_min >= m.volume.min && t.volume_max <= m.volume.max;
}
