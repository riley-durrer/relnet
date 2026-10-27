# relnet

A governed settlement network for long-term supplier–buyer relationships, built on
[Aztec](https://aztec.network) (Noir / Aztec.nr). Entry for the HackFW MADE Challenge,
Supplier Relationship Management track.

Agents are untrusted. Price, volume bands, escrow milestones and release rules are enforced
by contract code on-chain, not by any LLM or agent. A supplier can also prove, in zero
knowledge, that its on-time delivery rate meets a threshold without revealing order data.

**Try it:** with the local network running, `npm run demo` plays a full narrated run, and
`npm run ui` opens an operator page (see [Run](#run)).

**Status: hackathon work in progress. Testnet/local sandbox only, fictional entities, no real
funds. Nothing here is a compliance claim.**

## What exists today

| Contract | Purpose | State |
|---|---|---|
| `RelnetAgreement` | Framework agreement: buyer, supplier, price, volume band, stage. `place_call_off` is a private entrypoint that enqueues a public assertion; out-of-band quantity, wrong price, or a non-party caller reverts the transaction. | Done, 4 tests |
| `RelnetCoin` | Minimal public-balance settlement token (demo grade, not an audited standard). | Done, used by escrow tests |
| `RelnetEscrow` | Per-call-off escrow. SHIPPED 30% (supplier + carrier), RECEIVED 50% (buyer + carrier), INSPECTED releases the remainder (buyer). Permissionless `finalize_deemed_acceptance` (7 days) and `missed_ship_date_refund`. Arbiter can only move funds still in escrow. | Done, 4 tests |
| `RelnetPerformanceProof` | Supplier keeps one private `(on_time_count, total_count)` note. `prove_on_time_rate(threshold_pct)` asserts the rate in a private circuit and publishes only the threshold. | Done, 4 tests |
| `RelnetAuditLog` | Public hash chain of state transitions. | **Stub only** |

Also built: `npm run demo` (narrated end-to-end run), `npm run ui` (local operator page), a
simulated funding service, and a 14-case hostile-agent test suite.

Not built: audit-log contract, SDK/gateway, FastAPI layer, reference LLM agents, docker-compose
one-command boot, a multi-month simulation, a supplier/part knowledge graph, an MES/ERP adapter.

## Architecture

```
  buyer agent      supplier agent      carrier agent        (untrusted, any software)
       \               |                  /
        \              |                 /       signed calls from each party's own wallet
         v             v                v
  +--------------------------------------------------------------+
  |  Aztec local network (runs on the participant's own machine) |
  |                                                              |
  |  RelnetAgreement   price, volume band, parties   (public)    |
  |        | place_call_off: private entry, public assertion     |
  |        v                                                     |
  |  RelnetEscrow      30% ship / 50% receive / 20% inspect      |
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

## Hostile-agent results

Each row is a real attempt against a deployed instance; the "baseline" is a modeled ledger that
trusts its agents (not a measured competitor). Reproduce with `npm run demo`; the full 14-case
suite is `src/test/e2e/hostile.e2e.ts`.

| Attack | Baseline (trusts agents) | relnet |
|---|---|---|
| Order outside the volume band | accepted | blocked |
| Order at an off-contract price | accepted | blocked |
| Non-party places an order | accepted | blocked |
| Non-admin mints tokens | accepted | blocked |
| Forged on-time delivery record | accepted | blocked |
| Open a call-off with no funds sent | accepted | blocked |
| Non-buyer releases escrow at inspection | accepted | blocked |
| Re-use a closed call-off | accepted | blocked |
| Non-arbiter issues a ruling | accepted | blocked |
| Absorb the same outcome twice | accepted | blocked |
| Absorb an outcome the escrow never recorded | accepted | blocked |

Measured on one laptop against the local network: about 3.7 s median per transaction. Proving
mode of the local network was not verified, so read this as execution latency, not a benchmark.

## Path to a real floor (pilot plan)

This is a plan, not something built or validated.

1. **Scope:** one buyer and two to three suppliers on a single part family under an existing
   supply agreement. Mirror the existing terms (price, volume band, milestones) in the contract.
2. **Shadow mode (weeks 1-4):** run relnet alongside the current PO/ERP process with no money
   moving. Compare what the contract would have accepted or rejected with what staff did.
3. **Attestation hardening:** replace public milestone calls with signed attestations from
   dock scanners or carrier systems, and add the audit-log contract.
4. **Settlement rails:** connect a licensed provider behind the `FundingProvider` interface for
   fiat to stablecoin. Not implemented today.
5. **Network:** move from the local sandbox to a public Aztec network once its tooling is stable.
6. **Exit criteria:** disputes resolved without manual reconciliation, and fewer days from
   receipt to supplier payment than the current process. Neither is measured yet.

## How this maps to the challenge signals

| Signal | Where relnet stands |
|---|---|
| Industrial usefulness | Standing agreements with milestone escrow for vendor settlement. Pilot not run. |
| Robustness | 14 hostile cases plus 17 functional tests pass on the local network. Not load tested. |
| Data sovereignty | Everything runs on the participant's machine. The supplier's performance history stays in a private note; only a threshold is published. Terms and escrow state are public by design. |
| Measured performance | Latency per transaction on one machine. No throughput, cost or fiat-vs-stablecoin comparison yet. |
| Enterprise readiness | One-command demo and UI, README, typed tests. Not audited; sandbox only. |
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
- **No team-hosted infrastructure.** Everything runs on a local Aztec sandbox that any
  participant can start.

## Known limits (be honest about these)

- Funding is two steps: buyer transfers coin to the escrow address, then calls `fund_call_off`.
  The escrow checks its balance covers outstanding commitments, but the ordering is not atomic.
- Tokens sent to the escrow but never registered via `fund_call_off` are unrecoverable (no sweep function).
- Milestone attestations are public calls from the named parties, not signed attestations.
- `RelnetCoin` is a demo token with public balances.
- Agreement terms are visible on-chain.
- The 7-day deemed-acceptance path is tested only for early rejection; the success path would
  need chain time travel.
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
npm test                 # runs the four e2e suites (including 14 hostile-agent cases)
npm run demo             # narrated end-to-end run with the attack table
npm run ui               # operator page at http://127.0.0.1:8100 (deploys fresh contracts, ~30s)
```

The operator page runs on your own machine against your own local network. It shows the
agreement terms, per-call-off 30/50/20 settlement, a "try to cheat" panel where the contract
rejects each hostile request with its reason, and the supplier's zero-knowledge on-time proof.
It keeps state in memory and starts a fresh deployment each time.

Restart the sandbox if it has been running for many hours; long-lived instances accumulate
clock drift and can refuse to restart ("Ethereum node is out of sync") until stray `anvil`
processes are killed.

## Layout

```
contracts/{agreement,escrow,token,performance_proof,audit_log}/   Aztec.nr (Noir) contracts
Nargo.toml                                                       workspace
src/artifacts/                                                   generated TS bindings (gitignored)
src/utils/sponsored_fee.ts                                       registers sandbox SponsoredFPC for fees
src/test/e2e/*.e2e.ts                                            e2e tests (tsx, node assert style)
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
