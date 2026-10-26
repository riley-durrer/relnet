use aztec::macros::aztec;

/// RelnetCoin: a minimal public-balance settlement token for the relnet demo.
/// Not an audited token standard — a deliberately small, fully-public-state
/// token so RelnetEscrow (itself an AztecAddress) can hold and move balances
/// without the private-note ownership constraints that apply to per-user
/// private balances. See README "known limits".
#[aztec]
pub contract RelnetCoin {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        total_supply: PublicMutable<u128, Context>,
        balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        self.storage.admin.initialize(admin);
        self.storage.total_supply.write(0);
    }

    #[external("public")]
    fn mint_publicly(to: AztecAddress, amount: u128) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin can mint");
        let new_balance = self.storage.balances.at(to).read() + amount;
        self.storage.balances.at(to).write(new_balance);
        self.storage.total_supply.write(self.storage.total_supply.read() + amount);
    }

    /// Moves `amount` from the caller's own balance to `to`. Deliberately has
    /// no `from` parameter and needs no authwit: the only account that can
    /// ever move a given balance is the one that holds it (including a
    /// contract moving its own balance, which is how escrow releases work).
    #[external("public")]
    fn transfer_public(to: AztecAddress, amount: u128) {
        let from = self.msg_sender();
        let from_balance = self.storage.balances.at(from).read();
        assert(from_balance >= amount, "Insufficient balance");
        self.storage.balances.at(from).write(from_balance - amount);
        self.storage.balances.at(to).write(self.storage.balances.at(to).read() + amount);
    }

    #[external("public")]
    #[view]
    fn balance_of(owner: AztecAddress) -> pub u128 {
        self.storage.balances.at(owner).read()
    }

    #[external("public")]
    #[view]
    fn get_total_supply() -> pub u128 {
        self.storage.total_supply.read()
    }
}
