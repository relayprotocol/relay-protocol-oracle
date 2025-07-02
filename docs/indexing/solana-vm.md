## `solana-vm` indexing

### Deposits

Deposits are indexed based on the `DepositEvent` event emitted by the depository program, emitted after a successful `deposit_native` or `deposit_token` instruction execution. One event results in one deposit tracked by the oracle.

### Withdrawals

The status of withdrawals is determined by checking the state of the corresponding `used_request` account, which will return a positive response if the withdrawal was executed, and negative response otherwise. In case of a negative response, the oracle will compare the timestamp of the chain to the expiration of the withdrawal request to decide whether it's still possible to be executed (pending) or not (expired).

### Solver fills

To determine whether an order was successfully filled, the oracle will compare the amount(s) received by the order's recipient to the output amount(s) initially agreed in the order. In case the corresponding order initiation deposit paid the solver either more, or less, than the amount specified by the order, the oracle will adjust the output amount(s) required by the order. The logic to determine the amount received by the order's recipient is based on the `preBalances` / `postBalances` and `preTokenBalances` / `postTokenBalances` fields returned by the standard [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction) RPC method.

The oracle also ensures the fill transaction includes a memo instruction referencing the order id. This is needed to ensure the solver is not able to reuse previous fill transactions for a new similar order.

### Solver refunds

The logic to determine payment of refunds is exactly the same as the logic described above to handle payments for successful fills.
