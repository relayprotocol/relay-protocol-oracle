### Overview

The Relay oracle is responsible for indexing any deposits and withdrawals to and from the Relay escrow contract. Deposits are initiated by users and represent transfers into the escrow contract (with an optional id attached). Withdrawals are initiated by the allocator and represent transfers out of the escrow (with a mandatory id attached). See (`relay-protocol-contracts`)[https://github.com/reservoirprotocol/relay-protocol-contracts] for the actual implementation of the Relay escrow contract across various VM types.

The indexing logic the oracle uses depends on the VM type of the chain being indexed, as follows:

#### Ethereum VM

Deposits are indexed in two different ways, depending on the currency that's being deposited:

- native tokens
  - the deposit is indexed based on the `NativeDeposit(address from, uint256 amount, bytes32 id)` event emitted on the escrow contract
- erc20 tokens
  - the deposit is indexed based on the standard erc20 `Transfer(address indexed from, address indexed to, uint256 amount)` event where the `to` address is the escrow contract
  - the optional deposit id can be specified in one of two ways:
    - via an `Erc20Deposit(address from, address token, uint256 amount, bytes32 id)` event emitted on the escrow contract right after the `Transfer` event (eg. `logIndex + 1`)
    - if the transaction emits a single `Transfer` event and the calldata matches one of the standard erc20 `transfer` and `transferFrom` methods, then the first 32 bytes after the end of the transfer methods calldata is assumed to be the id (this allows one to send erc20 tokens directly to the escrow contract without a prior approval for the escrow to transfer from the depositor)

To deposit native tokens:

- use the `depositNative(address depositor, bytes32 id)` method on the escrow contract

To deposit erc20 tokens:

- use the `depositErc20(address depositor, address token, uint256 amount, bytes32 id)` method on the escrow contract (requires an approval to the escrow)
- use the standard erc20 `transfer(address to, uint256 amount)` or `transferFrom(address from, address to, uint256 amount)` to transfer to the escrow (does not require an approval but only supports attaching an id if the transfer is NOT done via an internal call)

Withdrawals are indexed based on the `CallExecuted(bytes32 id, (address to, bytes data, uint256 value, bool allowFailure) call)` event emitted on the escrow contract. For future-proofing, the escrow contract allows any calls to be executed by the allocator, but the oracle only indexes specific calls:

- standard erc20 `transfer(address to, uint256 amount)` calls
- standard erc20 `transferFrom(address from, address to, uint256 amount)` calls
