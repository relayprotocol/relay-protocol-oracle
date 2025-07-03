## Overview

The Relay oracle is responsible for attesting the following four core onchain actions:

- deposits into depository
- withdrawals from depository
- fills executed by solver
- refunds executed by solver

The attestation logic the oracle uses depends on the VM type of the chain being indexed, as follows:

- [ethereum-vm](./indexing/ethereum-vm.md)
- [solana-vm](./indexing/solana-vm.md)

### Deposits

These represent transfers into the depository contracts. They can have an optional id attached to them, pointing to an action to be executed on behalf of the depositor.

Use the `/attestations/depository-deposits/v1` API to attest deposits. This will return a list of signed [`DepositoryDepositMessage`](https://github.com/relayprotocol/relay-protocol-sdk/blob/main/src/messages/depository-deposit.ts) messages, containing information about all deposits extracted from a given onchain transaction.

### Withdrawals

These represent withdrawals from the depository contracts. They have a mandatory id attached to them, pointing to the withdrawal request signed by the allocator, which grants the transfer of funds out of the depository contract.

Use the `/attestations/depository-withdrawals/v1` API to attest withdrawals. This will return a single signed [`DepositoryWithdrawalMessage`](https://github.com/relayprotocol/relay-protocol-sdk/blob/main/src/messages/depository-withdrawal.ts) message, containing information about the status of the given withdrawal request (pending, executed, or expired).

### Solver fills

These represent actions which were successfully executed by the assigned solver.

Use the `/attestations/solver-fills/v1` API to attest solver fills. This will return a single signed [`SolverFillMessage`](https://github.com/relayprotocol/relay-protocol-sdk/blob/main/src/messages/solver-fill.ts) message, containing information about the status of the given order (successfully filled, or failed) together with metadata about the corresponding deposit (how much the depositor underpaid or overpaid, compared to the input amount(s) specified by the order).

### Solver refunds

These represent actions which the solver was unable to execute successfully and had to be refunded.

Use the `/attestations/solver-refunds/v1` API to attest solver refunds. This will return a single signed [`SolverRefundMessage`](https://github.com/relayprotocol/relay-protocol-sdk/blob/main/src/messages/solver-refund.ts) message, containing information about the status of the given order (successfully refunded, or failed) together with metadata about the corresponding deposit (how much the depositor underpaid or overpaid, compared to the input amount(s) specified by the order).
