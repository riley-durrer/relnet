// A2A (Agent2Agent v1.0) negotiation channel, built on the official @a2a-js/sdk.
//   - Each agent publishes a JWS-signed Agent Card; the counterparty verifies it against the key
//     pinned from the deal code (a trusted key store, not the card's own jku).
//   - Every request carries a short-lived EdDSA bearer token, checked against the pinned key.
//   - Every offer is a separately signed, deal-bound, round-bound, single-use message (envelope.ts).
//   - Nothing here binds anyone. A deal becomes real only when two people sign on-chain.
// Local demo traffic is plain HTTP on 127.0.0.1; the A2A spec requires TLS in production.
import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  AgentCard,
  Role,
  generateAgentCardSignature,
  verifyAgentCardSignature,
  Message,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Terms } from "../lib/terms.js";
import { Mandate } from "../agents/negotiate.js";
import { AgentIdentity, PeerPin, peerKey } from "./identity.js";
import { Rejected, Session, sign } from "./envelope.js";
import { MAX_ROUND, Side, crossed, meet, myOffer, respond, withinLimits } from "./protocol.js";

const MAX_BODY = "32kb";
const TOKEN_TTL = "60s";

export interface ChannelEvent {
  at: string;
  who: string;
  text: string;
}

function dataPart(value: unknown) {
  return { content: { $case: "data" as const, value }, metadata: undefined, filename: "", mediaType: "application/json" };
}
function agentMessage(contextId: string, jws: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    parts: [dataPart({ jws })],
    taskId: "",
    contextId,
    extensions: [],
    metadata: {},
    referenceTaskIds: [],
  };
}
function textMessage(contextId: string, text: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    parts: [{ content: { $case: "text" as const, value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    taskId: "",
    contextId,
    extensions: [],
    metadata: {},
    referenceTaskIds: [],
  };
}
function readJws(m: Message | undefined): string | null {
  const part = m?.parts.find((p) => p.content?.$case === "data");
  const v = part?.content?.$case === "data" ? (part.content.value as any) : undefined;
  return v && typeof v.jws === "string" ? v.jws : null;
}

/** A short-lived bearer token proving who is calling, signed with this agent's key. */
export async function makeToken(me: AgentIdentity, peer: PeerPin): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: me.fingerprint })
    .setIssuer(me.fingerprint)
    .setAudience(peer.fingerprint)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(me.privateKey as any);
}

export interface ResponderOptions {
  side: Side;
  mandate: Mandate;
  identity: AgentIdentity;
  /** The initiator, pinned from the deal code. */
  peer: PeerPin;
  dealId: string;
  port?: number;
  /** The URL the counterparty will use, if a TLS proxy or tunnel sits in front of this server. The server still binds 127.0.0.1. */
  publicUrl?: string;
  name?: string;
  onEvent?: (e: ChannelEvent) => void;
}

export interface Responder {
  url: string;
  /** Messages and requests this agent refused, with the reason. */
  rejections: string[];
  /** The agreed terms once the negotiation ends in agreement. */
  agreed: () => Terms | null;
  close: () => Promise<void>;
}

