# relnet

**A settlement network for long-term supplier–buyer deals, run by AI agents and signed by people.**

relnet lets AI agents at two companies negotiate and run a standing supply agreement, with a person at
each company signing it and smart contracts enforcing it. Payment is settled on-chain instead of through
a bank. It is built on [Aztec](https://aztec.network) (Noir / Aztec.nr).

Agents negotiate a price and the deal's rules inside limits that a person at each company sets. Both
people sign. After that, the agents place orders, confirm shipments and manage the deal through its
history, and the contracts enforce what was signed: price, order size, milestone payments, and a
late-delivery price reduction that applies itself. Neither side's agent can change a signed rule, and a
mistake (a mistyped quantity, a stale price) is rejected immediately instead of reconciled later. A
supplier can also prove, in zero knowledge, that its on-time rate meets a threshold without revealing
order data.

> **Status: prototype.** It runs on a local Aztec sandbox only, with fictional companies and no real
> funds. It has not been audited, and nothing here is a compliance claim. See [Known limits](#known-limits).

## Contents

- [Quick start](#quick-start)
- [How a deal works](#how-a-deal-works)
- [How the agents talk](#how-the-agents-talk)
- [What is included](#what-is-included)
- [Example companies and agent testing](#example-companies-and-agent-testing)
- [Hostile and mistaken agents](#hostile-and-mistaken-agents)
- [Design decisions](#design-decisions)
- [Known limits](#known-limits)
- [Roadmap](#roadmap)
- [Project layout](#project-layout)
- [Background](#background)

## Quick start

**Prerequisites:** Docker, Node.js 24, and the Aztec toolchain 5.2.1:

```bash
VERSION=5.2.1 bash -i <(curl -sL https://install.aztec.network)
export PATH="$HOME/.aztec/current/bin:$HOME/.aztec/current/node_modules/.bin:$HOME/.aztec/current/internal-bin:$HOME/.aztec/bin:$PATH"
```

`internal-bin` must be on the path because the sandbox needs `anvil`.

```bash
npm install
npm run sandbox          # terminal 1: local Aztec network on :8080
npm run build            # terminal 2: aztec compile --workspace + codegen
npm test                 # unit tests plus four end-to-end suites
npm run demo             # narrated run: negotiate, sign, operate, late-price cut, attacks (about 3 minutes)
npm run ui               # operator page at http://127.0.0.1:8100
```

The operator page runs on your own machine against your own local network. You set each company's limits,
let the agents negotiate, read the terms, and sign as each person. Then you place orders, step them through
shipment, receipt and inspection, and advance the demo clock to make a delivery late and watch the price cut
apply. A "try to cheat" panel sends hostile or mistaken requests and shows the contract's reason for
rejecting each, and the supplier can generate the zero-knowledge on-time proof. State is in memory and each
start is a fresh deployment (about 30 seconds).

Notes:

- `npm install` may report about 48 audit advisories. All are in Aztec's own dependency tree (for example
  `ws`); none are in the A2A SDK, Express or `jose`. `npm audit fix --force` would move Aztec to a breaking
  version, so it is not applied.
- Restart the sandbox if it has run for many hours. Long-lived instances accumulate clock drift and can
  refuse to restart ("Ethereum node is out of sync") until stray `anvil` processes are stopped.
- If you are writing an agent or another client, read [AGENTS.md](AGENTS.md) first. It covers the term
  vocabulary, roles, wallets and the Aztec 5.2.1 API differences.

## How a deal works

1. **Mandates.** A person at each company sets what their agent may accept: a price range, a ship-by range,
   how harsh a late penalty may be, and so on.
2. **Negotiation.** The agents talk over [A2A](https://a2a-protocol.org/latest/specification/) (see
   [How the agents talk](#how-the-agents-talk)). Each sees only its own limits and concedes toward them one
   round at a time. When the two positions cross, they settle on the midpoint. A rule-based negotiator picks
   every number; no model output sets a price, limit or key. If the ranges do not overlap, the agents walk away.
3. **Sign-off.** The agreed terms go on-chain as a *proposal*. They become binding only when the buyer's
   person and the supplier's person each approve the same proposal. Agents cannot approve, and a proposal
   swapped after a person reviewed it cannot be approved.
4. **Operation.** Agents place orders. The escrow holds each order's value and pays in milestones. If
   shipment is late, the escrow cuts the price by the rule both sides signed and refunds the buyer. Nobody
   chooses that amount when it happens.
5. **Amendments.** Changing a term is a new proposal that both people sign again. Orders already in flight
   keep the terms they were placed under.

The rules an agent can compose are a fixed, typed vocabulary: price, order band, milestone shares, ship-by,
grace period, late-price cut per period and cap, cancel window, and deemed-acceptance window. Details are in
[AGENTS.md](AGENTS.md).

## How the agents talk

The channel is **not trusted**. It carries drafts only. Nothing binds anyone until two people sign on-chain,
so a compromised channel can slow a negotiation or leak offers but cannot commit a company to anything.

It uses the open [A2A (Agent2Agent) protocol v1.0.0](https://a2a-protocol.org/latest/specification/) through
the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) rather than a custom protocol. Each agent
is an A2A server, and offers are A2A messages carrying a typed data part.

| Layer | What protects it |
|---|---|
| Who is this agent? | Each agent has an Ed25519 key. The *deal code* (agent URL, public key, fingerprint) pins the counterparty's key, and people confirm the fingerprints out of band. An impostor server fails because its Agent Card is not signed by the pinned key. |
| Every request | A short-lived (60 s), single-use bearer token signed by the pinned key and addressed to this agent. |
| Every offer | A separately signed message (JWS via `jose`) bound to one deal, sender, recipient and round, with an expiry and a one-time nonce. Tampered, replayed, wrong-deal, out-of-order and expired messages are refused. |
| Content | Offers are typed terms only. Unknown fields, decimals, negatives and out-of-bound values are refused. Free text is logged and never interpreted as an instruction. |
| Agreement | Both sides recompute the same meeting point from the last two offers and require an exact match, so neither can "accept" a self-favouring variant. Each also checks the result against its own limits. |
| Leaks | Mandates never leave their owner; only offers are sent. Concession patterns still leak over rounds, which is inherent to negotiation. |

`src/test/channel.test.ts` runs 11 cases against real servers on localhost, and each case checks the refusal
*reason*.

The channel does **not** protect against a person who rubber-stamps the summary, or a counterparty who is
simply dishonest. The signed rules and the escrow are for that.

**Limits of the channel:**

- The demo uses plain HTTP on 127.0.0.1. The A2A specification requires TLS in production.
- The first exchange of a deal code is the trust root, so a wrong fingerprint accepted by a person defeats it.
- The agent-key to on-chain-address link is not cryptographic. The deal code carries both, and people confirm them.
- A2A's security-considerations section (section 13) has not been reviewed point by point against this
  implementation, so this is not a complete review against it.

## What is included

| Component | Purpose | State |
|---|---|---|
| `RelnetAgreement` | Typed terms, proposal and two-person sign-off, amendments, agent roles, and call-off records that snapshot the terms. `place_call_off` is a private entrypoint that enqueues a public assertion. | Done, 7 tests |
| `RelnetCoin` | Minimal public-balance settlement token (demo grade, not an audited standard). | Done |
| `RelnetEscrow` | Per-call-off escrow. The amount comes from the agreement's record. Milestone shares, late-delivery price cut, deemed acceptance and cancel windows all come from the signed terms. The arbiter can only move funds still in escrow. | Done, 6 tests |
| `RelnetPerformanceProof` | The supplier keeps one private `(on_time_count, total_count)` note. `prove_on_time_rate(threshold_pct)` checks the rate in a private circuit and publishes only the threshold. | Done, 4 tests |
| `RelnetAuditLog` | Public hash chain of state transitions. | **Stub only** |
| Agents and channel | Rule-based negotiating agents that talk over A2A with signed offers, plus a self-correcting buyer agent. | Done |
| `npm run demo`, `npm run ui` | Narrated demo and local operator page. | Done |
| Funding service | Simulated on-ramp behind a `FundingProvider` interface (see [below](#funding-requests-simulated-on-ramp)). | Simulation only |
| Hostile-agent suite | 13 cases whose assertions check the rejection *reason*, not just that something failed. | Done |

Not built: the audit-log contract, an SDK/gateway, LLM-driven reference agents, TLS for the local channel, a
one-command container boot, an MES/ERP adapter, and a measured fee comparison.

### Architecture

```
  person at buyer        person at supplier      (sign off; hold the buyer / supplier accounts)
        |                      |
  buyer agent <-- A2A, signed offers --> supplier agent    carrier   (propose, order, attest; cannot approve)
        \                     |                  /
         v                    v                 v
  +--------------------------------------------------------------+
  |  Aztec local network (runs on the participant's own machine) |
  |                                                              |
  |  RelnetAgreement   typed terms, proposal + two signatures    |
  |        | place_call_off: private entry, public assertion     |
  |        v                                                     |
  |  RelnetEscrow      milestone shares, late-price rule         |
  |        |  record_outcome(on_time)   (escrow-only caller)     |
  |        v                                                     |
  |  RelnetPerformanceProof   supplier's private tally note      |
  |        prove_on_time_rate(threshold) -> publishes threshold  |
  |                                                              |
  |  RelnetCoin        settlement token (demo grade)             |
  +--------------------------------------------------------------+
        ^
        | read-only
  operator page (npm run ui)  /  demo script (npm run demo)
```

No language model sits in the enforcement path. Agents may be LLM-driven; the contracts decide what is accepted.

## Example companies and agent testing

`examples/` has three fictional companies, each with company-written rules (`policy.md`) and approved limits
(`mandate.json`): two well written and one deliberately poor. A guard runs any agent's output through every
layer of the system and reports which layer caught what. A mandate linter warns a person about risky limits
before they approve them. See [examples/README.md](examples/README.md).

`examples/results/` holds recorded runs with real model replies and an honest write-up of what they showed:

- single replies to 18 scenarios, plus a corrected re-run of six;
- two four-round negotiations against a deliberately bad-faith counterparty, one against each side;
- ten prompt-injection attacks against two companies.

Each run is one reply per scenario from one model family, so these are probes, not statistically valid
evaluations. The scripted outputs in the repo are hand-written and are not model behavior.

## Hostile and mistaken agents

Each row is a real attempt against a deployed instance. The "baseline" is a modeled ledger that trusts its
agents, not a measured competitor. Reproduce with `npm run demo`; the 13-case suite is
`src/test/e2e/hostile.e2e.ts`.

| Attack or mistake | Baseline (trusts agents) | relnet |
|---|---|---|
| Order outside the signed volume band (typo, or malice) | accepted | blocked |
| Order at a price that is not the signed price | accepted | blocked |
| Order before both people have signed | accepted | blocked |
| Non-party places an order | accepted | blocked |
| An agent approves terms on its own | accepted | blocked |
| Terms swapped after a person reviewed them | accepted | blocked |
| Non-admin mints tokens | accepted | blocked |
| Forged on-time delivery record | accepted | blocked |
| Open a call-off with no funds sent | accepted | blocked |
| Non-buyer releases escrow at inspection | accepted | blocked |
| Re-use a closed call-off | accepted | blocked |
| Non-arbiter issues a ruling | accepted | blocked |
| Absorb the same outcome twice, or one that was never recorded | accepted | blocked |

In the demo, a buyer agent also mistypes 400 for 40 units. The contract rejects it, and the agent re-reads the
signed terms and re-derives the quantity from its own demand plan.

### Tests

`npm test` runs 56 tests: 13 hostile or mistaken-agent cases against the contracts, 17 more against the
contracts' agreement, escrow and proof behavior, 11 against the agent channel, 7 for the negotiator, and 8 for
the example-agent guard and mandate linter. Each checks the refusal reason. There are 5 more unit tests for the
funding service (`npm run test:funding`). Nothing is load tested.

## Design decisions

- **Terms and escrow state are public.** Aztec notes are owner-centric. There is no native note jointly owned by
  buyer and supplier, and private functions cannot read the current block timestamp. Bilateral terms,
  milestones and deadlines therefore live in public state, which also makes them auditable.
- **Privacy is reserved for the performance proof**, the one place a single-owner private note fits: a supplier
  proving a fact about itself.
- **Deterministic enforcement pattern.** A private function enqueues a public function
  (`#[external("public")] #[only_self]`) that asserts the rule. If it fails, the whole transaction reverts,
  including any private note writes.
- **The performance tally is O(1).** Each absorb pops the supplier's existing tally note(s), sums, and inserts
  one new note, so proving never scans order history.
- **Recording on-time outcomes.** On the SHIPPED milestone the escrow calls
  `RelnetPerformanceProof.record_outcome(call_off_id, on_time)`, restricted to the escrow address. The supplier
  later calls `absorb_outcome(call_off_id, on_time)`; the claimed value is checked against the escrow's record
  in an enqueued public call, and each call-off can be absorbed once.
- **People sign, agents work.** Only the buyer and supplier accounts can approve terms. Each party can name an
  agent account that may propose, order and attest. A proposal id guards against terms being swapped under a
  reviewing person.
- **A fixed rule vocabulary, not arbitrary logic.** Agents compose deals from typed parameters that the contract
  can bound and a person can read. Free-form rules would be hard to verify.
- **Rules are computed from signed terms.** The escrowed amount is quantity times the signed price, and the
  late-delivery price cut is computed by the escrow, so neither depends on an agent's input.
- **Each call-off snapshots its terms**, so an amendment never rewrites a deal in flight.
- **No operator-hosted infrastructure.** Everything runs on a local Aztec sandbox that any participant can start.

## Known limits

**Money and settlement**

- No fee saving is measured. On the local network fees are sponsored, so they cost nothing and prove nothing
  about real cost. The funding service is a simulation, and any real saving depends on on-ramp and off-ramp
  costs that are not built. A fee model with cited sources, clearly labeled as modeled, is future work.
- Funding is two steps: the buyer transfers coin to the escrow address, then calls `fund_call_off`. The escrow
  checks that its balance covers outstanding commitments, but the ordering is not atomic.
- Tokens sent to the escrow but never registered with `fund_call_off` are unrecoverable (there is no sweep function).
- `RelnetCoin` is a demo token with public balances.
- Refunds (late-price cuts, cancellations) go to the agreement's buyer account, not to the agent that paid.

**Trust and identity**

- Milestone attestations are public calls from the named parties, not signed attestations, and nothing verifies
  that a shipment really happened.
- A signature is a key's signature, not an identity check. Nothing here verifies who a person is.
- Agreement terms are visible on-chain.
- A supplier can ship late indefinitely at the capped price cut until the buyer's cancel window opens.
- Performance proofs only cover outcomes the supplier chooses to absorb; a supplier can skip absorbing a late
  delivery. A production design needs to force absorption.

**Environment**

- Both companies must share one Aztec network. Today that is one local sandbox, and the UI and demo play both
  companies on one machine. A real deployment needs a public network.
- Tested only against the local sandbox, not a public network. The Aztec testnet was reset on 2026-10-12.
- Tested on Linux only. macOS and Windows have not been tried.
- **Time.** Durations are chain-time seconds. The local network advances about 72 seconds of chain time per
  block, so the demo and UI map one day to 72 seconds. A real deployment uses real durations.
- Latency was measured on one laptop against the local network: roughly 4 to 7 seconds per operation (one or
  two transactions). The proving mode of the local network was not verified, so read this as execution latency,
  not a benchmark.
- The performance-proof flow was reworked after a private read of a delayed public value caused transactions
  to be dropped on the local sandbox. The root cause was not fully pinned down.

**Agents**

- A mandate is only as safe as the limits a person approves. The guard enforces approved limits mechanically,
  so a wide-open mandate (see the deliberately poor example) allows bad deals. The linter flags such mandates.
- Whether a model refuses to reveal a floor or to confirm an unshipped order depends on the model and prompt,
  not on the code. The recorded runs showed good behavior from one model family; that is not a guarantee.

## Roadmap

This is a plan, not something built or validated.

1. **Public network.** Move from the local sandbox to a public Aztec network so two companies can use it.
2. **Distribution.** Signed, verifiable releases with build provenance, and commands that let each party verify
   the build and the on-chain contract before signing.
3. **Reachability.** A way for two agents on different networks to reach each other, with TLS.
4. **Attestations.** Replace public milestone calls with signed attestations from scanners or carrier systems,
   and build the audit-log contract.
5. **Settlement rails.** Connect a licensed provider behind the `FundingProvider` interface for fiat to
   stablecoin.
6. **Shadow-mode pilot.** Run alongside an existing PO/ERP process with no money moving, and compare what the
   contract would have accepted or rejected with what staff did.

## Project layout

```
contracts/{agreement,escrow,token,performance_proof,audit_log}/   Aztec.nr (Noir) contracts
Nargo.toml                                                       workspace
src/artifacts/                                                   generated TS bindings (gitignored)
src/lib/terms.ts                                                 term vocabulary, parse/validate/summarize
src/lib/world.ts                                                 shared deployment (humans + agents)
src/lib/lint.ts                                                  mandate linter
src/agents/negotiate.ts                                          mandates, reference negotiation, proposal review
src/agents/runtime.ts                                            decision log, self-correcting buyer agent
src/channel/*.ts                                                 A2A channel: identity, signed offers, protocol, server/client
src/utils/sponsored_fee.ts                                       registers the sandbox SponsoredFPC for fees
src/test/*.test.ts, src/test/e2e/*.e2e.ts                        unit and end-to-end tests (tsx, node assert style)
src/examples/*.ts, examples/                                     example companies, guard, scenarios, prompts, recorded runs
src/demo/main.ts                                                 npm run demo
src/ui/                                                          operator page (local server + static HTML)
src/funding/                                                     simulated funding service
```

### Aztec 5.2.1 notes

APIs differ from older tutorials: there is no `prelude`; use `self.storage`, `self.msg_sender()`, and
`self.enqueue_self.fn()`. Use `#[external("public"|"private")]`, private state via
`Owned<PrivateSet<Note, Context>, Context>`, wallets via `EmbeddedWallet` from `@aztec/wallets/embedded`, and
fees via `SponsoredFeePaymentMethod`. `.send()` already waits for mining. `SinglePrivateMutable` requires the
executing contract to have registered keys, so it is avoided.

### Funding requests (simulated on-ramp)

Agents cannot mint tokens themselves. `src/funding/` is a local service an agent can call to ask a human for
funds, behind a `FundingProvider` interface so a licensed on-ramp (KYC, bank link, fiat to stablecoin, bridge)
can replace the simulation later. **Only the simulation exists: no bank is linked and no real money moves.**

```bash
npm run funding    # needs the sandbox; deploys a demo RelnetCoin and prints its address and an admin token
npm run test:funding
```

- `POST /funding-requests {address, amountCents}` returns `{id, url, status}`; the agent gives `url` to the user.
- `GET /funding-requests/:id` polls status, and `GET /pay/:id` is the human-facing page.
- Admin (header `x-admin-token`): `GET /admin/funding-requests`, `POST /admin/funding-requests/:id/approve|reject`.
  Approve mints one token unit per cent via `RelnetCoin.mint_publicly`, once only.
- It binds to 127.0.0.1, with a demo cap of 1,000,000 cents per request. Requests are held in memory.

## Background

relnet started as an entry for the HackFW MADE Challenge (Fort Worth DAO), Supplier Relationship Management
track. [DEMO.md](DEMO.md) is the script for its demo video. All companies, people and prices in this
repository are fictional.
