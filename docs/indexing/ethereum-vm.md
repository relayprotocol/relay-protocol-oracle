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

### Solver refunds
