## Solana VM Indexing

**Deposits** are indexed based on the `DepositEvent` emitted by the escrow program, which comes in two variants depending on the currency being deposited:

- native SOL
  - the deposit is indexed based on the `DepositEvent` emitted after a successful `DepositSol` instruction execution
  - the event contains: `{depositor: PublicKey, token: null, amount: u64, id: [u8; 32]}`
  - one event results in one deposit tracked by the oracle
- SPL tokens
  - the deposit is indexed based on the `DepositEvent` emitted after a successful `DepositToken` instruction execution
  - the event contains: `{depositor: PublicKey, token: PublicKey, amount: u64, id: [u8; 32]}`
  - requires prior approval for the escrow program to transfer tokens from the depositor's token account
  - one event results in one deposit tracked by the oracle

**Withdrawals** are indexed based on the `TransferExecutedEvent` emitted by the escrow program after successful execution of the `ExecuteTransfer` instruction. The event contains a transfer request structure and additional metadata:

```rust
{
    request: {
        recipient: PublicKey,
        token: Option<PublicKey>,  // null for native SOL
        amount: u64,
        nonce: u64,
        expiration: i64
    },
    executor: PublicKey,
    id: PublicKey
}
```