/** Runs one agent as an A2A server that answers a single counterparty's offers. */
export async function startResponder(o: ResponderOptions): Promise<Responder> {
  const rejections: string[] = [];
  const log = (text: string) => o.onEvent?.({ at: new Date().toISOString(), who: o.name ?? o.side, text });
  const session = new Session(o.dealId, o.identity, o.peer, null);
  let nextRound = 0;
  let lastOffer: { round: number; terms: Terms } | null = null;
  let lastCounter: { round: number; terms: Terms } | null = null;
  let agreed: Terms | null = null;
  let ended = false;
  const seenJti = new Map<string, number>();
  const peerPublic = await peerKey(o.peer);

  const executor: AgentExecutor = {
    async execute(ctx: RequestContext, bus: ExecutionEventBus) {
      const reply = (jws: string) => bus.publish(AgentEvent.message(agentMessage(o.dealId, jws)));
      const refuse = (why: string) => {
        rejections.push(why);
        log(`refused a message: ${why}`);
        bus.publish(AgentEvent.message(textMessage(o.dealId, `refused: ${why}`)));
      };
      const jws = readJws(ctx.userMessage);
      if (!jws) return refuse("no signed message");
      if (ended) return refuse("negotiation already ended");
      try {
        const { payload, terms } = await session.open(jws);
        if (payload.kind === "walk") {
          ended = true;
          log(`counterparty walked away: ${payload.reason ?? ""}`);
          return reply(await sign(o.identity, o.peer, { dealId: o.dealId, round: payload.round, kind: "walk", reason: "acknowledged" }));
        }
        if (payload.kind === "accept") {
          // The initiator proposes the meeting point of the last two offers. I recompute it and require an exact match.
          if (!lastOffer || !lastCounter || payload.round !== lastCounter.round) throw new Rejected("accept without a matching counter-offer");
          if (!crossed(o.side, o.mandate, lastCounter.terms, lastOffer.terms)) throw new Rejected("offers do not cross");
          const meeting = meet(lastOffer.terms, lastCounter.terms);
          if (JSON.stringify(strs(terms!)) !== JSON.stringify(strs(meeting))) throw new Rejected("accepted terms are not the agreed meeting point");
          if (!withinLimits(o.side, o.mandate, meeting)) throw new Rejected("meeting point is outside my limits");
          agreed = meeting;
          ended = true;
          log(`agreement reached at round ${payload.round}`);
          return reply(await sign(o.identity, o.peer, { dealId: o.dealId, round: payload.round, kind: "accept", terms: agreed }));
        }
        // kind === "offer"
        if (payload.round !== nextRound) throw new Rejected("unexpected round");
        if (payload.round > MAX_ROUND) throw new Rejected("round limit exceeded");
        nextRound = payload.round + 1;
        const r = respond(o.side, o.mandate, payload.round, terms!);
        if (r.kind === "walk") {
          ended = true;
          log(`walking away: ${r.reason}`);
          return reply(await sign(o.identity, o.peer, { dealId: o.dealId, round: payload.round, kind: "walk", reason: r.reason }));
        }
        lastOffer = { round: payload.round, terms: terms! };
        lastCounter = { round: payload.round, terms: r.terms };
        log(`countered at round ${payload.round}`);
        return reply(await sign(o.identity, o.peer, { dealId: o.dealId, round: payload.round, kind: "offer", terms: r.terms }));
      } catch (e) {
        return refuse(e instanceof Rejected ? e.message : "internal error");
      }
    },
    cancelTask: async () => {},
  };

  const app = express();
  let boundPort = 0;
  const cardBase: AgentCard = {
    name: o.name ?? `relnet ${o.side} agent`,
    description: "Negotiates supply-agreement terms inside limits set by a person. Nothing it says binds anyone until two people sign on-chain.",
    supportedInterfaces: [],
    provider: { organization: "relnet (fictional)", url: "https://example.invalid" },
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: { description: "EdDSA JWT signed by the pinned counterparty key", scheme: "Bearer", bearerFormat: "JWT" } } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "negotiate", name: "Negotiate terms", description: "Exchange signed, typed offers.", tags: ["negotiation"], examples: [], inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements: [] }],
    documentationUrl: "",
    signatures: [],
  };
  // Port must be known before the card exists; reserve it first.
  const server = http.createServer(app);
  await new Promise<void>((res) => server.listen(o.port ?? 0, "127.0.0.1", () => res()));
  boundPort = (server.address() as any).port;
  const url = o.publicUrl ? o.publicUrl.replace(/\/?$/, "/") : `http://127.0.0.1:${boundPort}/`;
  cardBase.supportedInterfaces = [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }];

  const signer = generateAgentCardSignature(o.identity.privateKey as any, { alg: "EdDSA", kid: o.identity.fingerprint, typ: "JOSE" });
  const handler = new DefaultRequestHandler(cardBase, new InMemoryTaskStore(), executor, undefined, undefined, undefined, undefined, signer);

  // The card is public and signed. Everything else needs a valid token from the pinned peer.
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use(async (req, res, next) => {
    try {
      const h = req.header("authorization") ?? "";
      if (!h.startsWith("Bearer ")) throw new Error("missing bearer token");
      const { payload } = await jwtVerify(h.slice(7), peerPublic, { issuer: o.peer.fingerprint, audience: o.identity.fingerprint, algorithms: ["EdDSA"] });
      const jti = payload.jti;
      if (!jti) throw new Error("token has no id");
      const now = Date.now();
      for (const [k, exp] of seenJti) if (exp < now) seenJti.delete(k);
      if (seenJti.has(jti)) throw new Error("token replayed");
      seenJti.set(jti, now + 120_000);
      next();
    } catch (e) {
      rejections.push(`request refused: ${(e as Error).message}`);
      log(`request refused: ${(e as Error).message}`);
      res.status(401).json({ error: "unauthorized" });
    }
  });
  app.use(express.json({ limit: MAX_BODY }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: async () => ({ isAuthenticated: true, userName: o.peer.fingerprint }) }));
  app.use(((err, _req, res, _next) => {
    rejections.push(`bad request: ${err?.type ?? err?.message ?? "error"}`);
    res.status(400).json({ error: "bad request" });
  }) as express.ErrorRequestHandler);

  return {
    url,
    rejections,
    agreed: () => agreed,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

const strs = (t: Terms) => Object.fromEntries(Object.entries(t).sort().map(([k, v]) => [k, v.toString()]));

export interface InitiatorOptions {
  side: Side;
  mandate: Mandate;
  identity: AgentIdentity;
  /** The responder, pinned from the deal code. */
  peer: PeerPin;
  dealId: string;
  name?: string;
  onEvent?: (e: ChannelEvent) => void;
}

export type NegotiationOutcome =
  | { ok: true; terms: Terms; rounds: number }
  | { ok: false; reason: string };

/** Drives the negotiation over A2A. Returns the agreed terms, or why it ended without a deal. */
export async function negotiateOverA2A(o: InitiatorOptions): Promise<NegotiationOutcome> {
  const log = (text: string) => o.onEvent?.({ at: new Date().toISOString(), who: o.name ?? o.side, text });
  const pinned = await peerKey(o.peer);
  const verifier = verifyAgentCardSignature(async (kid) => {
    if (kid !== o.peer.fingerprint) throw new Error("card signed by an unexpected key");
    return pinned as any;
  });
  const client = await new ClientFactory().createFromUrl(o.peer.url);
  await client.getAgentCard(undefined, verifier); // throws unless the card's signature verifies against the pinned key
  log("verified the counterparty's signed Agent Card");

  const session = new Session(o.dealId, o.identity, o.peer, null);
  const send = async (round: number, kind: "offer" | "accept" | "walk", terms?: Terms, reason?: string) => {
    const jws = await sign(o.identity, o.peer, { dealId: o.dealId, round, kind, terms, reason });
    const result = await client.sendMessage(
      {
        tenant: "",
        message: {
          role: Role.ROLE_USER,
          messageId: randomUUID(),
          parts: [dataPart({ jws })],
          taskId: "",
          contextId: o.dealId,
          extensions: [],
          metadata: {},
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      { serviceParameters: { Authorization: `Bearer ${await makeToken(o.identity, o.peer)}` } },
    );
    const reply = "parts" in result ? (result as Message) : undefined;
    const rjws = readJws(reply);
    if (!rjws) {
      const text = reply?.parts.find((p) => p.content?.$case === "text");
      throw new Rejected(text?.content?.$case === "text" ? text.content.value : "no signed reply");
    }
    session.expectedRound = round;
    return session.open(rjws);
  };

  let peerBand: { min: bigint; max: bigint } | undefined;
  for (let k = 0; k <= MAX_ROUND; k++) {
    const mine = myOffer(o.side, o.mandate, k, peerBand);
    if (!mine) return { ok: false, reason: "no overlapping order size" };
    log(`offer at round ${k}`);
    const { payload, terms } = await send(k, "offer", mine);
    if (payload.kind === "walk") return { ok: false, reason: payload.reason ?? "counterparty walked away" };
    if (payload.kind === "accept") return { ok: false, reason: "unexpected accept" };
    // The responder countered with its own position. If the two cross, both sides settle on the meeting point.
    if (crossed(o.side, o.mandate, mine, terms!)) {
      const meeting = meet(mine, terms!);
      if (!withinLimits(o.side, o.mandate, meeting)) return { ok: false, reason: "meeting point is outside my limits" };
      const ack = await send(k, "accept", meeting);
      if (ack.payload.kind !== "accept" || JSON.stringify(strs(ack.terms!)) !== JSON.stringify(strs(meeting))) return { ok: false, reason: "counterparty did not confirm" };
      log(`agreed at round ${k} on the meeting point of both offers`);
      return { ok: true, terms: meeting, rounds: k };
    }
    if (k === MAX_ROUND) {
      await send(k, "walk", undefined, "no agreement within the round limit").catch(() => undefined);
      return { ok: false, reason: "no agreement within the round limit" };
    }
    peerBand = { min: terms!.volume_min, max: terms!.volume_max };
  }
  return { ok: false, reason: "no agreement within the round limit" };
}
