# Demo video script (about 3 minutes)

Record the terminal at a large font. Run `npm run sandbox` in one pane first and wait for it to
settle (about 2 minutes). Run `npm run demo` in the other pane. The full run takes roughly 90 seconds,
so record it once and speak over it, or trim in editing.

All entities are fictional. Testnet only. No real funds.

## Shot list

| Time | On screen | Say |
|---|---|---|
| 0:00 | README title and the one-line pitch | "Suppliers and buyers sign multi-year agreements, then let software agents run the daily orders. relnet makes the agreement itself enforceable, so the agents don't have to be trusted." |
| 0:20 | `npm run demo`, step 1 | "Everything runs on a local Aztec network on this laptop. There is no server we host. Price is 500 cents a unit, volume band 10 to 100. Those terms live in the contract." |
| 0:45 | Step 2, call-offs paying out | "Three orders, each escrowed. Payment releases in three milestones: 30% on shipment, 50% on receipt, 20% on inspection. The totals match to the cent. Money is integer cents throughout." |
| 1:20 | Step 3, ZK proof | "Here is the part that needs zero-knowledge. The supplier proves they deliver on time at least 95% of the time. The buyer sees the claim and that it is true. They never see the order history, dates or quantities." |
| 1:50 | Step 4, attack table | "Now the agents are hostile. Wrong price, wrong volume, forged delivery records, someone minting money, someone releasing escrow early. The baseline here is a ledger that trusts its agents, and it accepts all of them. relnet rejected 11 of 11. No language model was involved in any of those decisions." |
| 2:30 | Step 5, measured line | "About 3.7 seconds a transaction on this laptop. That's one run on a sandbox, not a benchmark." |
| 2:45 | README "Known limits" | "We list what's not done: milestone attestations are plain signed calls, terms are public, and it's sandbox only." |
| 3:00 | End card | "relnet: agreements that enforce themselves." |

## Before recording

- Fresh sandbox (restart it if it has run for hours).
- Terminal at least 100 columns wide so the attack table doesn't wrap.
- Close anything showing personal data. The demo prints no keys.

## Claims to avoid

- Do not say "compliant", "audited" or "production ready".
- Do not call the latency a benchmark.
- The baseline column is a model of a trusting ledger, not a measured competitor. Say so if asked.
