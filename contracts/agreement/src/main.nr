use aztec::macros::aztec;

/// RelnetAgreement: a framework agreement between one buyer and one supplier.
/// Terms (price, volume band, relationship stage) are public on-chain state —
/// Aztec notes are owner-centric and have no native "jointly owned by buyer
/// AND supplier" primitive, so bilateral terms live in public storage instead.
/// Call-offs are placed via a private entrypoint that enqueues a public
/// assertion: the proof is generated either way, but the transaction reverts
/// on-chain if the call-off is outside the agreed band. No agent-side prompt
/// or strategy can bypass this — it's a deterministic circuit assertion.
#[aztec]
pub contract RelnetAgreement {
    use aztec::{
        macros::{functions::{external, initializer, only_self, view}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{PublicImmutable, PublicMutable},
    };

    #[storage]
    struct Storage<Context> {
        buyer: PublicImmutable<AztecAddress, Context>,
        supplier: PublicImmutable<AztecAddress, Context>,
        price_cents: PublicMutable<u64, Context>,
        volume_min: PublicMutable<u64, Context>,
        volume_max: PublicMutable<u64, Context>,
        stage: PublicMutable<u8, Context>,
        call_off_count: PublicMutable<u64, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        buyer: AztecAddress,
        supplier: AztecAddress,
        price_cents: u64,
        volume_min: u64,
        volume_max: u64,
    ) {
        self.storage.buyer.initialize(buyer);
        self.storage.supplier.initialize(supplier);
        self.storage.price_cents.write(price_cents);
        self.storage.volume_min.write(volume_min);
        self.storage.volume_max.write(volume_max);
        self.storage.stage.write(0);
        self.storage.call_off_count.write(0);
    }

    /// An agent calls this privately to place a call-off. The actual band
    /// check happens in the enqueued public call below.
    #[external("private")]
    fn place_call_off(qty: u64, price_cents: u64) {
        let caller = self.msg_sender();
        self.enqueue_self._assert_call_off_in_band(caller, qty, price_cents);
    }

    #[external("public")]
    #[only_self]
    fn _assert_call_off_in_band(caller: AztecAddress, qty: u64, price_cents: u64) {
        let buyer = self.storage.buyer.read();
        let supplier = self.storage.supplier.read();
        assert(
            (caller == buyer) | (caller == supplier),
            "Only buyer or supplier may place a call-off",
        );

        let min = self.storage.volume_min.read();
        let max = self.storage.volume_max.read();
        assert((qty >= min) & (qty <= max), "Call-off quantity outside agreed band");

        let band_price = self.storage.price_cents.read();
        assert(price_cents == band_price, "Call-off price does not match agreement price");

        let count = self.storage.call_off_count.read();
        self.storage.call_off_count.write(count + 1);
    }

    #[external("public")]
    #[view]
    fn get_stage() -> pub u8 {
        self.storage.stage.read()
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
}
