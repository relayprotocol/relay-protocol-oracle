## `solana-vm` indexing

### Deposits

Deposits are indexed based on the `DepositEvent` event emitted by the depository program, emitted after a successful `deposit_native` or `deposit_token` instruction execution. One event results in one deposit tracked by the oracle.

### Withdrawals

The status of withdrawals is determined by checking the state of the corresponding `used_request` account, which will return a positive response if the withdrawal was executed, and negative response otherwise. In case of a negative response, the oracle will compare the timestamp of the chain to the expiration of the withdrawal request to decide whether it's still possible to be executed (pending) or not (expired).

### Solver fills

### Solver refunds
