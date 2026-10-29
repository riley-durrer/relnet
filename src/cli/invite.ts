// Invite and reply codes, and the per-deal state kept on each party's machine.
//
// An invite carries what the other company needs to start talking: the inviter's agent URL and public key,
// the release (version, commit, contract class ids) the inviter runs, the network, and optionally an
// already-deployed agreement. A reply carries the joiner's public key so the inviter can pin it in turn.
// Both are signed by the key they name. That catches corruption in transit and binds the code to the key,
// but it does NOT prove who sent it: an attacker can sign their own invite with their own key. What binds the
// code to the right company is a person comparing the key fingerprint over a different channel (a call, a
// known email thread) and passing it to --confirm-fingerprint. Without that, nothing is pinned.
import { CompactSign, compactVerify, calculateJwkThumbprint, exportJWK, importJWK, JWK } from "jose";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdentity, AgentIdentity, PeerPin, pinPeer } from "../channel/identity.js";
import { computeClassIds } from "../release/classids.js";

export type Side = "buyer" | "supplier";
export const other = (s: Side): Side => (s === "buyer" ? "supplier" : "buyer");

export interface ReleaseInfo {
  version: string;
  /** Git commit of the release, or "dev" when running from a source checkout. */
  commit: string;
  classIds: Record<string, string>;
}
export interface InviteBody {
  v: 1;
  kind: "invite";
  dealId: string;
  /** The side the inviter plays. The joiner plays the other. */
  side: Side;
  agent: { url: string; publicJwk: JWK; fingerprint: string };
  release: ReleaseInfo;
  network: { nodeUrl?: string };
  agreement?: string;
  exp: number;
}
export interface ReplyBody {
  v: 1;
  kind: "reply";
  dealId: string;
  side: Side;
  agent: { publicJwk: JWK; fingerprint: string };
  exp: number;
}

const PREFIX = { invite: "relnet-invite-1.", reply: "relnet-reply-1." } as const;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

export async function seal(kind: "invite" | "reply", body: InviteBody | ReplyBody, id: AgentIdentity): Promise<string> {
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(body)))
    .setProtectedHeader({ alg: "EdDSA", typ: `relnet-${kind}+jws`, kid: id.fingerprint })
    .sign(id.privateKey as any);
  return PREFIX[kind] + jws;
}

/** Checks the code's shape, that its key matches its fingerprint, its signature, and its expiry. */
export async function open<T extends InviteBody | ReplyBody>(kind: "invite" | "reply", code: string): Promise<T> {
  const text = code.trim();
  if (!text.startsWith(PREFIX[kind])) throw new Error(`not a relnet ${kind} code`);
  const jws = text.slice(PREFIX[kind].length);
  let body: any;
  try {
    body = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new Error(`the ${kind} code is damaged`);
  }
  if (body?.v !== 1 || body?.kind !== kind) throw new Error(`unsupported ${kind} code version`);
  const jwk: JWK = body.agent?.publicJwk;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new Error("unsupported key type");
  if ((await calculateJwkThumbprint(jwk, "sha256")) !== body.agent.fingerprint) throw new Error("the code's fingerprint does not match its public key");
  try {
    const v = await compactVerify(jws, await importJWK(jwk, "EdDSA"), { algorithms: ["EdDSA"] });
    if (v.protectedHeader.typ !== `relnet-${kind}+jws`) throw new Error("wrong type");
  } catch {
    throw new Error(`the ${kind} code's signature is invalid`);
  }
  if (typeof body.exp !== "number" || body.exp < now()) throw new Error(`the ${kind} code has expired`);
  if (typeof body.dealId !== "string" || !/^[0-9a-f]{16}$/.test(body.dealId)) throw new Error("bad deal id");
  return body as T;
}

export function newInvite(o: { side: Side; url: string; id: AgentIdentity; dealId: string; release: ReleaseInfo; nodeUrl?: string; agreement?: string; ttlHours?: number }): InviteBody {
  return {
    v: 1, kind: "invite", dealId: o.dealId, side: o.side,
    agent: { url: o.url, publicJwk: o.id.publicJwk, fingerprint: o.id.fingerprint },
    release: o.release, network: { nodeUrl: o.nodeUrl }, agreement: o.agreement,
    exp: now() + Math.round((o.ttlHours ?? 24) * 3600),
  };
}
export function newReply(o: { side: Side; id: AgentIdentity; dealId: string }): ReplyBody {
  return { v: 1, kind: "reply", dealId: o.dealId, side: o.side, agent: { publicJwk: o.id.publicJwk, fingerprint: o.id.fingerprint }, exp: now() + DAY };
}

