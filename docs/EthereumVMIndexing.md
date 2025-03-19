## Ethereum VM indexing

<b>Deposits</b> are indexed in two different ways, depending on the currency that's being deposited:

- native tokens
  - the deposit is indexed based on the `NativeDeposit(address from, uint256 amount, bytes32 id)` event emitted on the escrow contract (eg. one event results in one deposit tracked by the oracle)
- erc20 tokens
  - the deposit is indexed based on the standard erc20 `Transfer(address indexed from, address indexed to, uint256 amount)` event where the `to` address is the escrow contract (eg. one event results in one deposit tracked by the oracle)
  - the optional deposit id can be specified in one of two ways:
    - via an `Erc20Deposit(address from, address token, uint256 amount, bytes32 id)` event emitted on the escrow contract right after the `Transfer` event (eg. `logIndex + 1`)
    - if the transaction emits a single `Transfer` event and the calldata matches one of the standard erc20 `transfer` and `transferFrom` methods, then the first 32 bytes after the end of the transfer methods calldata is assumed to be the id (this allows one to send erc20 tokens directly to the escrow contract without a prior approval for the escrow to transfer from the depositor)

<b>Withdrawals</b> are indexed based on the `CallExecuted(bytes32 id, (address to, bytes data, uint256 value, bool allowFailure) call)` event emitted on the escrow contract. For future-proofing, the escrow contract allows any calls to be executed by the allocator, but the oracle only indexes specific calls, which denote transfer of tokens out of the escrow

- any non-zero `value` calls
- standard erc20 `transfer(address to, uint256 amount)` calls
- standard erc20 `transferFrom(address from, address to, uint256 amount)` calls
