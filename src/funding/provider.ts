export type FundingStatus = "pending" | "approved" | "rejected";

export interface FundingRequest {
  id: string;
  address: string;
  amountCents: bigint;
  status: FundingStatus;
  url: string;
  createdAt: number;
  decidedAt?: number;
  note?: string;
}

/**
 * Port for turning fiat into settlement tokens. A production implementation would wrap a
 * licensed on-ramp (KYC, bank link, fiat->stablecoin, bridge to the chain). Only
 * SimulatedFundingProvider exists; it moves no real money.
 */
export interface FundingProvider {
  requestFunding(address: string, amountCents: bigint): Promise<FundingRequest>;
  getRequest(id: string): Promise<FundingRequest | undefined>;
  listRequests(): Promise<FundingRequest[]>;
  approve(id: string): Promise<FundingRequest>;
  reject(id: string, note?: string): Promise<FundingRequest>;
}
