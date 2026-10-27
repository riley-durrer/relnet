# Demo video script (about 3.5 minutes)

Record the terminal at a large font and at least 100 columns wide. Start the local network with
`npm run sandbox` and wait for it to settle (about 2 minutes). Run `npm run demo` in a second pane.
A full run takes roughly 3 minutes. Record it once and talk over it, or trim in editing. If you also
show the operator page (`npm run ui`), record that separately.

All entities are fictional. Local test network only. No real funds.

## Shot list

| Time | On screen | Say |
|---|---|---|
| 0:00 | README title and first paragraph | "Companies sign long-term supply deals, then someone has to run them: orders, shipments, late deliveries, payment. relnet lets AI agents make and run the deal, with a person at each company signing it, and a contract enforcing it, so payment doesn't have to go through a bank." |
| 0:25 | Demo step 1 (mandates, negotiation) | "Each company's person sets limits: a price range, how fast to ship, how harsh a late penalty can be. The agents negotiate inside those limits. A rule-based negotiator picks every number. No model sets a price." |
| 0:55 | Step 2 (terms in plain English) | "This is what the person reads before signing. Code wrote it from the exact values, so what they read is what they sign." |
| 1:15 | Steps 3 and 4 (order rejected, agent can't approve, people sign) | "Before anyone signs, the buyer's agent tries to order. Rejected. The supplier's agent tries to approve the terms itself. Rejected. Only the two people can sign. Now it's active." |
| 1:50 | Step 5 (three orders) | "Agents run the deal. The buyer's agent mistypes 400 units instead of 40. The contract rejects it, and the agent re-reads the signed terms and corrects itself. Order two ships late. The escrow cuts the price by the rule both sides signed and refunds the buyer. Nobody chose that number at the time." |
| 2:25 | Step 5 table | "Two orders paid in full, the late one paid less. The amounts come from the signed terms." |
| 2:40 | Step 6 (zero-knowledge proof) | "The supplier proves its on-time rate without revealing orders. It can't prove 95%, because one of three was late. It can prove 60%." |
| 3:00 | Step 7 (attack table) | "Then agents misbehave on purpose: wrong price, a stranger ordering, an agent approving on its own, forged delivery records. The baseline is a ledger that trusts its agents, and it accepts all of them. relnet blocks every one." |
| 3:20 | README "Known limits" | "What's not done: milestone confirmations are plain calls, a signature isn't an identity check, no fee savings are measured, and it runs on a local network." |
| 3:30 | End card | "relnet: agents make the deal, people sign it, contracts enforce it." |

## Optional UI segment (about 60 seconds)

Run `npm run ui` and open http://127.0.0.1:8100. Set limits, click "Let the agents negotiate", read the
terms, "Send the proposal on-chain" (about 30 seconds), sign as both people, place an order, click
"Advance 1 day" about 20 times, ship it late, and point at the price cut. Each action takes about 4
seconds; narrate during the wait.

## Before recording

- Fresh network (restart it if it has run for hours).
- Terminal at least 100 columns wide so the tables don't wrap.
- Close anything that shows personal data. The demo prints no keys.

## Claims to avoid

- Do not say "compliant", "audited", "production ready" or "saves money on fees". No fee saving is measured.
- Do not call the latency a benchmark.
- The baseline column models a ledger that trusts its agents. It is not a measured competitor.
- The demo compresses time: one day is 72 chain seconds (one block). Say so.
