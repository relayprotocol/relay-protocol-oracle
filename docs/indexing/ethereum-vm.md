## `ethereum-vm` indexing

### Deposits

Deposits are indexed in two different ways, depending on the currency that's being deposited:

- native tokens
  - the deposit is indexed based on the `RelayNativeDeposit(address from, uint256 amount, bytes32 id)` event emitted on the depository contract
  - one event results in one deposit tracked by the oracle
- erc20 tokens
  - the deposit is indexed based on the standard erc20 `Transfer(address indexed from, address indexed to, uint256 amount)` event where the `to` address is the depository contract
  - one event results in one deposit tracked by the oracle
  - the optional deposit id can be specified in one of two ways:
    - via a matching `RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)` event emitted on the depository contract right after the `Transfer` event (eg. `logIndex + 1`)
    - if the transaction emits a single `Transfer` event and the calldata matches one of the standard erc20 `transfer` and `transferFrom` methods, then the first 32 bytes after the end of the transfer methods calldata is assumed to be the id (this allows one to send erc20 tokens directly to the depository contract without a prior approval for the depository to transfer from the depositor)

### Withdrawals

The status of withdrawals is determined by a call to the `function callRequests(bytes32 withdrawalId) view returns (bool)` function, which will return a positive response if the withdrawal was executed, and negative response otherwise. In case of a negative response, the oracle will compare the timestamp of the chain to the expiration of the withdrawal request to decide whether it's still possible to be executed (pending) or not (expired).

### Solver fills

To determine whether an order was successfully filled, the oracle will compare the amount(s) received by the order's recipient to the output amount(s) initially agreed in the order. In case the corresponding order initiation deposit paid the solver either more, or less, than the amount specified by the order, the oracle will adjust the output amount(s) required by the order. The logic to determine the amount received by the order's recipient depends on the output currency:

- native tokens
  - if the fill transaction is a simple transfer to the recipient, then the amount is determined based on the transaction's `value`
  - otherwise, the amount is determined from `SolverNativeTransfer(address to, uint256 amount)` events where to `to` address is the order's recipient, emitted on the fill contract specified by the order's output `extraData` field
- erc20 tokens
  - the amount is determined based on the standard erc20 `Transfer(address indexed from, address indexed to, uint256 amount)` where the `to` address is the order's recipient

If the order's output specifies any calls to be executed, the oracle will verify those based on the `SolverCallExecuted(address to, bytes data, uint256 amount)` event emitted on the fill contract specified by the order's output `extraData` field.

The oracle also ensures the fill transaction's `data` last 32 bytes reference the corresponding order id. This is needed to ensure the solver is not able to reuse previous fill transactions for a new similar order.

### Solver refunds

The logic to determine payment of refunds is exactly the same as the logic described above to handle payments for successful fills.
