use aztec::macros::aztec;

/// RelnetAgreement: a framework agreement between one buyer and one supplier.
///
/// Terms are a fixed vocabulary of typed rules (see `Terms`). A party's agent
/// may *propose* terms, but terms only become active when the buyer and the
/// supplier accounts each approve the same proposal. Agents (the optional
/// `*_agent` addresses) can propose, place call-offs and attest milestones;
/// they can never approve. Terms are public on-chain state: Aztec notes are
/// owner-centric and have no native "jointly owned by buyer AND supplier"
/// primitive.
///
/// Call-offs are placed through a private entrypoint that enqueues a public
/// assertion; if the call-off breaks the signed terms the whole transaction
/// reverts. Each call-off snapshots the terms in force when it was placed, so a
/// later amendment never rewrites a deal already in flight.
#[aztec]
pub contract RelnetAgreement {
    use aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    /// The rule vocabulary. Money is integer cents, rates are basis points
    /// (1 bp = 0.01%), durations are seconds.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Terms {
        pub price_cents: u64,
        pub volume_min: u64,
        pub volume_max: u64,
        /// Share of the call-off value released when shipment is attested.
        pub ship_bps: u64,
        /// Share released when receipt is attested. The rest is released at inspection.
        pub receive_bps: u64,
        /// Seconds from placing a call-off to its ship-by deadline.
        pub lead_time_secs: u64,
        /// Seconds after ship-by before any price reduction starts.
        pub grace_secs: u64,
        /// Length of one "late period" (86400 for a day).
        pub late_period_secs: u64,
        /// Price reduction per full late period, in basis points.
        pub late_bps_per_period: u64,
        /// Maximum total price reduction, in basis points.
        pub late_cap_bps: u64,
        /// Seconds after ship-by (plus grace) when the buyer may cancel unshipped goods.
        pub cancel_after_secs: u64,
        /// Seconds after receipt when silence counts as acceptance.
        pub deemed_acceptance_secs: u64,
    }

    /// Terms snapshot plus placement facts for one call-off.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct CallOffRec {
        pub qty: u64,
        pub price_cents: u64,
        pub placed_at: u64,
        pub ship_by: u64,
        pub ship_bps: u64,
        pub receive_bps: u64,
        pub grace_secs: u64,
        pub late_period_secs: u64,
        pub late_bps_per_period: u64,
        pub late_cap_bps: u64,
        pub cancel_after_secs: u64,
        pub deemed_acceptance_secs: u64,
    }

    #[storage]
    struct Storage<Context> {
        buyer: PublicImmutable<AztecAddress, Context>,
        supplier: PublicImmutable<AztecAddress, Context>,
        buyer_agent: PublicImmutable<AztecAddress, Context>,
        supplier_agent: PublicImmutable<AztecAddress, Context>,
        terms: PublicMutable<Terms, Context>,
        pending: PublicMutable<Terms, Context>,
        version: PublicMutable<u64, Context>,
        proposal_id: PublicMutable<u64, Context>,
        pending_open: PublicMutable<bool, Context>,
        buyer_approved: PublicMutable<bool, Context>,
        supplier_approved: PublicMutable<bool, Context>,
        call_offs: Map<Field, PublicMutable<CallOffRec, Context>, Context>,
        call_off_count: PublicMutable<u64, Context>,
    }

    /// The initial terms are a proposal, not active terms. Pass the zero
    /// address for an agent that does not exist.
    #[external("public")]
    #[initializer]
    fn constructor(
        buyer: AztecAddress,
        supplier: AztecAddress,
        buyer_agent: AztecAddress,
        supplier_agent: AztecAddress,
        initial: Terms,
    ) {
        self.storage.buyer.initialize(buyer);
        self.storage.supplier.initialize(supplier);
        self.storage.buyer_agent.initialize(buyer_agent);
        self.storage.supplier_agent.initialize(supplier_agent);
        self.internal.validate_terms(initial);
        self.storage.pending.write(initial);
        self.storage.pending_open.write(true);
        self.storage.proposal_id.write(1);
        self.storage.version.write(0);
        self.storage.call_off_count.write(0);
    }

    #[internal("public")]
    fn validate_terms(t: Terms) {
        assert(t.price_cents > 0, "Price must be positive");
        assert(t.volume_min > 0, "Minimum volume must be positive");
        assert(t.volume_min <= t.volume_max, "Volume band is inverted");
        assert(t.ship_bps + t.receive_bps <= 10000, "Milestone shares exceed 100%");
        assert(t.late_period_secs > 0, "Late period must be positive");
        assert(t.late_cap_bps <= 10000, "Late cap exceeds 100%");
        assert(t.cancel_after_secs > 0, "Cancel window must be positive");
        assert(t.deemed_acceptance_secs > 0, "Deemed-acceptance window must be positive");
    }

    #[internal("public")]
    fn buyer_side(who: AztecAddress) -> bool {
        let agent = self.storage.buyer_agent.read();
        (who == self.storage.buyer.read()) | ((!agent.is_zero()) & (who == agent))
    }

    #[internal("public")]
    fn supplier_side(who: AztecAddress) -> bool {
        let agent = self.storage.supplier_agent.read();
        (who == self.storage.supplier.read()) | ((!agent.is_zero()) & (who == agent))
    }

    /// Either party, or its agent, proposes new terms. This replaces any open
    /// proposal and clears both approvals.
    #[external("public")]
    fn propose_terms(terms: Terms) {
        let caller = self.msg_sender();
        assert(
            self.internal.buyer_side(caller) | self.internal.supplier_side(caller),
            "Only a party or its agent may propose terms",
        );
        self.internal.validate_terms(terms);
        self.storage.pending.write(terms);
        self.storage.pending_open.write(true);
        self.storage.proposal_id.write(self.storage.proposal_id.read() + 1);
        self.storage.buyer_approved.write(false);
        self.storage.supplier_approved.write(false);
    }

    /// Only the buyer or supplier account itself (the human sign-off) may
    /// approve, and only the proposal they reviewed: if an agent re-proposes
    /// in the meantime, the id no longer matches and this reverts.
    #[external("public")]
    fn approve_terms(proposal: u64) {
        let caller = self.msg_sender();
        assert(self.storage.pending_open.read(), "No open proposal");
        assert(proposal == self.storage.proposal_id.read(), "Proposal id is not the current proposal");
        if caller == self.storage.buyer.read() {
            self.storage.buyer_approved.write(true);
        } else {
            assert(caller == self.storage.supplier.read(), "Only the buyer or supplier may approve terms");
            self.storage.supplier_approved.write(true);
        }
        if self.storage.buyer_approved.read() & self.storage.supplier_approved.read() {
            self.storage.terms.write(self.storage.pending.read());
            self.storage.version.write(self.storage.version.read() + 1);
            self.storage.pending_open.write(false);
            self.storage.buyer_approved.write(false);
            self.storage.supplier_approved.write(false);
        }
    }

    /// Place a call-off under the signed terms. The id is chosen by the caller
    /// and must be unused. The band check happens in the enqueued public call.
    #[external("private")]
    fn place_call_off(call_off_id: Field, qty: u64, price_cents: u64) {
        let caller = self.msg_sender();
        self.enqueue_self._record_call_off(caller, call_off_id, qty, price_cents);
    }

    #[external("public")]
    #[only_self]
    fn _record_call_off(caller: AztecAddress, call_off_id: Field, qty: u64, price_cents: u64) {
        assert(
            self.internal.buyer_side(caller) | self.internal.supplier_side(caller),
            "Only buyer or supplier may place a call-off",
        );
        assert(self.storage.version.read() > 0, "Terms are not yet approved by both parties");
        let t = self.storage.terms.read();
        assert((qty >= t.volume_min) & (qty <= t.volume_max), "Call-off quantity outside agreed band");
        assert(price_cents == t.price_cents, "Call-off price does not match agreement price");
        assert(self.storage.call_offs.at(call_off_id).read().placed_at == 0, "Call-off id already used");

        let now = self.context.timestamp();
        self.storage.call_offs.at(call_off_id).write(CallOffRec {
            qty,
            price_cents,
            placed_at: now,
            ship_by: now + t.lead_time_secs,
            ship_bps: t.ship_bps,
            receive_bps: t.receive_bps,
            grace_secs: t.grace_secs,
            late_period_secs: t.late_period_secs,
            late_bps_per_period: t.late_bps_per_period,
            late_cap_bps: t.late_cap_bps,
            cancel_after_secs: t.cancel_after_secs,
            deemed_acceptance_secs: t.deemed_acceptance_secs,
        });
        self.storage.call_off_count.write(self.storage.call_off_count.read() + 1);
    }

    #[external("public")]
    #[view]
    fn get_terms() -> pub Terms {
        self.storage.terms.read()
    }

    #[external("public")]
    #[view]
    fn get_pending() -> pub Terms {
        self.storage.pending.read()
    }

    #[external("public")]
    #[view]
    fn get_version() -> pub u64 {
        self.storage.version.read()
    }

    #[external("public")]
    #[view]
    fn get_proposal_id() -> pub u64 {
        self.storage.proposal_id.read()
    }

    #[external("public")]
    #[view]
    fn get_buyer_approved() -> pub bool {
        self.storage.buyer_approved.read()
    }

    #[external("public")]
    #[view]
    fn get_supplier_approved() -> pub bool {
        self.storage.supplier_approved.read()
    }

    #[external("public")]
    #[view]
    fn get_call_off(call_off_id: Field) -> pub CallOffRec {
        self.storage.call_offs.at(call_off_id).read()
    }

    #[external("public")]
    #[view]
    fn get_call_off_count() -> pub u64 {
        self.storage.call_off_count.read()
    }

    #[external("public")]
    #[view]
    fn get_buyer() -> pub AztecAddress {
        self.storage.buyer.read()
    }

    #[external("public")]
    #[view]
    fn get_supplier() -> pub AztecAddress {
        self.storage.supplier.read()
    }

    #[external("public")]
    #[view]
    fn is_buyer_side(who: AztecAddress) -> pub bool {
        self.internal.buyer_side(who)
    }

    #[external("public")]
    #[view]
    fn is_supplier_side(who: AztecAddress) -> pub bool {
        self.internal.supplier_side(who)
    }
}
