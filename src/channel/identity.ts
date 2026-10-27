// Agent channel identity: an Ed25519 key per agent, identified by its RFC 7638 JWK thumbprint.
// The deal code carries the public key and fingerprint; a counterparty pins it and trusts nothing else.
import { generateKeyPair, exportJWK, calculateJwkThumbprint, importJWK, JWK, KeyObject, CryptoKey } from "jose";

export interface AgentIdentity {
  privateKey: CryptoKey | KeyObject;
  publicJwk: JWK;
  fingerprint: string;
}

export interface PeerPin {
  fingerprint: string;
  publicJwk: JWK;
  /** Where the peer's A2A server listens. */
  url: string;
}

export async function createIdentity(): Promise<AgentIdentity> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, fingerprint: await calculateJwkThumbprint(publicJwk, "sha256") };
}

/** Pin a peer from a deal code. Rejects a code whose fingerprint does not match its key. */
export async function pinPeer(code: { fingerprint: string; publicJwk: JWK; url: string }): Promise<PeerPin> {
  const actual = await calculateJwkThumbprint(code.publicJwk, "sha256");
  if (actual !== code.fingerprint) throw new Error("Deal code fingerprint does not match its public key");
  if (code.publicJwk.kty !== "OKP" || code.publicJwk.crv !== "Ed25519") throw new Error("Unsupported key type");
  return { fingerprint: actual, publicJwk: code.publicJwk, url: code.url };
}

export async function peerKey(p: PeerPin) {
  return importJWK(p.publicJwk, "EdDSA");
}
