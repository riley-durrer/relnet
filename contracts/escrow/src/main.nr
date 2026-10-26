use aztec::macros::aztec;

/// RelnetEscrow: holds per-call-off escrow balances (in RelnetCoin) and
/// releases them on milestone attestations. SHIPPED needs both supplier and
/// carrier to attest, RECEIVED needs both buyer and carrier, INSPECTED needs
/// only the buyer. Deemed acceptance and the missed-ship refund are
/// permissionless public functions — anyone (typically the supplier or
/// buyer themselves) can call them once the time condition holds, since
/// there is no team-operated keeper/cron here. Only public functions can see
/// real time (`self.context.timestamp()`), which is why this whole contract
/// is public-state rather than private notes.
#[aztec]
pub contract RelnetEscrow {
    use aztec::{
        macros::{functions::{external, initializer, internal, view}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use relnet_coin::RelnetCoin;
    use relnet_performance_proof::RelnetPerformanceProof;

    global SEVEN_DAYS_SECS: u64 = 604800;

    #[storage]
    struct Storage<Context> {
        token: PublicImmutable<AztecAddress, Context>,
        arbiter: PublicImmutable<AztecAddress, Context>,
        performance_proof: PublicImmutable<AztecAddress, Context>,
        total_committed: PublicMutable<u128, Context>,
        call_off_buyer: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        call_off_supplier: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        call_off_carrier: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        call_off_total: Map<Field, PublicMutable<u128, Context>, Context>,
        call_off_remaining: Map<Field, PublicMutable<u128, Context>, Context>,
        call_off_ship_by: Map<Field, PublicMutable<u64, Context>, Context>,
        call_off_shipped_supplier: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_shipped_carrier: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_shipped_released: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_received_buyer: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_received_carrier: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_received_released: Map<Field, PublicMutable<bool, Context>, Context>,
        call_off_received_at: Map<Field, PublicMutable<u64, Context>, Context>,
        call_off_closed: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token: AztecAddress, arbiter: AztecAddress, performance_proof: AztecAddress) {
        self.storage.token.initialize(token);
        self.storage.arbiter.initialize(arbiter);
        self.storage.performance_proof.initialize(performance_proof);
        self.storage.total_committed.write(0);
    }

    /// The buyer must have already transferred `amount` of RelnetCoin to this
    /// contract's own address (via `RelnetCoin.transfer_public`) before
    /// calling this. That ordering isn't enforced atomically in this version
    /// — see README known limits.
    #[external("public")]
    fn fund_call_off(
        call_off_id: Field,
        supplier: AztecAddress,
        carrier: AztecAddress,
        amount: u128,
        ship_by: u64,
    ) {
        let buyer = self.msg_sender();
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off id already used");
        assert(self.storage.call_off_total.at(call_off_id).read() == 0, "Call-off id already funded");
        assert(amount > 0, "Amount must be positive");

        let token = self.storage.token.read();
        let committed = self.storage.total_committed.read();
        let escrow_balance = self.view(RelnetCoin::at(token).balance_of(self.address));
        assert(
            escrow_balance >= committed + amount,
            "Escrow under-funded: transfer tokens to this contract first",
        );

        self.storage.call_off_buyer.at(call_off_id).write(buyer);
        self.storage.call_off_supplier.at(call_off_id).write(supplier);
        self.storage.call_off_carrier.at(call_off_id).write(carrier);
        self.storage.call_off_total.at(call_off_id).write(amount);
        self.storage.call_off_remaining.at(call_off_id).write(amount);
        self.storage.call_off_ship_by.at(call_off_id).write(ship_by);
        self.storage.total_committed.write(committed + amount);
    }

    #[external("public")]
    fn attest_shipped(call_off_id: Field) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        let caller = self.msg_sender();
        let supplier = self.storage.call_off_supplier.at(call_off_id).read();
        let carrier = self.storage.call_off_carrier.at(call_off_id).read();
        assert((caller == supplier) | (caller == carrier), "Only supplier or carrier may attest shipment");

        if caller == supplier {
            self.storage.call_off_shipped_supplier.at(call_off_id).write(true);
        }
        if caller == carrier {
            self.storage.call_off_shipped_carrier.at(call_off_id).write(true);
        }

        let both_attested = self.storage.call_off_shipped_supplier.at(call_off_id).read()
            & self.storage.call_off_shipped_carrier.at(call_off_id).read();
        let already_released = self.storage.call_off_shipped_released.at(call_off_id).read();
        if both_attested & (!already_released) {
            self.storage.call_off_shipped_released.at(call_off_id).write(true);
            let total = self.storage.call_off_total.at(call_off_id).read();
            self.internal.release_milestone(call_off_id, supplier, (total * 30) / 100);

            let ship_by = self.storage.call_off_ship_by.at(call_off_id).read();
            let on_time = self.context.timestamp() <= ship_by;
            let performance_proof = self.storage.performance_proof.read();
            self.call(RelnetPerformanceProof::at(performance_proof).record_outcome(call_off_id, on_time));
        }
    }

    #[external("public")]
    fn attest_received(call_off_id: Field) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        let caller = self.msg_sender();
        let buyer = self.storage.call_off_buyer.at(call_off_id).read();
        let carrier = self.storage.call_off_carrier.at(call_off_id).read();
        assert((caller == buyer) | (caller == carrier), "Only buyer or carrier may attest receipt");

        if caller == buyer {
            self.storage.call_off_received_buyer.at(call_off_id).write(true);
        }
        if caller == carrier {
            self.storage.call_off_received_carrier.at(call_off_id).write(true);
        }

        let both_attested = self.storage.call_off_received_buyer.at(call_off_id).read()
            & self.storage.call_off_received_carrier.at(call_off_id).read();
        let already_released = self.storage.call_off_received_released.at(call_off_id).read();
        if both_attested & (!already_released) {
            self.storage.call_off_received_released.at(call_off_id).write(true);
            self.storage.call_off_received_at.at(call_off_id).write(self.context.timestamp());
            let supplier = self.storage.call_off_supplier.at(call_off_id).read();
            let total = self.storage.call_off_total.at(call_off_id).read();
            self.internal.release_milestone(call_off_id, supplier, (total * 50) / 100);
        }
    }

    /// Buyer confirms the goods are acceptable: releases whatever remains
    /// (not a fixed 20%, so earlier rounding never leaves dust behind) and
    /// closes the call-off.
    #[external("public")]
    fn attest_inspected(call_off_id: Field) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        let caller = self.msg_sender();
        let buyer = self.storage.call_off_buyer.at(call_off_id).read();
        assert(caller == buyer, "Only the buyer may attest inspection");
        assert(
            self.storage.call_off_received_released.at(call_off_id).read(),
            "Cannot inspect before receipt is attested",
        );

        let supplier = self.storage.call_off_supplier.at(call_off_id).read();
        let remaining = self.storage.call_off_remaining.at(call_off_id).read();
        self.internal.release_milestone(call_off_id, supplier, remaining);
        self.storage.call_off_closed.at(call_off_id).write(true);
    }

    /// Permissionless: anyone can call this once 7 days have passed since
    /// RECEIVED with no inspection. No team-operated keeper is required.
    #[external("public")]
    fn finalize_deemed_acceptance(call_off_id: Field) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        assert(
            self.storage.call_off_received_released.at(call_off_id).read(),
            "Receipt has not been attested yet",
        );
        let received_at = self.storage.call_off_received_at.at(call_off_id).read();
        assert(
            self.context.timestamp() >= received_at + SEVEN_DAYS_SECS,
            "Deemed-acceptance window has not elapsed",
        );

        let supplier = self.storage.call_off_supplier.at(call_off_id).read();
        let remaining = self.storage.call_off_remaining.at(call_off_id).read();
        self.internal.release_milestone(call_off_id, supplier, remaining);
        self.storage.call_off_closed.at(call_off_id).write(true);
    }

    /// Permissionless: anyone can call this once the ship-by deadline has
    /// passed with no shipment attested. Refunds the full remaining balance
    /// to the buyer.
    #[external("public")]
    fn missed_ship_date_refund(call_off_id: Field) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        assert(
            !self.storage.call_off_shipped_released.at(call_off_id).read(),
            "Shipment was already attested",
        );
        let ship_by = self.storage.call_off_ship_by.at(call_off_id).read();
        assert(self.context.timestamp() > ship_by, "Ship-by deadline has not passed yet");

        let buyer = self.storage.call_off_buyer.at(call_off_id).read();
        let remaining = self.storage.call_off_remaining.at(call_off_id).read();
        self.internal.release_milestone(call_off_id, buyer, remaining);
        self.storage.call_off_closed.at(call_off_id).write(true);
    }

    /// The arbiter can only ever move funds still sitting in escrow for this
    /// call-off — it has no authority over anything already released.
    #[external("public")]
    fn arbiter_resolve(call_off_id: Field, recipient: AztecAddress, amount: u128) {
        assert(!self.storage.call_off_closed.at(call_off_id).read(), "Call-off already closed");
        assert(self.msg_sender() == self.storage.arbiter.read(), "Only the arbiter may resolve a dispute");
        self.internal.release_milestone(call_off_id, recipient, amount);
        if self.storage.call_off_remaining.at(call_off_id).read() == 0 {
            self.storage.call_off_closed.at(call_off_id).write(true);
        }
    }

    #[internal("public")]
    fn release_milestone(call_off_id: Field, recipient: AztecAddress, amount: u128) {
        let remaining = self.storage.call_off_remaining.at(call_off_id).read();
        assert(remaining >= amount, "Release exceeds remaining escrow");
        self.storage.call_off_remaining.at(call_off_id).write(remaining - amount);
        // total_committed tracks *outstanding* liability, not cumulative
        // historical commitments, so it must shrink as funds are released —
        // otherwise fund_call_off's under-funding check compares the live
        // escrow balance against an ever-growing number and rejects funding
        // for call-offs that are well within the actual balance.
        self.storage.total_committed.write(self.storage.total_committed.read() - amount);
        let token = self.storage.token.read();
        self.call(RelnetCoin::at(token).transfer_public(recipient, amount));
    }

    #[external("public")]
    #[view]
    fn get_remaining(call_off_id: Field) -> pub u128 {
        self.storage.call_off_remaining.at(call_off_id).read()
    }

    #[external("public")]
    #[view]
    fn is_closed(call_off_id: Field) -> pub bool {
        self.storage.call_off_closed.at(call_off_id).read()
    }
}
