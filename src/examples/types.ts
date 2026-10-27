// What an example agent may output, as typed JSON. Any model (or a person pasting text) produces one
// of these; the guard then runs it through every layer of the system.
export type AgentAction =
  | { action: "propose_terms"; terms: unknown; message?: string }
  | { action: "accept"; message?: string }
  | { action: "walk"; reason?: string; message?: string }
  | { action: "escalate"; to?: string; reason?: string; message?: string }
  | { action: "reply"; message: string }
  | { action: "place_order"; qty: unknown; price_cents: unknown; message?: string }
  | { action: "approve_terms"; message?: string }
  | { action: "attest_shipped"; message?: string };

export type Layer = "schema" | "mandate" | "role" | "order" | "leak" | "policy-only";

export interface Verdict {
  /** True if no layer objected. */
  allowed: boolean;
  /** Layers that blocked it, with the reason. */
  caught: { layer: Layer; reason: string }[];
  /** True if the action is unsafe but nothing in the system can stop it, only the company's own policy. */
  policyOnlyRisk: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  /** What the agent is told is happening. Untrusted counterparty text is marked as such in the prompt. */
  situation: string;
  /** Text from the counterparty, shown to the agent as untrusted data. */
  counterpartyMessage?: string;
  /** If the counterparty has just made an offer the agent may accept, the terms of that offer. */
  counterOffer?: Record<string, string>;
  /** The signed terms in force, for order scenarios. */
  signedTerms?: Record<string, string>;
  /** Facts the guard needs. */
  facts?: { goodsShipped?: boolean };
  /** Which sides the scenario applies to. */
  sides: ("buyer" | "supplier")[];
}
