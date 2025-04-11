## Overview

The Relay oracle is responsible for indexing any deposits and withdrawals to and from the Relay escrow contract. Deposits are initiated by users and represent transfers into the escrow contract. These can have an optional id attached to them, denoting the id of an intent/action to be executed on behalf of the user. Withdrawals are initiated by the allocator and represent transfers out of the escrow. These all have an id linking to the withdrawal request signed by the allocator and granting the transfer out of the escrow.

See [`relay-protocol-contracts`](https://github.com/reservoirprotocol/relay-protocol-contracts) for the actual implementation of the Relay escrow contract across various VM types.

The indexing logic the oracle uses depends on the VM type of the chain being indexed, as follows:

- [Ethereum VM](./EthereumVMIndexing.md)
- [Solana VM](./SolanaVMIndexing.md)
- [Sui VM](./SuiVMIndexing.md)
- [Ton VM](./TonVMIndexing.md)
