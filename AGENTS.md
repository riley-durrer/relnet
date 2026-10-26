# AGENTS.md — how an agent interacts with relnet

Context file for any AI agent (or human) that needs to connect a wallet and use the relnet
contracts. Everything here is verified against Aztec **5.2.1** on a **local sandbox** (the code
in `src/test/e2e/*.e2e.ts` is the working reference). Testnet/sandbox only, fictional entities,
no real funds.

## Ground rules for agents

- You are an **untrusted** participant. The contracts enforce price, volume bands, escrow
  milestones and release rules; you cannot override them. A call that breaks a rule reverts.
- Never set prices, limits or keys from LLM output without validating them yourself. Money is
  integer units (`u128`/`u64`); no decimals.
- Only call functions your role is allowed to call (see Roles). Calls from the wrong party revert.
- Look up current Aztec docs/README before changing anything protocol-related; APIs changed a
  lot between versions (old tutorials will not work).

## 1. Prerequisites

- Node.js 24, Docker, Aztec toolchain 5.2.1.
- PATH must include `internal-bin` (provides `anvil`):
  `export PATH="$HOME/.aztec/current/bin:$HOME/.aztec/current/node_modules/.bin:$HOME/.aztec/current/internal-bin:$HOME/.aztec/bin:$PATH"`
- Start a node: `npm run sandbox` (serves on `http://localhost:8080`). Restart it if it has run
  for many hours. Override the URL with `NODE_URL`.
- Build contracts + TS bindings: `npm install && npm run build` (outputs `src/artifacts/*.ts`).

## 2. Connect a wallet

There is no separate PXE server: one `EmbeddedWallet` holds proving/keys for many accounts and
talks to the node directly. Every `.send()` needs `from` (the acting account) and a fee method.

```ts
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getInitialTestAccountsData, generateSchnorrAccounts } from "@aztec/accounts/testing";
import { getSponsoredFeePaymentMethod } from "./src/utils/sponsored_fee.js";

const node = createAztecNodeClient(process.env.NODE_URL ?? "http://localhost:8080");
const wallet = await EmbeddedWallet.create(node, { ephemeral: true }); // ephemeral = in-memory PXE

// Sandbox ships 3 prefunded test accounts. Use generateSchnorrAccounts(n) for more.
const [a] = await getInitialTestAccountsData();
const account = await wallet.createSchnorrInitializerlessAccount(a.secret, a.salt, a.signingKey);
const me = account.address; // AztecAddress

// Fees: the sandbox pre-deploys a SponsoredFPC; register it and reuse the payment method.
const paymentMethod = await getSponsoredFeePaymentMethod(wallet as any);
const sendOpts = (from) => ({ from, fee: { paymentMethod } });
```

Bring-your-own keys: pass your own `secret`, `salt`, `signingKey` (`Fr`, `Fr`, `Fq`) to
`createSchnorrInitializerlessAccount`. Never commit or log secrets. `{ ephemeral: true }` loses
private notes when the process exits; for anything that must keep private state (the supplier's
performance tally) use a persistent wallet configuration instead.

Gotchas: import from subpaths (`@aztec/aztec.js/addresses`, `/node`, `/fields`, `/keys`), not the
package root. Run scripts with `tsx` (jest breaks on these ESM packages). `.send()` already
waits for mining — there is no `.wait()`. Reads use
`const { result } = await c.methods.fn(args).simulate({ from })`.

## 3. Deploy / attach

Generated classes live in `src/artifacts/` (`RelnetAgreementContract`, `RelnetCoinContract`,
`RelnetEscrowContract`, `RelnetPerformanceProofContract`).

```ts
const { contract: token } = await RelnetCoinContract.deploy(wallet, admin).send(sendOpts(admin));
const { contract: pp }    = await RelnetPerformanceProofContract.deploy(wallet, admin).send(sendOpts(admin));
const { contract: escrow } = await RelnetEscrowContract.deploy(wallet, token.address, arbiter, pp.address).send(sendOpts(admin));
await pp.methods.set_escrow(escrow.address).send(sendOpts(admin)); // one-time wiring, admin only
const { contract: agreement } = await RelnetAgreementContract.deploy(
  wallet, buyer, supplier, /*price_cents*/ 500n, /*volume_min*/ 10n, /*volume_max*/ 100n,
).send(sendOpts(buyer));

// Attach to an already-deployed contract:
const c = await RelnetEscrowContract.at(addr, wallet);
// If it was deployed by another wallet, register its instance first:
// await wallet.registerContract(instance, RelnetEscrowContract.artifact)
```

Deploy order matters: token → performance_proof → escrow → `set_escrow`.

## 4. Roles and what each may call