export function newDealId(): string {
  return randomBytes(8).toString("hex");
}

/** Accepts the full fingerprint or a prefix of at least 16 characters; ignores spaces, colons and case. */
export function fingerprintMatches(actual: string, typed: string): boolean {
  const t = typed.replace(/[\s:]/g, "");
  return t.length >= 16 && actual.toLowerCase().startsWith(t.toLowerCase());
}
/** Groups a fingerprint for reading aloud: 4 characters at a time. */
export const readable = (fp: string) => fp.match(/.{1,4}/g)!.join(" ");

/** What this install actually is: class ids recomputed from its own compiled artifacts, never trusted from a file. */
export async function localRelease(root = process.cwd()): Promise<ReleaseInfo> {
  const classIds = await computeClassIds(path.join(root, "target"));
  const manifest = path.join(root, "release.json");
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    return { version: m.version, commit: m.commit, classIds };
  }
  return { version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, commit: "dev", classIds };
}

/** Why two releases are not the same, or an empty list. A "dev" commit is never treated as matching a real one. */
export function releaseDifferences(mine: ReleaseInfo, theirs: ReleaseInfo): string[] {
  const out: string[] = [];
  if (mine.version !== theirs.version) out.push(`version ${mine.version} here, ${theirs.version} there`);
  if (mine.commit !== theirs.commit || mine.commit === "dev") out.push(`commit ${mine.commit} here, ${theirs.commit} there`);
  for (const k of new Set([...Object.keys(mine.classIds), ...Object.keys(theirs.classIds)]))
    if (mine.classIds[k] !== theirs.classIds[k]) out.push(`${k} class id differs`);
  return out;
}

// ---- per-deal state on disk -------------------------------------------------------------------------------

export interface DealFile {
  dealId: string;
  side: Side;
  /** This party's own key. Never sent anywhere. */
  identity: { privateJwk: JWK; publicJwk: JWK };
  /** The URL this party told the other to use (inviter only). */
  ownUrl?: string;
  /** The counterparty, once pinned. url is set for the inviter's agent, absent for the joiner's. */
  peer?: { fingerprint: string; publicJwk: JWK; url?: string };
  release?: ReleaseInfo;
  network?: { nodeUrl?: string };
  agreement?: string;
  /** Agreed terms as decimal strings, once a negotiation ends in agreement. */
  agreed?: Record<string, string>;
}

export const home = () => process.env.RELNET_HOME ?? path.join(os.homedir(), ".relnet");
const dealPath = (id: string) => path.join(home(), "deals", `${id}.json`);

export function saveDeal(d: DealFile): void {
  const dir = path.join(home(), "deals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(dealPath(d.dealId), JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
  chmodSync(dealPath(d.dealId), 0o600);
}
export function loadDeal(id: string): DealFile {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("bad deal id");
  if (!existsSync(dealPath(id))) throw new Error(`no deal ${id} in ${home()}`);
  return JSON.parse(readFileSync(dealPath(id), "utf8"));
}

export async function freshIdentity(): Promise<{ id: AgentIdentity; stored: DealFile["identity"] }> {
  const id = await createIdentity();
  return { id, stored: { privateJwk: await exportJWK(id.privateKey as any), publicJwk: id.publicJwk } };
}
export async function identityOf(d: DealFile): Promise<AgentIdentity> {
  return {
    privateKey: (await importJWK(d.identity.privateJwk, "EdDSA")) as any,
    publicJwk: d.identity.publicJwk,
    fingerprint: await calculateJwkThumbprint(d.identity.publicJwk, "sha256"),
  };
}
export async function peerOf(d: DealFile): Promise<PeerPin> {
  if (!d.peer) throw new Error("the counterparty is not pinned yet");
  return pinPeer({ fingerprint: d.peer.fingerprint, publicJwk: d.peer.publicJwk, url: d.peer.url ?? "" });
}
