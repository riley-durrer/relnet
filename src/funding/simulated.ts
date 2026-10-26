import { randomUUID } from "node:crypto";
import type { FundingProvider, FundingRequest } from "./provider.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

export interface SimulatedOptions {
  baseUrl: string;
  maxAmountCents: bigint;
  /** Called on approval to deliver tokens (e.g. RelnetCoin.mint_publicly). Units: 1 cent = 1 token unit. */
  mint: (address: string, amountCents: bigint) => Promise<void>;
}

export class SimulatedFundingProvider implements FundingProvider {
  private requests = new Map<string, FundingRequest>();
  constructor(private opts: SimulatedOptions) {}

  async requestFunding(address: string, amountCents: bigint): Promise<FundingRequest> {
    if (!ADDRESS_RE.test(address)) throw new Error("invalid address: expected 0x + 64 hex chars");
    if (amountCents <= 0n) throw new Error("amountCents must be positive");
    if (amountCents > this.opts.maxAmountCents) {
      throw new Error(`amountCents exceeds demo limit of ${this.opts.maxAmountCents}`);
    }
    const id = randomUUID();
    const req: FundingRequest = {
      id,
      address,
      amountCents,
      status: "pending",
      url: `${this.opts.baseUrl}/pay/${id}`,
      createdAt: Date.now(),
    };
    this.requests.set(id, req);
    return req;
  }

  async getRequest(id: string) {
    return this.requests.get(id);
  }

  async listRequests() {
    return [...this.requests.values()];
  }

  private pending(id: string): FundingRequest {
    const req = this.requests.get(id);
    if (!req) throw new Error("unknown request");
    if (req.status !== "pending") throw new Error(`request already ${req.status}`);
    return req;
  }

  async approve(id: string) {
    const req = this.pending(id);
    // Mark first so a concurrent approve cannot mint twice; revert if the mint fails.
    req.status = "approved";
    try {
      await this.opts.mint(req.address, req.amountCents);
    } catch (e) {
      req.status = "pending";
      throw e;
    }
    req.decidedAt = Date.now();
    return req;
  }

  async reject(id: string, note?: string) {
    const req = this.pending(id);
    req.status = "rejected";
    req.note = note;
    req.decidedAt = Date.now();
    return req;
  }
}
