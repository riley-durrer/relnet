use aztec::macros::aztec;

/// RelnetPerformanceProof: lets a supplier prove their on-time delivery rate
/// is at or above a threshold without revealing individual call-off dates,
/// quantities, or the exact underlying counts. This is the headline "pure"
/// ZK feature — the only place in relnet where private notes genuinely fit
/// Aztec's single-owner model (a supplier proving a fact about themselves,
/// not a jointly-governed bilateral fact).
///
/// Mechanics: RelnetEscrow commits a public, delayed fact ("was this
/// call-off shipped on time?") when its SHIPPED milestone fires. The
/// supplier later absorbs that fact into a single private note that holds
/// only a running (on_time_count, total_count) pair — nullified and
/// recreated on every absorption, so proving never has to read more than
/// one note regardless of how many call-offs a supplier has fulfilled.
#[aztec]
pub contract RelnetPerformanceProof {
    use aztec::{
        macros::{functions::{external, initializer, only_self, view}, notes::note, storage::storage},
        messages::delivery::MessageDelivery,
        note::note_getter_options::NoteGetterOptions,
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
    };

    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct TallyNote {
        pub on_time_count: u64,
        pub total_count: u64,
    }

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        escrow: PublicMutable<AztecAddress, Context>,
        outcome: Map<Field, PublicMutable<bool, Context>, Context>,
        outcome_set: Map<Field, PublicMutable<bool, Context>, Context>,
        absorbed: Map<Field, PublicMutable<bool, Context>, Context>,
        tallies: Owned<PrivateSet<TallyNote, Context>, Context>,
        proven_threshold_pct: Map<AztecAddress, PublicMutable<u64, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        self.storage.admin.initialize(admin);
    }

    /// One-time wiring after both contracts are deployed: performance_proof
    /// needs escrow's address to restrict `record_outcome`, and escrow needs
    /// performance_proof's address for its own constructor — deploying both
    /// at once isn't possible, so this closes the loop as a second step.
    #[external("public")]
    fn set_escrow(escrow: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin may set the escrow address");
        assert(self.storage.escrow.read().is_zero(), "Escrow address already set");
        self.storage.escrow.write(escrow);
    }

    /// Called by RelnetEscrow when a call-off's SHIPPED milestone fires.
    #[external("public")]
    fn record_outcome(call_off_id: Field, on_time: bool) {
        assert(self.msg_sender() == self.storage.escrow.read(), "Only the registered escrow may record outcomes");
        self.storage.outcome.at(call_off_id).write(on_time);
        self.storage.outcome_set.at(call_off_id).write(true);
    }

    /// Supplier absorbs a recorded outcome into their private running tally.
    /// `on_time` is read as a historical fact the escrow already committed
    /// in an earlier transaction — the caller cannot set it themselves.
    ///
    /// The tally is a single note per supplier: every call pops *all*
    /// existing notes (there is ever only one, by this same invariant),
    /// sums them, and inserts one new note with the updated running totals.
    /// This keeps proving O(1) regardless of how many call-offs a supplier
    /// has fulfilled, instead of scanning their full order history.
    #[external("private")]
    fn absorb_outcome(call_off_id: Field, on_time: bool) {
        let supplier = self.msg_sender();
        self.enqueue_self._mark_absorbed(call_off_id, on_time);

        let set = self.storage.tallies.at(supplier);
        let existing = set.pop_notes(NoteGetterOptions::new());
        let mut prev_on_time: u64 = 0;
        let mut prev_total: u64 = 0;
        for i in 0..existing.max_len() {
            if i < existing.len() {
                let note = existing.get(i);
                prev_on_time += note.on_time_count;
                prev_total += note.total_count;
            }
        }

        let new_note = TallyNote {
            on_time_count: prev_on_time + (on_time as u64),
            total_count: prev_total + 1,
        };
        set.insert(new_note).deliver(MessageDelivery::onchain_unconstrained());
    }

    #[external("public")]
    #[only_self]
    fn _mark_absorbed(call_off_id: Field, on_time: bool) {
        assert(self.storage.outcome_set.at(call_off_id).read(), "No outcome recorded for this call-off");
        assert(self.storage.outcome.at(call_off_id).read() == on_time, "Claimed outcome does not match escrow record");
        assert(!self.storage.absorbed.at(call_off_id).read(), "Outcome already absorbed");
        self.storage.absorbed.at(call_off_id).write(true);
    }

    /// Proves the caller's on-time rate is at least `threshold_pct` without
    /// revealing the underlying counts or any individual call-off. Only a
    /// pass/fail (by virtue of this not reverting) and the threshold tested
    /// are ever recorded publicly.
    #[external("private")]
    fn prove_on_time_rate(threshold_pct: u64) {
        let supplier = self.msg_sender();

        let set = self.storage.tallies.at(supplier);
        let existing = set.pop_notes(NoteGetterOptions::new());
        let mut on_time_count: u64 = 0;
        let mut total_count: u64 = 0;
        for i in 0..existing.max_len() {
            if i < existing.len() {
                let note = existing.get(i);
                on_time_count += note.on_time_count;
                total_count += note.total_count;
            }
        }

        assert(total_count > 0, "No delivery history to prove performance over");
        assert(
            on_time_count * 100 >= threshold_pct * total_count,
            "On-time rate is below the claimed threshold",
        );

        // Proving reads the tally — it shouldn't erase it, so the same
        // values are reinserted as a fresh note.
        let restored = TallyNote { on_time_count, total_count };
        set.insert(restored).deliver(MessageDelivery::onchain_unconstrained());

        self.enqueue_self._publish_proof(supplier, threshold_pct);
    }

    #[external("public")]
    #[only_self]
    fn _publish_proof(supplier: AztecAddress, threshold_pct: u64) {
        self.storage.proven_threshold_pct.at(supplier).write(threshold_pct);
    }

    #[external("public")]
    #[view]
    fn get_proven_threshold(supplier: AztecAddress) -> pub u64 {
        self.storage.proven_threshold_pct.at(supplier).read()
    }
}