| Role | Allowed |
|---|---|
| Buyer | `Agreement.place_call_off`, `Coin.transfer_public` (fund escrow), `Escrow.fund_call_off`, `Escrow.attest_received`, `Escrow.attest_inspected` |
| Supplier | `Agreement.place_call_off`, `Escrow.attest_shipped`, `PerformanceProof.absorb_outcome`, `PerformanceProof.prove_on_time_rate` |
| Carrier | `Escrow.attest_shipped`, `Escrow.attest_received` |
| Arbiter | `Escrow.arbiter_resolve` (only funds still in escrow) |
| Anyone | `Escrow.finalize_deemed_acceptance`, `Escrow.missed_ship_date_refund` (once time conditions hold); all `view` reads |
| Admin | `Coin.mint_publicly`, `PerformanceProof.set_escrow` (once) |

## 5. Function reference

Types: `AztecAddress`, `Field` call_off_id, `u128` amounts, `u64` counts/timestamps (unix secs).

**RelnetAgreement** — `place_call_off(qty u64, price_cents u64)` private; reverts unless caller is
buyer or supplier, `volume_min <= qty <= volume_max`, and `price_cents == agreed price`.
Views: `get_stage`, `get_call_off_count`, `get_buyer`, `get_supplier`.

**RelnetCoin** — `mint_publicly(to, amount)` admin; `transfer_public(to, amount)` moves the
*caller's own* balance (no `from`, no authwit); views `balance_of(owner)`, `get_total_supply`.

**RelnetEscrow** — per call-off, in this order:
1. Buyer: `coin.transfer_public(escrow.address, amount)`.
2. Buyer: `fund_call_off(call_off_id, supplier, carrier, amount, ship_by)`. Reverts if the escrow
   balance does not cover outstanding commitments or the id was used.
3. `attest_shipped(id)` by supplier **and** carrier → 30% to supplier; also records on-time status
   (`timestamp <= ship_by`) in PerformanceProof.
4. `attest_received(id)` by buyer **and** carrier → 50% to supplier; starts the 7-day clock.
5. Buyer `attest_inspected(id)` → remainder to supplier, closes. Or anyone
   `finalize_deemed_acceptance(id)` after 7 days. If never shipped by `ship_by`, anyone
   `missed_ship_date_refund(id)` → full refund to buyer.
Views: `get_remaining(id)`, `is_closed(id)`. Use a fresh `call_off_id` each time.

**RelnetPerformanceProof** (zero-knowledge part)
- After SHIPPED fires for call-off `id`, the supplier calls `absorb_outcome(id, on_time)`, where
  `on_time` must match the escrow's record (a mismatch reverts the whole tx). Each id once.
- `prove_on_time_rate(threshold_pct u64)`: private; succeeds only if
  `on_time_count*100 >= threshold_pct*total_count` and total > 0. Publishes only the threshold.
- View: `get_proven_threshold(supplier)` — the last threshold that supplier proved.
- The supplier's counts live in a private note owned by the supplier's account; only that
  wallet can prove from it.

## 6. Minimal end-to-end agent flow

```ts
await token.methods.mint_publicly(buyer, 10_000n).send(sendOpts(admin));
await token.methods.transfer_public(escrow.address, 1000n).send(sendOpts(buyer));
await escrow.methods.fund_call_off(1n, supplier, carrier, 1000n, 4102444800n).send(sendOpts(buyer));
await escrow.methods.attest_shipped(1n).send(sendOpts(supplier));
await escrow.methods.attest_shipped(1n).send(sendOpts(carrier));   // supplier +300
await escrow.methods.attest_received(1n).send(sendOpts(buyer));
await escrow.methods.attest_received(1n).send(sendOpts(carrier));  // supplier +500
await escrow.methods.attest_inspected(1n).send(sendOpts(buyer));   // supplier +200, closed
await pp.methods.absorb_outcome(1n, true).send(sendOpts(supplier));
await pp.methods.prove_on_time_rate(100n).send(sendOpts(supplier));
```

Handle failures by catching the thrown error from `.send()`: a revert means a rule was broken
(wrong caller, out of band, unfunded, too early). Do not retry blindly.

## 7. Known limits agents should respect

Funding is two non-atomic steps; milestone attestations are plain public calls by the named
parties; terms and escrow state are public; a supplier may choose not to absorb a late outcome;
`RelnetAuditLog` is a stub; only tested on the local sandbox. Details in `README.md`.

## 8. Files to read

`README.md` (design + limits), `contracts/*/src/main.nr` (source of truth),
`src/test/e2e/*.e2e.ts` (runnable examples), `src/utils/sponsored_fee.ts` (fee setup).

## 9. Getting funds

You cannot mint. Ask the human via the funding service (`npm run funding`, default
`http://127.0.0.1:8090`; simulated, no real money):

```ts
const r = await (await fetch(`${FUNDING_URL}/funding-requests`, {
  method: "POST",
  body: JSON.stringify({ address: myAddress.toString(), amountCents: "5000" }),
})).json();
// Send the user to r.url. Poll GET ${FUNDING_URL}/funding-requests/${r.id} until status is
// "approved" (tokens minted to your address) or "rejected". Do not retry on rejection.
```

Real bank linking and fiat-to-stablecoin conversion are not implemented; that needs a licensed
provider behind the `FundingProvider` interface (`src/funding/provider.ts`).
