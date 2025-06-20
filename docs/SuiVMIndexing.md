## SUI Indexing

<b>Deposits</b> are indexed based on the `DepositEvent` emitted by the depository contract:

- All coin types (including native SUI and custom coins)
  - The deposit is tracked using the `DepositEvent` which includes the following parameters:
    - `coin_type`: Type of the deposited coin (retrieved via `type_name::get<T>()`)
    - `amount`: Amount deposited (from `coin::value`)
    - `from`: Address of the depositor (from `tx_context::sender`)
    - `deposit_id`: Unique identifier provided during the `deposit_coin` call
  - Each event emission corresponds to one deposit record indexed by the oracle

<b>Withdrawals</b> are indexed based on the `TransferExecutedEvent` emitted by the depository contract:

- Executed transfer requests via `execute_transfer` function
  - Withdrawals are tracked using `TransferExecutedEvent` containing:
    - `request_hash`: SHA2-256 hash of the BCS-serialized `TransferRequest`
    - `recipient`: Destination address for transferred funds
    - `amount`: Transferred amount
    - `coin_type`: Type of transferred coin (matches deposit type)
  - The oracle indexes withdrawals only for successfully executed requests with valid:
    1. Allocator signature verification via `ed25519_verify`
    2. Non-expired timestamp check
    3. Unique request hash (non-reuse enforcement)
