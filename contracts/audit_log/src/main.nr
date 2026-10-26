use aztec::macros::aztec;

#[aztec]
pub contract RelnetAuditLog {
    use aztec::{macros::{functions::{external, initializer}, storage::storage}, state_vars::PublicMutable};

    #[storage]
    struct Storage<Context> {
        placeholder: PublicMutable<u64, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {
        self.storage.placeholder.write(0);
    }
}
