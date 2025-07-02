## TON VM indexing

<b>Deposits</b> are indexed based on emitted log events:

- <b>Native TON deposits</b>
  - Indexed via `event::deposit` (0x88879a49) with:
    - Asset type = 0 (CURRENCY_TON)
    - Wallet address (contract's own address)
    - Amount in nanoTON
    - Depositor address
    - Deposit ID (64-bit unsigned integer)

- <b>Jetton deposits</b>
  - Indexed via `event::deposit` (0x88879a49) with:
    - Asset type = 1 (CURRENCY_JETTON)
    - Jetton wallet address
    - Amount in jetton units
    - Depositor address
    - Deposit ID (64-bit unsigned integer from notification payload)

<b>Withdrawals</b> are indexed based on transfer events:

- <b>All withdrawals</b>
  - Indexed via `event::transfer` (0x5c87ae7e) containing:
    - Currency address (TON=zero-address/Jetton master address)
    - Amount transferred
    - Transaction hash (256-bit msg_hash)
  
  Withdrawal types detected through message patterns:
  - <b>Native TON transfers</b>
    - Detected when currency type = 0 (CURRENCY_TON)
    - Verified through `send_tons()` internal call
  
  - <b>Jetton transfers</b>
    - Detected when currency type = 1 (CURRENCY_JETTON)
    - Verified through `send_jetton()` internal call
    - Includes forward amount for wallet deployment

<b>Signature verification</b> requirements:
- All transfers must include valid allocator signature
- Transactions must pass nonce/expiry checks
- msg_hash from transfer event matches signed message

<b>Special cases</b>:
- Batch transfers processed sequentially (nonce increments per transfer)
- Expired transactions (beyond 32-bit expiry timestamp) are rejected
- Empty transfer batches throw error::empty_actions (0x6b)