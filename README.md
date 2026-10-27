# relnet

A way for AI agents at two companies to make and run a long-term supply deal, settled on-chain
instead of through a traditional bank, with a person at each company signing off. Built on
[Aztec](https://aztec.network) (Noir / Aztec.nr). Entry for the HackFW MADE Challenge, Supplier
Relationship Management track.

Agents negotiate a price and the deal's rules inside limits that a person at each company sets.
Both people sign. After that, the agents place orders, confirm shipments and manage the deal through
its history, and the contracts enforce what was signed: price, order size, milestone payments, and a
late-delivery price reduction that applies itself. Neither side's agent can change a signed rule, and
a mistake (a typo'd quantity, a stale price) is rejected instantly rather than reconciled later. A
supplier can also prove, in zero knowledge, that its on-time rate meets a threshold without
revealing order data.

**Try it:** with the local network running, `npm run demo` plays the whole story, and `npm run ui`
opens an operator page (see [Run](#run)).

**Status: hackathon work in progress. Local sandbox only, fictional entities, no real funds.
Nothing here is a compliance claim.**

## How a deal works

1. **Mandates.** A person at each company sets what their agent may accept: a price range, a ship-by
   range, how harsh a late penalty may be, and so on.
2. **Negotiation.** The agents talk over [A2A](https://a2a-protocol.org/latest/specification/) (see
   [How the agents talk](#how-the-agents-talk)). Each sees only its own limits and concedes toward them
   one round at a time; when the two positions cross they settle on the midpoint. A rule-based negotiator
   picks every number; no model output sets a price, limit or key. If the ranges do not overlap, the
   agents walk away.
3. **Sign-off.** The agreed terms go on-chain as a *proposal*. They become binding only when the
   buyer's person and the supplier's person each approve the same proposal. Agents cannot approve, and
   a proposal swapped after a person reviewed it cannot be approved.
4. **Operation.** Agents place orders. The escrow holds each order's value and pays in milestones.
   If shipment is late, the escrow cuts the price by the rule both sides signed and refunds the
   buyer. Nobody chooses that amount when it happens.
5. **Amendments.** Changing a term is a new proposal that both people sign again. Orders already in
   flight keep the terms they were placed under.

The rules an agent can compose are a fixed, typed vocabulary (price, order band, milestone shares,
ship-by, grace period, late-price cut per period and cap, cancel window, deemed-acceptance window).
See [AGENTS.md](AGENTS.md).

## How the agents talk

The channel is **not trusted**: it carries drafts only. Nothing binds anyone until two people sign on-chain,
so a compromised channel can slow a negotiation or leak offers, but cannot commit a company to anything.

It uses the open [A2A (Agent2Agent) protocol v1.0.0](https://a2a-protocol.org/latest/specification/) through the
official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) instead of a custom protocol. Each agent is an A2A
server; offers are A2A messages carrying a typed data part.

| Layer | What protects it |
|---|---|
| Who is this agent? | Each agent has an Ed25519 key. The *deal code* (agent URL, public key, fingerprint) pins the counterparty's key; people confirm the fingerprints out-of-band. An impostor server fails because its Agent Card is not signed by the pinned key. |
| Every request | A short-lived (60 s) bearer token signed by the pinned key, addressed to this agent, single-use. |
| Every offer | A separately signed message (JWS via `jose`) bound to one deal, sender, recipient and round, with an expiry and a one-time nonce. Tampering, replay, wrong-deal, out-of-order and expired messages are refused. |
| Content | Offers are typed terms only: unknown fields, decimals, negatives and out-of-bound values are refused. Free text is logged and never interpreted as an instruction, which blocks prompt injection through the channel. |
| Agreement | Both sides recompute the same meeting point of the last two offers and require an exact match, so neither can "accept" a self-favouring variant. Each also checks the result against its own limits. |
| Leaks | Mandates never leave their owner; only offers are sent. Concession patterns still leak over rounds, which is inherent to negotiation. |

Tested with real servers on localhost: `npm test` runs `src/test/channel.test.ts` (11 cases, each checks the refusal
*reason*). What the channel does **not** give you: a person who rubber-stamps the summary, or a counterparty who is
simply dishonest (the escrow and the signed rules are for that).

**Limits of this channel:** the demo uses plain HTTP on 127.0.0.1, while the A2A spec requires TLS in production. The
first exchange of a deal code is the trust root, so a wrong fingerprint accepted by a person defeats it. I did not
read A2A's security-considerations section (section 13) in full, so this is not a complete review against it.
The agent-key to on-chain-address link is not cryptographic: the deal code carries both, and people confirm them.

## What exists today

| Contract | Purpose | State |
|---|---|---|
| `RelnetAgreement` | Typed terms, proposal and two-person sign-off, amendments, agent roles, call-off records that snapshot the terms. `place_call_off` is a private entrypoint that enqueues a public assertion. | Done, 7 tests |
| `RelnetCoin` | Minimal public-balance settlement token (demo grade, not an audited standard). | Done |
| `RelnetEscrow` | Per-call-off escrow. The amount comes from the agreement's record. Milestone shares, late-delivery price cut, deemed acceptance and cancel windows all come from the signed terms. Arbiter can only move funds still in escrow. | Done, 6 tests |
| `RelnetPerformanceProof` | Supplier keeps one private `(on_time_count, total_count)` note. `prove_on_time_rate(threshold_pct)` asserts the rate in a private circuit and publishes only the threshold. | Done, 4 tests |
| `RelnetAuditLog` | Public hash chain of state transitions. | **Stub only** |

Also built: negotiating agents (rule-based, free to run) that talk over A2A with signed offers, `npm run demo`, `npm run ui`, a
simulated funding service, and a 13-case hostile-and-mistaken-agent suite whose assertions check the
rejection *reason*, not just that something failed.

Not built: audit-log contract, SDK/gateway, FastAPI layer, LLM-driven agents, TLS for the local channel, docker-compose
one-command boot, a multi-month simulation, a supplier/part knowledge graph, an MES/ERP adapter,
a measured fee comparison.

## Architecture

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

No language model sits in the enforcement path. Agents may be LLM-driven; the contracts decide
what is accepted.

## Hostile and mistaken agents

Each row is a real attempt against a deployed instance; the "baseline" is a modeled ledger that
trusts its agents (not a measured competitor). Reproduce with `npm run demo`; the 13-case suite is
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

In the demo, a buyer agent also mistypes 400 for 40 units. The contract rejects it, and the agent
re-reads the signed terms and re-derives the quantity from its own demand plan.

## Fees and banks: what is and is not shown

The goal is to settle between companies without the delays and fees of traditional banking. **No fee
saving is measured here.** On the local network fees are sponsored, so they cost nothing and prove
nothing about real cost. The funding service that would turn money into the settlement token is a
simulation. Any real saving depends on on-ramp and off-ramp costs that are not built. A fee model with
cited sources, clearly labeled as modeled, is future work.

What is measured, on one laptop against the local network: roughly 4 to 7 seconds per operation (one
operation is one or two transactions). Proving mode of the local network was not verified, so read this
as execution latency, not a benchmark.

## Path to a real floor (pilot plan)

This is a plan, not something built or validated.

1. **Scope:** one buyer and two to three suppliers on a single part family under an existing
   supply agreement. Express the existing terms (price, order band, milestones, late rules) in the typed vocabulary.
2. **Shadow mode (weeks 1-4):** run relnet alongside the current PO/ERP process with no money
   moving. Compare what the contract would have accepted or rejected with what staff did.
3. **Attestation hardening:** replace public milestone calls with signed attestations from
   dock scanners or carrier systems, and add the audit-log contract.
4. **Settlement rails:** connect a licensed provider behind the `FundingProvider` interface for
   fiat to stablecoin. Not implemented today.
5. **Network:** both companies must be on one shared Aztec network. Today that means one local
   sandbox; a real pilot needs a public network once its tooling is stable.
6. **Exit criteria:** disputes resolved without manual reconciliation, and fewer days from
   receipt to supplier payment than the current process. Neither is measured yet.

## How this maps to the challenge signals

| Signal | Where relnet stands |
|---|---|
| Industrial usefulness | Standing agreements where agents negotiate, people sign, and escrow plus a late-price rule run the deal. Pilot not run. |
| Robustness | 48 tests pass: 13 hostile or mistaken-agent cases against the contracts and 11 against the agent channel, each checking the refusal reason (plus 5 funding-service unit tests). Not load tested. |
| Data sovereignty | Everything runs on the participant's machine. The supplier's performance history stays in a private note; only a threshold is published. Terms and escrow state are public by design. |
| Measured performance | Latency per operation on one machine. No throughput, cost or fiat-vs-stablecoin comparison yet. |
| Enterprise readiness | One-command demo and UI, README, typed tests, human sign-off. Not audited; sandbox only. |
| Edge-to-AI pipeline | Agents (any software or LLM) act through the contracts. No sensors or edge devices are integrated. |

## Design decisions

- **Terms and escrow state are public.** Aztec notes are owner-centric; there is no native note
  jointly owned by buyer and supplier, and private functions cannot read the current block
  timestamp. Bilateral terms, milestones and deadlines therefore live in public state. This
  also makes them auditable.
- **Privacy is reserved for the performance proof**, the one place a single-owner private note
  fits (a supplier proving a fact about itself).
- **Deterministic enforcement pattern:** a private function enqueues a public function
  (`#[external("public")] #[only_self]`) that asserts the rule. If it fails, the whole
  transaction reverts, including any private note writes.
- **Performance tally is O(1):** each absorb pops the supplier's existing tally note(s), sums,
  and inserts one new note, so proving never scans order history.
- **Recording on-time outcomes:** on the SHIPPED milestone the escrow calls
  `RelnetPerformanceProof.record_outcome(call_off_id, on_time)` (restricted to the escrow
  address). The supplier later calls `absorb_outcome(call_off_id, on_time)`; the claimed value
  is verified against the escrow's record in an enqueued public call, and each call-off can be
  absorbed once.
- **People sign, agents work.** The buyer and supplier accounts are the only ones that can approve
  terms. Each party can name an agent account that may propose, order and attest. A proposal id
  guards against terms being swapped under a reviewing person.
- **A fixed rule vocabulary, not arbitrary logic.** Agents compose deals from typed parameters, which
  the contract can bound and a person can read. Free-form rules would be hard to verify.
- **Rules are computed from signed terms.** The escrowed amount is quantity times the signed price,
  and the late-delivery price cut is computed by the escrow, so neither depends on an agent's input.
- **Each call-off snapshots its terms**, so an amendment never rewrites a deal in flight.
- **No team-hosted infrastructure.** Everything runs on a local Aztec sandbox that any
  participant can start.

## Known limits (be honest about these)

- Funding is two steps: buyer transfers coin to the escrow address, then calls `fund_call_off`.
  The escrow checks its balance covers outstanding commitments, but the ordering is not atomic.
- Tokens sent to the escrow but never registered via `fund_call_off` are unrecoverable (no sweep function).
- Milestone attestations are public calls from the named parties, not signed attestations.
- `RelnetCoin` is a demo token with public balances.
- Agreement terms are visible on-chain.
- A signature is a key's signature, not an identity check. Nothing here verifies who the person is.
- Both companies must share one Aztec network; today that is one local sandbox. The UI and demo play
  both companies on one machine.
- **Time:** durations are chain-time seconds. The local network advances about 72 seconds of chain
  time per block, so the demo and UI map one day to 72 seconds. Real deployments use real durations.
- Refunds (late-price cuts, cancellations) go to the agreement's buyer account, not to the agent that paid.
- A supplier can ship late indefinitely at the capped price cut until the buyer's cancel window opens.
- Performance proofs only cover outcomes the supplier chooses to absorb; a supplier can skip
  absorbing a late delivery. A production design needs to force absorption.
- The performance-proof flow was reworked after a private read of a delayed public value caused
  transactions to be dropped on the local sandbox; the root cause was not fully pinned down.
- Tested only against the local sandbox, not the public testnet (testnet was reset on
  2026-10-12).

## Prerequisites

- Docker, Node.js 24
- Aztec toolchain 5.2.1: `VERSION=5.2.1 bash -i <(curl -sL https://install.aztec.network)`

On this machine, add the toolchain to PATH including `internal-bin` (needed for `anvil`):

```bash
export PATH="$HOME/.aztec/current/bin:$HOME/.aztec/current/node_modules/.bin:$HOME/.aztec/current/internal-bin:$HOME/.aztec/bin:$PATH"
```

## Run

```bash
npm install
npm run sandbox          # terminal 1: local Aztec network on :8080
npm run build            # terminal 2: aztec compile --workspace + codegen
npm test                 # unit tests plus four e2e suites (including 13 hostile-agent cases)
npm run demo             # narrated run: negotiate, sign, operate, late-price cut, attacks (about 3 minutes)
npm run ui               # operator page at http://127.0.0.1:8100
```

The operator page runs on your own machine against your own local network. You set each company's
limits, let the agents negotiate, read the terms, and sign as each person. Then you place orders, step
them through shipment, receipt and inspection, and advance the demo clock to make a delivery late and
watch the price cut apply. A "try to cheat" panel sends hostile or mistaken requests and shows the
contract's reason for rejecting each, and the supplier can generate the zero-knowledge on-time proof.
State is in memory and each start is a fresh deployment (deploying takes about 30 seconds).

`npm install` may report about 48 audit advisories. All are in Aztec's own dependency tree (for example `ws`);
none are in the A2A SDK, Express or `jose`. `npm audit fix --force` would downgrade Aztec to a breaking version, so
it is not applied.

Restart the sandbox if it has been running for many hours; long-lived instances accumulate
clock drift and can refuse to restart ("Ethereum node is out of sync") until stray `anvil`
processes are killed.

## Layout

```
contracts/{agreement,escrow,token,performance_proof,audit_log}/   Aztec.nr (Noir) contracts
Nargo.toml                                                       workspace
src/artifacts/                                                   generated TS bindings (gitignored)
src/lib/terms.ts                                                 term vocabulary, parse/validate/summarize
src/lib/world.ts                                                 shared deployment (humans + agents)
src/agents/negotiate.ts                                          mandates, reference negotiation, proposal review
src/channel/*.ts                                                 A2A channel: identity, signed offers, protocol, server/client
src/agents/runtime.ts                                            decision log, self-correcting buyer agent
src/utils/sponsored_fee.ts                                       registers sandbox SponsoredFPC for fees
src/test/*.test.ts, src/test/e2e/*.e2e.ts                        unit and e2e tests (tsx, node assert style)
src/demo/main.ts                                                 npm run demo
src/ui/                                                          operator page (local server + static HTML)
src/funding/                                                     simulated funding service
```

## Aztec 5.2.1 notes

APIs differ from older tutorials: no `prelude`; use `self.storage`, `self.msg_sender()`,
`self.enqueue_self.fn()`; `#[external("public"|"private")]`; private state via
`Owned<PrivateSet<Note, Context>, Context>`; wallets via `EmbeddedWallet` from
`@aztec/wallets/embedded`; `.send()` already waits for mining; fees via
`SponsoredFeePaymentMethod`. `SinglePrivateMutable` requires the executing contract to have
registered keys, so it is avoided.

## Funding requests (simulated on-ramp)

Agents can't mint tokens themselves. `src/funding/` is a local service an agent can call to
ask a human for funds, behind a `FundingProvider` interface so a licensed on-ramp (KYC, bank
link, fiat to stablecoin, bridge) can replace the simulation later. **Only the simulation
exists: no bank is linked and no real money moves.**

```bash
npm run funding    # needs the sandbox; deploys a demo RelnetCoin and prints its address + an admin token
npm run test:funding
```

- `POST /funding-requests {address, amountCents}` returns `{id, url, status}`; the agent gives `url` to the user.
- `GET /funding-requests/:id` polls status; `GET /pay/:id` is the human-facing page.
- Admin (header `x-admin-token`): `GET /admin/funding-requests`, `POST /admin/funding-requests/:id/approve|reject`.
  Approve mints 1 token unit per cent via `RelnetCoin.mint_publicly`, once only.
- Binds to 127.0.0.1, demo cap of 1,000,000 cents per request. Requests are in memory.
