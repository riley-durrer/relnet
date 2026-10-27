// Signed negotiation messages. A2A authenticates the connection; this authenticates each offer
// (JWS, EdDSA via `jose`) and binds it to one deal, one sender, one recipient and one round.
import { CompactSign, compactVerify } from "jose";
import { randomUUID } from "node:crypto";
import { Terms, parseTerms, validateTerms } from "../lib/terms.js";
import { AgentIdentity, PeerPin, peerKey } from "./identity.js";

export type Kind = "offer" | "accept" | "walk";
export const OFFER_TTL_SECS = 60;
const TYP = "relnet-offer+jws";

export interface Payload {
  v: 1;
  dealId: string;
  round: number;
  nonce: string;
  from: string;
  to: string;
  iat: number;
  exp: number;
  kind: Kind;
  /** Bigint strings, present for offer and accept. */
  terms?: Record<string, string>;
  /** Plain text for humans and logs. Never interpreted as an instruction. */
  reason?: string;
}

const KEYS = new Set(["v", "dealId", "round", "nonce", "from", "to", "iat", "exp", "kind", "terms", "reason"]);

export async function sign(
  me: AgentIdentity,
  peer: PeerPin,
  m: { dealId: string; round: number; kind: Kind; terms?: Terms; reason?: string },
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: Payload = {
    v: 1,
    dealId: m.dealId,
    round: m.round,
    nonce: randomUUID(),
    from: me.fingerprint,
    to: peer.fingerprint,
    iat: now,
    exp: now + OFFER_TTL_SECS,
    kind: m.kind,
    ...(m.terms ? { terms: Object.fromEntries(Object.entries(m.terms).map(([k, v]) => [k, v.toString()])) } : {}),
    ...(m.reason ? { reason: m.reason.slice(0, 200) } : {}),
  };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: TYP, kid: me.fingerprint })
    .sign(me.privateKey as any);
}

export class Rejected extends Error {}

/** One side's view of a conversation: what it will accept next. */
export class Session {
  readonly seen = new Set<string>();
  constructor(
    readonly dealId: string,
    readonly me: AgentIdentity,
    readonly peer: PeerPin,
    /** The round this side expects next. The responder expects the initiator's rounds in order. */
    public expectedRound: number | null,
  ) {}

  /** Verify a message from the peer. Throws Rejected with a reason that is safe to log. */
  async open(jws: string, now = Math.floor(Date.now() / 1000)): Promise<{ payload: Payload; terms?: Terms }> {
    if (typeof jws !== "string" || jws.length > 8192) throw new Rejected("malformed message");
    let verified;
    try {
      verified = await compactVerify(jws, await peerKey(this.peer), { algorithms: ["EdDSA"] });
    } catch {
      throw new Rejected("bad signature");
    }
    if (verified.protectedHeader.typ !== TYP) throw new Rejected("wrong message type");
    let p: any;
    try {
      p = JSON.parse(new TextDecoder().decode(verified.payload));
    } catch {
      throw new Rejected("malformed payload");
    }
    if (typeof p !== "object" || p === null || Object.keys(p).some((k) => !KEYS.has(k))) throw new Rejected("unexpected fields");
    if (p.v !== 1) throw new Rejected("unsupported version");
    if (p.from !== this.peer.fingerprint) throw new Rejected("wrong sender");
    if (p.to !== this.me.fingerprint) throw new Rejected("not addressed to this agent");
    if (p.dealId !== this.dealId) throw new Rejected("wrong deal");
    if (!["offer", "accept", "walk"].includes(p.kind)) throw new Rejected("unknown kind");
    if (!Number.isInteger(p.round) || p.round < 0) throw new Rejected("bad round");
    if (typeof p.nonce !== "string" || p.nonce.length > 64) throw new Rejected("bad nonce");
    if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp - p.iat > OFFER_TTL_SECS) throw new Rejected("bad lifetime");
    if (now > p.exp) throw new Rejected("expired");
    if (p.iat > now + 5) throw new Rejected("from the future");
    if (this.seen.has(p.nonce)) throw new Rejected("replayed message");
    if (this.expectedRound !== null && p.round !== this.expectedRound) throw new Rejected("unexpected round");
    let terms: Terms | undefined;
    if (p.kind !== "walk") {
      if (!p.terms) throw new Rejected("terms required");
      try {
        terms = parseTerms(p.terms);
        const problems = validateTerms(terms);
        if (problems.length) throw new Error(problems.join("; "));
      } catch (e) {
        throw new Rejected(`invalid terms: ${(e as Error).message}`);
      }
    }
    this.seen.add(p.nonce);
    return { payload: p as Payload, terms };
  }
}
